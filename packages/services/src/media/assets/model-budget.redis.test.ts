import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTxRunner, detach, KernelViolation, uuidv7 } from "../../kernel/index.js";
import { createClock, useTestDatabase, useTestRedis } from "../../testing/index.js";
import { createModelBudgetLedger } from "../index.js";
import type { ModelBudgetContext, ModelBudgetTransport } from "../index.js";

const redis = useTestRedis(),
  database = useTestDatabase("services");
const SLOW = { timeout: 120000 };
const DAY = 86400000,
  OFFSET = 28800000;
const dayOf = (n: number) => Math.floor((n + OFFSET) / DAY);
const signal = () => new AbortController().signal;
let first: Awaited<ReturnType<typeof redis.raw>>, second: typeof first;
beforeAll(async () => {
  first = await redis.raw();
  second = await redis.raw();
}, 60000);
beforeEach(() => redis.flush(), 60000);

async function setup(options: { seed?: boolean; maxFields?: number } = {}) {
  const prefix = `${redis.prefix}ledger:`,
    key = `${prefix}model_budget:v1`;
  const clock = createClock(new Date());
  const entityId = uuidv7(),
    storeId = uuidv7(),
    fileId = uuidv7();
  const transport = (client: typeof first) =>
    vi.fn<ModelBudgetTransport["eval"]>(async (script, keys, argv) =>
      client.eval(script, keys.length, ...keys, ...argv),
    );
  const evaluate = transport(first),
    otherEvaluate = transport(second);
  const build = (evalCall = evaluate) =>
    createModelBudgetLedger({ clock, prefix, transport: { eval: evalCall }, ...options });
  const ledger = build(),
    other = build(otherEvaluate);
  const now = clock.now().getTime();
  if (options.seed !== false)
    await first.hset(key, {
      marker: "model_budget_v1",
      business: String(now - 1),
      redis: String(now - 1),
      day: String(dayOf(now)),
      closed: "0",
      head: "1",
      next: "1",
      cursor: "1",
    });
  const permit = (change: Partial<ModelBudgetContext> = {}): ModelBudgetContext => {
    clock.set(new Date());
    const at = clock.now().getTime();
    return {
      entityId,
      storeId,
      jobId: uuidv7(),
      fileIds: [fileId],
      kind: "asr",
      attemptNo: 1,
      expectedSourceHash: "a".repeat(64),
      dailyFileCap: 200,
      dailyCallCap: 10000,
      readAtMs: at,
      admitUntilMs: at + 250,
      leaseUntilMs: at + 120000,
      originalDeadlineMs: at + 1800000,
      ...change,
    };
  };
  const snapshot = () => first.hgetall(key);
  const token = (p: ModelBudgetContext) => `t:${p.jobId}:${p.attemptNo}:${p.kind}`;
  const refresh = () => clock.set(new Date());
  return {
    key,
    clock,
    entityId,
    storeId,
    fileId,
    ledger,
    other,
    evaluate,
    otherEvaluate,
    build,
    permit,
    snapshot,
    token,
    refresh,
  };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
type Entry = { kind: "t" | "g" | "s" | "f"; stamp: number; target: string; value: string };
// 显式合法历史账本夹具；没有生产初始化接口，不把seed称为已开通业务。
async function indexed(h: Fixture, entries: readonly Entry[], cursor = 1) {
  const data: Record<string, string> = {
    head: "1",
    next: String(entries.length + 1),
    cursor: String(cursor),
  };
  for (const [n, e] of entries.entries()) {
    const expiry = e.kind === "t" ? e.stamp + 5000 : (e.stamp + 2) * DAY - OFFSET;
    data[e.target] = e.value;
    data[`q:${n + 1}`] = JSON.stringify([e.kind, String(e.stamp), String(expiry), e.target]);
  }
  await first.hset(h.key, data);
}
function expired(h: Fixture, n = 1): Entry[] {
  const stamp = h.clock.now().getTime() - 6000;
  return Array.from({ length: n }, () => ({
    kind: "t",
    stamp,
    target: `t:${uuidv7()}:1:asr`,
    value: String(stamp),
  }));
}

describe("独立小Redis预算与原期限", () => {
  it("缺HASH或marker明确关闭，不自动建账", SLOW, async () => {
    const h = await setup({ seed: false });
    expect(await h.ledger.reserve(h.permit(), signal())).toEqual({
      status: "denied",
      reason: "unavailable",
    });
    expect(await first.exists(h.key)).toBe(0);
    await first.hset(h.key, "unrelated", "preserved");
    const before = await h.snapshot();
    h.refresh();
    expect((await h.ledger.maintain(signal())).status).toBe("denied");
    expect(await h.snapshot()).toEqual(before);
  });

  it("一个完整预留同时写计数、文件、token和全部到期索引", SLOW, async () => {
    const h = await setup(),
      p = h.permit();
    expect(await h.ledger.reserve(p, signal())).toEqual({
      status: "reserved",
      units: 1,
      newFiles: 1,
    });
    const all = await h.snapshot(),
      day = dayOf(p.readAtMs);
    expect(all[`g:${day}`]).toBe("1");
    expect(all[`s:${day}:${p.storeId}`]).toBe("1");
    expect(all[`f:${day}:${p.storeId}:${p.fileIds[0]}`]).toBe("1");
    expect(all[h.token(p)]).toBe(String(p.originalDeadlineMs));
    expect(all["next"]).toBe("5");
    expect(await first.hlen(h.key)).toBe(16);
    const indexes = Object.entries(all)
      .filter(([k]) => k.startsWith("q:"))
      .map(([, v]) => JSON.parse(v) as string[]);
    expect(indexes).toHaveLength(4);
    expect(indexes.find((row) => row[0] === "t")).toEqual([
      "t",
      String(p.originalDeadlineMs),
      String(p.originalDeadlineMs + 5000),
      h.token(p),
    ]);
    expect(h.evaluate).toHaveBeenCalledTimes(1);
  });

  it.each(["global", "store"])(
    "两个独立客户端争最后%s额度只有一个赢家",
    SLOW,
    async (dimension) => {
      const h = await setup();
      const limit = dimension === "global" ? { dailyCallCap: 1 } : { dailyFileCap: 1 };
      const a = h.permit(limit),
        b = h.permit({ ...limit, fileIds: [uuidv7()] });
      const results = await Promise.all([
        h.ledger.reserve(a, signal()),
        h.other.reserve(b, signal()),
      ]);
      expect(results.filter((r) => r.status === "reserved")).toHaveLength(1);
      expect(results.filter((r) => r.status === "denied")).toEqual([
        { status: "denied", reason: dimension === "global" ? "quota_global" : "quota_store" },
      ]);
      const all = await h.snapshot(),
        d = dayOf(a.readAtMs);
      expect(all[`g:${d}`]).toBe("1");
      expect(all[`s:${d}:${a.storeId}`]).toBe("1");
      expect(Object.keys(all).filter((k) => k.startsWith("t:"))).toHaveLength(1);
      expect(Object.keys(all).filter((k) => k.startsWith("f:"))).toHaveLength(1);
      expect(h.evaluate).toHaveBeenCalledTimes(1);
      expect(h.otherEvaluate).toHaveBeenCalledTimes(1);
    },
  );

  it("ASR1与vision3固定槽，同店同file跨kind只计一次文件", SLOW, async () => {
    const h = await setup(),
      a = h.permit({ dailyFileCap: 1 });
    expect(await h.ledger.reserve(a, signal())).toEqual({
      status: "reserved",
      units: 1,
      newFiles: 1,
    });
    const v = h.permit({
      kind: "vision",
      dailyFileCap: 1,
      originalDeadlineMs: h.clock.now().getTime() + 60000,
    });
    expect(await h.ledger.reserve(v, signal())).toEqual({
      status: "reserved",
      units: 3,
      newFiles: 0,
    });
    const all = await h.snapshot(),
      d = dayOf(v.readAtMs);
    expect(all[`g:${d}`]).toBe("4");
    expect(all[`s:${d}:${v.storeId}`]).toBe("1");
    expect(Object.keys(all).filter((k) => k.startsWith("f:"))).toHaveLength(1);
  });

  it("零文件摘要仍占3槽，无空门店计数；九来源整批成功", SLOW, async () => {
    const h = await setup();
    const empty = h.permit({
      kind: "digest",
      fileIds: [],
      originalDeadlineMs: h.clock.now().getTime() + 60000,
    });
    expect(await h.ledger.reserve(empty, signal())).toEqual({
      status: "reserved",
      units: 3,
      newFiles: 0,
    });
    expect(
      Object.keys(await h.snapshot()).filter((k) => k.startsWith("s:") || k.startsWith("f:")),
    ).toEqual([]);
    const p = h.permit({
      kind: "digest",
      fileIds: Array.from({ length: 9 }, () => uuidv7()).sort(),
      dailyFileCap: 9,
      originalDeadlineMs: h.clock.now().getTime() + 60000,
    });
    expect(await h.ledger.reserve(p, signal())).toEqual({
      status: "reserved",
      units: 3,
      newFiles: 9,
    });
    const all = await h.snapshot(),
      d = dayOf(p.readAtMs);
    expect(all[`g:${d}`]).toBe("6");
    expect(all[`s:${d}:${p.storeId}`]).toBe("9");
    expect(Object.keys(all).filter((k) => k.startsWith("f:"))).toHaveLength(9);
  });

  it.each(["files", "calls"])("整批%s不足时所有计数与索引均零写", SLOW, async (limit) => {
    const h = await setup(),
      before = await h.snapshot();
    const p = h.permit({
      kind: "digest",
      fileIds: [h.fileId, uuidv7()].sort(),
      dailyFileCap: limit === "files" ? 1 : 200,
      dailyCallCap: limit === "calls" ? 2 : 100,
      originalDeadlineMs: h.clock.now().getTime() + 60000,
    });
    expect(await h.ledger.reserve(p, signal())).toEqual({
      status: "denied",
      reason: limit === "files" ? "quota_store" : "quota_global",
    });
    expect(await h.snapshot()).toEqual(before);
  });

  it("不同门店文件额度隔离，全局仍共享", SLOW, async () => {
    const h = await setup();
    const a = h.permit({ dailyFileCap: 1, dailyCallCap: 2 });
    expect((await h.ledger.reserve(a, signal())).status).toBe("reserved");
    const b = h.permit({ storeId: uuidv7(), dailyFileCap: 1, dailyCallCap: 2 });
    expect((await h.other.reserve(b, signal())).status).toBe("reserved");
    expect(await h.ledger.reserve(h.permit({ dailyCallCap: 2 }), signal())).toEqual({
      status: "denied",
      reason: "quota_global",
    });
    const all = await h.snapshot(),
      d = dayOf(a.readAtMs);
    expect(all[`g:${d}`]).toBe("2");
    expect(all[`s:${d}:${a.storeId}`]).toBe("1");
    expect(all[`s:${d}:${b.storeId}`]).toBe("1");
  });

  it.each(["same", "hash", "lease", "manual_retry"])(
    "无日期token对%s保守冲突，无重扣",
    SLOW,
    async (change) => {
      const h = await setup(),
        p = h.permit();
      expect((await h.ledger.reserve(p, signal())).status).toBe("reserved");
      const before = await h.snapshot(),
        at = Date.now();
      const duplicate = h.permit({
        ...p,
        readAtMs: at,
        admitUntilMs: at + 250,
        ...(change === "hash" ? { expectedSourceHash: "b".repeat(64) } : {}),
        ...(change === "lease" ? { leaseUntilMs: at + 60000 } : {}),
        ...(change === "manual_retry" ? { originalDeadlineMs: at + 60000 } : {}),
      });
      expect(await h.other.reserve(duplicate, signal())).toEqual({
        status: "denied",
        reason: "duplicate",
      });
      expect(await h.snapshot()).toEqual(before);
      expect(h.token(p)).not.toContain(String(dayOf(p.readAtMs)));
    },
  );

  it("降低技术HLEN上界的同分支达到16后关闭，绝不填25万", SLOW, async () => {
    const h = await setup({ maxFields: 16 });
    expect((await h.ledger.reserve(h.permit(), signal())).status).toBe("reserved");
    expect(await first.hlen(h.key)).toBe(16);
    const before = await h.snapshot();
    expect(await h.ledger.reserve(h.permit(), signal())).toEqual({
      status: "denied",
      reason: "unavailable",
    });
    expect(await h.snapshot()).toEqual(before);
  });

  it.each([
    "marker",
    "metadata",
    "global",
    "store",
    "file",
    "queue_collision",
    "business_back",
    "redis_back",
    "day_back",
  ])("损坏%s拒绝且整批无写", SLOW, async (fault) => {
    const h = await setup(),
      p = h.permit(),
      d = dayOf(p.readAtMs);
    if (fault === "marker") await first.hset(h.key, "marker", "wrong");
    if (fault === "metadata") await first.hdel(h.key, "head");
    if (fault === "global") await first.hset(h.key, `g:${d}`, "NaN");
    if (fault === "store") await first.hset(h.key, `s:${d}:${p.storeId}`, "1");
    if (fault === "file") await first.hset(h.key, `f:${d}:${p.storeId}:${h.fileId}`, "1");
    if (fault === "queue_collision") await first.hset(h.key, "q:1", "unexpected");
    if (fault === "business_back") await first.hset(h.key, "business", String(Date.now() + 10000));
    if (fault === "redis_back") await first.hset(h.key, "redis", String(Date.now() + 10000));
    if (fault === "day_back") await first.hset(h.key, "day", String(d + 1));
    const before = await h.snapshot();
    expect(await h.ledger.reserve(h.permit({ jobId: p.jobId }), signal())).toEqual({
      status: "denied",
      reason: "unavailable",
    });
    expect(await h.snapshot()).toEqual(before);
  });

  it("wrong-type KEY不被覆盖，时钟偏差超过5秒不扣留", SLOW, async () => {
    const h = await setup({ seed: false });
    await first.set(h.key, "keep");
    expect((await h.ledger.reserve(h.permit(), signal())).status).toBe("denied");
    expect(await first.get(h.key)).toBe("keep");
    await first.unlink(h.key);
    const fresh = await setup(),
      p = fresh.permit();
    fresh.clock.advance(6000);
    const at = fresh.clock.now().getTime(),
      before = await fresh.snapshot();
    expect(
      await fresh.ledger.reserve({ ...p, readAtMs: at, admitUntilMs: at + 250 }, signal()),
    ).toEqual({ status: "denied", reason: "unavailable" });
    expect(await fresh.snapshot()).toEqual(before);
  });

  it("短permit传输超时后迟到eval被RedisTIME拒绝，无新授权或重发", SLOW, async () => {
    const h = await setup(),
      before = await h.snapshot();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let late!: Promise<unknown>;
    const delayed = vi.fn<ModelBudgetTransport["eval"]>((script, keys, argv) => {
      late = gate.then(() => first.eval(script, keys.length, ...keys, ...argv));
      return late;
    });
    const ledger = h.build(delayed);
    try {
      expect((await ledger.reserve(h.permit(), signal())).status).toBe("denied");
      await new Promise((resolve) => setTimeout(resolve, 60));
      release();
      expect(await late).toEqual(["denied", "stale"]);
      expect(await h.snapshot()).toEqual(before);
      expect(delayed).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await late;
    }
  });

  it("日field安全退役仍保活token，旧日permit零eval", SLOW, async () => {
    const h = await setup(),
      p = h.permit();
    expect((await h.ledger.reserve(p, signal())).status).toBe("reserved");
    const all = await h.snapshot(),
      d = dayOf(p.readAtMs),
      old = d - 2;
    const q = Number(all["next"]),
      expiry = (old + 2) * DAY - OFFSET;
    const targets = [`g:${old}`, `s:${old}:${p.storeId}`, `f:${old}:${p.storeId}:${h.fileId}`];
    for (const [n, target] of targets.entries())
      await first.hset(
        h.key,
        target,
        "1",
        `q:${q + n}`,
        JSON.stringify([["g", "s", "f"][n], String(old), String(expiry), target]),
      );
    await first.hset(h.key, "next", String(q + 3));
    h.refresh();
    expect(await h.ledger.maintain(signal())).toMatchObject({ status: "maintained", removed: 3 });
    for (const target of targets) expect(await first.hexists(h.key, target)).toBe(0);
    expect(await first.hget(h.key, h.token(p))).toBe(String(p.originalDeadlineMs));
    const before = h.evaluate.mock.calls.length;
    expect(
      (
        await h.ledger.reserve(
          { ...p, readAtMs: p.readAtMs - DAY, admitUntilMs: p.readAtMs - DAY + 250 },
          signal(),
        )
      ).status,
    ).toBe("denied");
    expect(h.evaluate).toHaveBeenCalledTimes(before);
    const at = Date.now();
    expect(
      await h.other.reserve(h.permit({ ...p, readAtMs: at, admitUntilMs: at + 250 }), signal()),
    ).toEqual({ status: "denied", reason: "duplicate" });
  });

  it("真实预留只在原deadline加5秒后退役，旧deadline永久被时间水位拒绝", SLOW, async () => {
    const h = await setup(),
      at = Date.now();
    const p = h.permit({ admitUntilMs: at + 240, originalDeadlineMs: at + 300 });
    expect((await h.ledger.reserve(p, signal())).status).toBe("reserved");
    h.refresh();
    expect(await h.ledger.maintain(signal())).toMatchObject({ status: "maintained", removed: 0 });
    expect(await first.hexists(h.key, h.token(p))).toBe(1);
    const delay = p.originalDeadlineMs + 5000 - Date.now() + 50;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    h.refresh();
    expect(await h.ledger.maintain(signal())).toMatchObject({ status: "maintained", removed: 1 });
    expect(await first.hexists(h.key, h.token(p))).toBe(0);
    expect(await first.hget(h.key, "closed")).toBe(String(p.originalDeadlineMs));
    const original = h.permit({ ...p, readAtMs: Date.now(), admitUntilMs: Date.now() + 100 });
    expect((await h.ledger.reserve(original, signal())).status).toBe("denied");
    const before = await h.snapshot();
    h.clock.set(new Date(p.readAtMs));
    expect((await h.ledger.reserve(p, signal())).status).toBe("denied");
    expect(await h.snapshot()).toEqual(before);
  });

  it("closedBefore保守拒绝其他旧deadline，不用caller延限绕过", SLOW, async () => {
    const h = await setup(),
      p = h.permit();
    await first.hset(h.key, "closed", String(p.originalDeadlineMs));
    const before = await h.snapshot();
    expect(await h.ledger.reserve(p, signal())).toEqual({ status: "denied", reason: "stale" });
    expect(await h.snapshot()).toEqual(before);
  });

  it("128序号槽含洞；活head不阻断尾部，循环继续复核活项", SLOW, async () => {
    const h = await setup(),
      stamp = Date.now() + 60000;
    const active: Entry = {
      kind: "t",
      stamp,
      target: `t:${uuidv7()}:1:vision`,
      value: String(stamp),
    };
    const past = expired(h, 130);
    await indexed(h, [active, ...past]);
    h.refresh();
    expect(await h.ledger.maintain(signal())).toEqual({
      status: "maintained",
      scanned: 128,
      removed: 127,
    });
    expect(await first.hget(h.key, "head")).toBe("1");
    expect(await first.hget(h.key, "cursor")).toBe("129");
    h.refresh();
    expect(await h.other.maintain(signal())).toEqual({
      status: "maintained",
      scanned: 128,
      removed: 3,
    });
    expect(await first.hget(h.key, active.target)).toBe(String(stamp));
    expect(await first.hget(h.key, "head")).toBe("1");
    for (const e of past) expect(await first.hexists(h.key, e.target)).toBe(0);
    const raw = await first.hget(h.key, "q:1");
    expect(JSON.parse(raw!)).toEqual(["t", String(stamp), String(stamp + 5000), active.target]);
  });

  it("空洞计入扫描且head推进不会永久跳过后续活token", SLOW, async () => {
    const h = await setup(),
      stamp = Date.now() + 60000;
    const active: Entry = { kind: "t", stamp, target: `t:${uuidv7()}:1:asr`, value: String(stamp) };
    const past = expired(h, 2);
    await indexed(h, [past[0]!, active, past[1]!]);
    // 合法历史维护已经退役首项，但尚未推进head；水位先持久化。
    await first.hset(h.key, "closed", String(past[0]!.stamp));
    await first.hdel(h.key, past[0]!.target, "q:1");
    h.refresh();
    expect(await h.ledger.maintain(signal())).toEqual({
      status: "maintained",
      scanned: 3,
      removed: 1,
    });
    expect(await first.hget(h.key, "head")).toBe("2");
    h.refresh();
    expect(await h.ledger.maintain(signal())).toEqual({
      status: "maintained",
      scanned: 2,
      removed: 0,
    });
    expect(await first.hget(h.key, active.target)).toBe(String(stamp));
  });

  it.each([
    "missing_target",
    "live_value",
    "wrong_expiry",
    "bad_counter",
    "bad_json",
    "foreign_field",
    "duplicate_target",
  ])("维护%s整批先验，不能删除前一合法到期项", SLOW, async (fault) => {
    const h = await setup(),
      entries = expired(h, 2);
    await indexed(h, entries);
    const e = entries[1]!;
    if (fault === "missing_target") await first.hdel(h.key, e.target);
    if (fault === "live_value") await first.hset(h.key, e.target, String(Date.now() + 60000));
    if (fault === "wrong_expiry")
      await first.hset(
        h.key,
        "q:2",
        JSON.stringify(["t", String(e.stamp), String(e.stamp), e.target]),
      );
    if (fault === "bad_counter")
      await first.hset(
        h.key,
        `g:${dayOf(e.stamp)}`,
        "0",
        "q:2",
        JSON.stringify([
          "g",
          String(dayOf(e.stamp)),
          String((dayOf(e.stamp) + 2) * DAY - OFFSET),
          `g:${dayOf(e.stamp)}`,
        ]),
      );
    if (fault === "bad_json") await first.hset(h.key, "q:2", "not json");
    if (fault === "foreign_field")
      await first.hset(
        h.key,
        "q:2",
        JSON.stringify(["t", String(e.stamp), String(e.stamp + 5000), "marker"]),
      );
    if (fault === "duplicate_target")
      await first.hset(h.key, "q:2", (await first.hget(h.key, "q:1"))!);
    const before = await h.snapshot();
    h.refresh();
    expect(await h.ledger.maintain(signal())).toEqual({ status: "denied", reason: "unavailable" });
    expect(await h.snapshot()).toEqual(before);
    expect(await first.hexists(h.key, entries[0]!.target)).toBe(1);
  });

  it("空队列维护有界，序号接近安全整数末端不重置或部分写", SLOW, async () => {
    const h = await setup();
    h.refresh();
    expect(await h.ledger.maintain(signal())).toEqual({
      status: "maintained",
      scanned: 0,
      removed: 0,
    });
    const last = String(Number.MAX_SAFE_INTEGER);
    await first.hset(h.key, "head", last, "next", last, "cursor", last);
    const before = await h.snapshot();
    expect(await h.ledger.reserve(h.permit(), signal())).toEqual({
      status: "denied",
      reason: "unavailable",
    });
    expect(await h.snapshot()).toEqual(before);
  });

  it.each(["reserve", "maintain", "detached_reserve", "detached_maintain"])(
    "真实PG的%s拒绝外呼，不借detach绕过",
    SLOW,
    async (mode) => {
      const h = await setup(),
        tx = createTxRunner({ prisma: await database.prisma(), appEnv: "test" });
      const work = async (): Promise<unknown> =>
        mode.endsWith("maintain")
          ? h.ledger.maintain(signal())
          : h.ledger.reserve(h.permit(), signal());
      await expect(
        tx.run(() => (mode.startsWith("detached") ? detach(work) : work())),
      ).rejects.toBeInstanceOf(KernelViolation);
      expect(h.evaluate).not.toHaveBeenCalled();
    },
  );

  it("事务外已预留后真实PG回滚仍保守占槽，不存在跨系统退款", SLOW, async () => {
    const h = await setup(),
      p = h.permit(),
      prisma = await database.prisma();
    const tx = createTxRunner({ prisma, appEnv: "test" }),
      original = new Error("rollback fixture");
    expect((await h.ledger.reserve(p, signal())).status).toBe("reserved");
    const reserved = await h.snapshot();
    await expect(
      tx.run(async (handle) => {
        await handle.bizSequence.create({
          data: { prefix: "BG", bizDate: new Date("2026-10-11"), nextVal: 1 },
        });
        throw original;
      }),
    ).rejects.toBe(original);
    expect(await prisma.bizSequence.count({ where: { prefix: "BG" } })).toBe(0);
    expect(await h.snapshot()).toEqual(reserved);
    expect(await first.hexists(h.key, h.token(p))).toBe(1);
    expect(h.evaluate).toHaveBeenCalledTimes(1);
  });
});
