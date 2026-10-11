import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTxRunner, KernelViolation, uuidv7 } from "../kernel/index.js";
import { createClock, useTestDatabase, useTestRedis } from "../testing/index.js";
import { createModelBudgetLedger } from "../media/index.js";
import type { ModelBudgetContext, ModelBudgetTransport } from "../media/index.js";
import { createModelBudgetInspector } from "./model-budget-inspect.js";

const redis = useTestRedis(),
  db = useTestDatabase("services");
const SLOW = { timeout: 120000 },
  DAY = 86400000,
  OFFSET = 28800000;
const day = (n: number) => Math.floor((n + OFFSET) / DAY),
  signal = () => new AbortController().signal;
let client: Awaited<ReturnType<typeof redis.raw>>;
beforeAll(async () => {
  client = await redis.raw();
}, 60000);
beforeEach(() => redis.flush(), 60000);

async function setup(seed = true) {
  const prefix = `${redis.prefix}inspect:`,
    key = `${prefix}model_budget:v1`,
    clock = createClock(new Date());
  const now = clock.now().getTime(),
    [seconds, micros] = await client.time();
  const rt = Number(seconds) * 1000 + Math.floor(Number(micros) / 1000);
  // 显式合法历史：两个时钟各用其真实历史，不提供生产初始化口。
  if (seed)
    await client.hset(key, {
      marker: "model_budget_v1",
      business: String(now - 1),
      redis: String(rt - 1),
      day: String(day(now)),
      closed: "0",
      head: "1",
      next: "1",
      cursor: "1",
    });
  const transport: ModelBudgetTransport = {
    eval: async (script, keys, argv) => {
      expect(keys).toEqual(["lyx:test:model_budget:v1"]);
      return client.eval(script, 1, key, ...argv);
    },
  };
  const inspector = createModelBudgetInspector({ appEnv: "test", clock, transport });
  const refresh = () => clock.set(new Date());
  async function inspect() {
    const before = await client.hgetall(key),
      expiry = await client.pexpiretime(key);
    refresh();
    const result = await inspector.inspect(signal());
    expect(await client.hgetall(key)).toEqual(before);
    expect(await client.pexpiretime(key)).toBe(expiry);
    return result;
  }
  const ledger = createModelBudgetLedger({
    prefix,
    clock,
    transport: { eval: (script, keys, argv) => client.eval(script, keys.length, ...keys, ...argv) },
  });
  function permit(): ModelBudgetContext {
    refresh();
    const at = clock.now().getTime();
    return {
      entityId: uuidv7(),
      storeId: uuidv7(),
      jobId: uuidv7(),
      fileIds: [uuidv7()],
      kind: "asr",
      attemptNo: 1,
      expectedSourceHash: "a".repeat(64),
      dailyFileCap: 200,
      dailyCallCap: 10000,
      readAtMs: at,
      admitUntilMs: at + 250,
      leaseUntilMs: at + 120000,
      originalDeadlineMs: at + 1800000,
    };
  }
  return { prefix, key, clock, now, rt, inspector, inspect, refresh, ledger, permit };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
async function token(h: Fixture, stamp: number, slot = 1) {
  const target = `t:${uuidv7()}:1:asr`;
  await client.hset(h.key, {
    [target]: String(stamp),
    [`q:${slot}`]: JSON.stringify(["t", String(stamp), String(stamp + 5000), target]),
    next: String(slot + 1),
  });
  return target;
}

describe("小Redis正式只读预算诊断", () => {
  it("missing不建账，wrong_type不改变字符串值/到期", SLOW, async () => {
    const h = await setup(false);
    expect(await h.inspector.inspect(signal())).toEqual({ status: "inspected", key: "missing" });
    expect(await client.exists(h.key)).toBe(0);
    await client.set(h.key, "public-private-marker", "PX", 120000);
    const expiry = await client.pexpiretime(h.key);
    h.refresh();
    expect(await h.inspector.inspect(signal())).toEqual({ status: "inspected", key: "wrong_type" });
    expect(await client.get(h.key)).toBe("public-private-marker");
    expect(await client.pexpiretime(h.key)).toBe(expiry);
    await h.inspector.close();
  });
  it("同一真实原ledger预留后只读所有合法索引，不消费或增加额度", SLOW, async () => {
    const h = await setup(),
      p = h.permit();
    expect(await h.ledger.reserve(p, signal())).toEqual({
      status: "reserved",
      units: 1,
      newFiles: 1,
    });
    await client.pexpire(h.key, 120000);
    expect(await h.inspect()).toMatchObject({
      status: "inspected",
      schema: "sampled_metadata_ok",
      fieldCount: 16,
      currentGlobalUsed: 1,
      coverage: { kind: "sampled", slotsRead: 4, holes: 0, totalSlots: 4, hasMore: false },
      sampledReservations: {
        beforeDeadline: 1,
        retentionWindow: 0,
        expired: 0,
        boundaryDisagreement: 0,
        earliestDeadlineMs: p.originalDeadlineMs,
        latestDeadlineMs: p.originalDeadlineMs,
      },
    });
    const before = await client.hgetall(h.key);
    expect((await h.inspect()).status).toBe("inspected");
    expect(await client.hgetall(h.key)).toEqual(before);
    h.refresh();
    expect(
      await h.ledger.reserve(
        { ...p, readAtMs: h.clock.now().getTime(), admitUntilMs: h.clock.now().getTime() + 250 },
        signal(),
      ),
    ).toEqual({ status: "denied", reason: "duplicate" });
    await h.inspector.close();
  });
  it.each([
    ["marker", "unknown"],
    ["business", "01"],
    ["redis", "-1"],
    ["day", "1e3"],
    ["closed", "9007199254740992"],
    ["head", "0"],
    ["next", "0"],
    ["cursor", "0"],
    ["cursor", "2"],
  ])("元字段%s=%s受控拒绝且无写", SLOW, async (field, value) => {
    const h = await setup();
    await client.hset(h.key, field, value);
    expect(await h.inspect()).toEqual({
      status: "inspected",
      key: "hash",
      schema: "invalid_metadata",
      reason: "metadata",
    });
    await h.inspector.close();
  });
  it.each(["0", "10001", "1.5"])("当前global=%s非法，不把缺失当零使用", SLOW, async (value) => {
    const h = await setup();
    await client.hset(h.key, `g:${day(h.now)}`, value);
    expect(await h.inspect()).toEqual({
      status: "inspected",
      key: "hash",
      schema: "invalid_metadata",
      reason: "current_counter",
    });
    await h.inspector.close();
  });
  it.each([
    ["badjson", "public-private-marker"],
    ["wrongarity", JSON.stringify(["t", "1"])],
    ["noncanonical", JSON.stringify(["t", "01", "5001", "anything"])],
  ])("索引%s只给受控reason，不回传任意字段", SLOW, async (_label, value) => {
    const h = await setup();
    await client.hset(h.key, { next: "2", "q:1": value });
    const result = await h.inspect();
    expect(result).toEqual({
      status: "inspected",
      key: "hash",
      schema: "invalid_sample",
      reason: "index",
    });
    expect(JSON.stringify(result)).not.toContain("public-private-marker");
    await h.inspector.close();
  });
  it.each(["missing", "value", "expiry", "attempt", "kind"])(
    "token%s不符原规则时不能称合法样本",
    SLOW,
    async (fault) => {
      const h = await setup(),
        stamp = h.now + 60000,
        target = await token(h, stamp);
      if (fault === "missing") await client.hdel(h.key, target);
      if (fault === "value") await client.hset(h.key, target, String(stamp + 1));
      if (fault === "expiry")
        await client.hset(
          h.key,
          "q:1",
          JSON.stringify(["t", String(stamp), String(stamp + 4999), target]),
        );
      if (fault === "attempt" || fault === "kind") {
        const changed = target.replace(
          fault === "attempt" ? ":1:asr" : ":asr",
          fault === "attempt" ? ":01:asr" : ":other",
        );
        await client.hset(h.key, {
          [changed]: String(stamp),
          "q:1": JSON.stringify(["t", String(stamp), String(stamp + 5000), changed]),
        });
      }
      expect(await h.inspect()).toEqual({
        status: "inspected",
        key: "hash",
        schema: "invalid_sample",
        reason: "target",
      });
      await h.inspector.close();
    },
  );
  it.each(["g", "s", "f"])("%s索引严格核实际值/标识符/日及expiry", SLOW, async (kind) => {
    const h = await setup(),
      d = day(h.now),
      store = uuidv7(),
      file = uuidv7();
    const target =
      kind === "g" ? `g:${d}` : kind === "s" ? `s:${d}:${store}` : `f:${d}:${store}:${file}`;
    await client.hset(h.key, {
      next: "2",
      [target]: "1",
      "q:1": JSON.stringify([kind, String(d), String((d + 2) * DAY - OFFSET), target]),
    });
    expect(await h.inspect()).toMatchObject({
      schema: "sampled_metadata_ok",
      coverage: { slotsRead: 1, holes: 0 },
    });
    await client.hset(
      h.key,
      "q:1",
      JSON.stringify([kind, String(d), String((d + 2) * DAY - OFFSET + 1), target]),
    );
    expect(await h.inspect()).toEqual({
      status: "inspected",
      key: "hash",
      schema: "invalid_sample",
      reason: "target",
    });
    await h.inspector.close();
  });
  it("重复target不把两条索引当两次许可", SLOW, async () => {
    const h = await setup(),
      stamp = h.now + 60000,
      target = await token(h, stamp);
    await client.hset(h.key, {
      next: "3",
      "q:2": JSON.stringify(["t", String(stamp), String(stamp + 5000), target]),
    });
    expect(await h.inspect()).toEqual({
      status: "inspected",
      key: "hash",
      schema: "invalid_sample",
      reason: "index",
    });
    await h.inspector.close();
  });
  it.each([
    ["beforeDeadline", 60000],
    ["retentionWindow", -2000],
    ["expired", -6000],
  ] as const)("%s只是原期限历史，不删token", SLOW, async (facet, offset) => {
    const h = await setup(),
      stamp = h.now + offset,
      target = await token(h, stamp);
    expect(await h.inspect()).toMatchObject({
      sampledReservations: { [facet]: 1, earliestDeadlineMs: stamp, latestDeadlineMs: stamp },
    });
    expect(await client.hget(h.key, target)).toBe(String(stamp));
    await h.inspector.close();
  });
  it("两独立时钟跨边界分歧单独报告，不冒充当前有效许可", SLOW, async () => {
    const h = await setup(),
      target = await token(h, h.now + 1000);
    h.clock.set(new Date(h.now + 2000));
    const before = await client.hgetall(h.key);
    expect(await h.inspector.inspect(signal())).toMatchObject({
      sampledReservations: { boundaryDisagreement: 1 },
    });
    expect(await client.hgetall(h.key)).toEqual(before);
    expect(await client.hget(h.key, target)).not.toBeNull();
    await h.inspector.close();
  });
  it("129槽只读128，洞消耗扫描预算；未读尾token不能称不存在", SLOW, async () => {
    const h = await setup(),
      target = await token(h, h.now + 60000, 129);
    expect(await h.inspect()).toMatchObject({
      coverage: { kind: "sampled", slotsRead: 128, holes: 128, totalSlots: 129, hasMore: true },
      sampledReservations: { beforeDeadline: 0 },
    });
    expect(await client.hget(h.key, target)).not.toBeNull();
    expect(await client.hget(h.key, "head")).toBe("1");
    expect(await client.hget(h.key, "cursor")).toBe("1");
    await h.inspector.close();
  });
  it("旧日只报rollover_pending并保跨日活token/closed水位，不推进维护", SLOW, async () => {
    const h = await setup(),
      target = await token(h, h.now + 60000);
    await client.hset(h.key, {
      day: String(day(h.now) - 1),
      closed: String(h.now + 30000),
      cursor: "2",
    });
    expect(await h.inspect()).toMatchObject({
      clock: { rolloverPending: true, rollback: false },
      closedBeforeMs: h.now + 30000,
      sampledReservations: { beforeDeadline: 1 },
    });
    expect(await client.hget(h.key, target)).not.toBeNull();
    expect(await client.hget(h.key, "day")).toBe(String(day(h.now) - 1));
    await h.inspector.close();
  });
  it.each(["business", "redis", "day"])(
    "已存%s超前只报clock rollback，仍不恢复",
    SLOW,
    async (field) => {
      const h = await setup();
      await client.hset(h.key, field, String(field === "day" ? day(h.now) + 1 : h.now + 86400000));
      expect(await h.inspect()).toMatchObject({ clock: { rollback: true } });
      await h.inspector.close();
    },
  );
  it("PG内inspect按真实kernel拒绝，零Redis诊断调用", SLOW, async () => {
    const h = await setup(),
      prisma = await db.prisma(),
      tx = createTxRunner({ prisma, appEnv: "test" });
    const before = await client.hgetall(h.key);
    await expect(tx.run(async () => h.inspector.inspect(signal()))).rejects.toBeInstanceOf(
      KernelViolation,
    );
    expect(await client.hgetall(h.key)).toEqual(before);
    await h.inspector.close();
  });
});
