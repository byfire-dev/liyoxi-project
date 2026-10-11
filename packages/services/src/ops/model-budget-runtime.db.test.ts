import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@liyoxi/db";
import { assertNotInTransaction, KernelViolation, uuidv7 } from "../kernel/index.js";
import type {
  ModelBudgetAdmission,
  ModelBudgetContext,
  ModelBudgetTransport,
} from "../media/index.js";
import { ok } from "../providers/types.js";
import { createMediaAssetsHarness, useSeededDatabase, useTestRedis } from "../testing/index.js";
import { createAlertFacts } from "./alert-facts.js";
import { createModelBudgetRuntime } from "./model-budget-runtime.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis(),
  SLOW = 120000;
const dayOf = (at: number) => Math.floor((at + 28800000) / 86400000);
const signal = () => new AbortController().signal;
let prisma: Awaited<ReturnType<typeof db.prisma>>;
let first: Awaited<ReturnType<typeof redis.raw>>, second: typeof first;
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
let runtime: ReturnType<typeof createModelBudgetRuntime>, other: typeof runtime | undefined;
let alerts: ReturnType<typeof createAlertFacts>;
let evaluate: ReturnType<typeof vi.fn<ModelBudgetTransport["eval"]>>;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const prefix = () => `${redis.prefix}runtime:`,
  key = () => `${prefix()}model_budget:v1`;
beforeAll(async () => {
  prisma = await db.prisma();
  first = await redis.raw();
  second = await redis.raw();
}, SLOW);
beforeEach(async () => {
  await db.reset();
  await redis.flush();
  // 配对桥只委托真实实例，不改变三个owner或在PG内调用Redis。
  const admission: ModelBudgetAdmission = {
    readPermit: (tx, facts) => runtime.admission.readPermit(tx, facts),
    reserve: (value, abort) => runtime.admission.reserve(value, abort),
  };
  h = await createMediaAssetsHarness(prisma, { modelBudget: admission });
  h.clock.set(new Date());
  alerts = createAlertFacts({ tx: h.tx, clock: h.clock, logger });
  evaluate = vi.fn<ModelBudgetTransport["eval"]>(async (script, keys, argv) => {
    assertNotInTransaction("runtime-test.redis");
    return first.eval(script, keys.length, ...keys, ...argv);
  });
  runtime = createModelBudgetRuntime({
    clock: h.clock,
    prefix: prefix(),
    transport: { eval: evaluate },
    alerts,
    logger,
  });
  other = undefined;
}, SLOW);
afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await h?.close();
  } finally {
    await Promise.allSettled([runtime?.close(), other?.close()]);
    await alerts?.close();
  }
}, SLOW);

async function seed() {
  h.clock.set(new Date());
  const at = h.clock.now().getTime(),
    [seconds, micros] = await first.time();
  // 各自时钟的合法历史；没有生产初始化口，不以业务毫秒冒充Redis历史。
  await first.hset(key(), {
    marker: "model_budget_v1",
    business: String(at - 1),
    redis: String(Number(seconds) * 1000 + Math.floor(Number(micros) / 1000) - 1),
    day: String(dayOf(at)),
    closed: "0",
    head: "1",
    next: "1",
    cursor: "1",
  });
}
function facts(): Omit<ModelBudgetContext, "dailyFileCap" | "dailyCallCap"> {
  h.clock.set(new Date());
  const at = h.clock.now().getTime();
  return {
    entityId: h.merchant.entity.id,
    storeId: h.merchant.store.id,
    jobId: uuidv7(),
    fileIds: [uuidv7()],
    kind: "vision",
    attemptNo: 1,
    expectedSourceHash: "a".repeat(64),
    readAtMs: at,
    admitUntilMs: at + 250,
    leaseUntilMs: at + 60000,
    originalDeadlineMs: at + 60000,
  };
}
async function revision(
  name: "media.assets.daily_file_cap" | "media.model.daily_call_cap",
  value: Prisma.InputJsonValue,
) {
  return prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key: name,
      value,
      effectiveAt: h.clock.now(),
      createdByStaffId: h.staff.id,
      createdAt: h.clock.now(),
      reason: "公开虚构预算参数修订",
    },
  });
}
async function caps(files = 200, calls = 10000) {
  await revision("media.assets.daily_file_cap", files);
  await revision("media.model.daily_call_cap", calls);
}
async function permit() {
  const input = facts();
  return h.tx.run((tx) => runtime.admission.readPermit(tx, input));
}
async function readyText() {
  const asset = await h.media.assets.create(h.owner, {
    type: "text",
    textBody: "公开虚构门店的菜品与营业时间",
  });
  const audit = await prisma.mediaJob.findFirstOrThrow({
    where: { parentId: asset.storeAssetId, kind: "audit_text" },
  });
  await h.media.jobs.run({ jobId: audit.id });
  expect((await prisma.mediaJob.findUniqueOrThrow({ where: { id: audit.id } })).state).toBe(
    "succeeded",
  );
  return prisma.mediaJob.findFirstOrThrow({
    where: { parentId: asset.storeAssetId, kind: "digest" },
  });
}

describe("预算真实参数/Redis/独立告警事务", { timeout: SLOW }, () => {
  it("正式缺省200/0：不调用Redis、不建HASH、不误报配额", async () => {
    expect(await permit()).toBeNull();
    await runtime.drain();
    expect(evaluate).not.toHaveBeenCalled();
    expect(await first.exists(key())).toBe(0);
    expect(await prisma.paramValue.count()).toBe(0);
    expect(await prisma.alertEvent.count()).toBe(0);
  });

  it("冷HASH不可用写真实规则事实，但不自动初始化", async () => {
    await caps();
    expect(await runtime.admission.reserve((await permit())!, signal())).toEqual({
      status: "denied",
      reason: "unavailable",
    });
    expect(await first.exists(key())).toBe(0);
    expect(await prisma.alertEvent.findMany()).toMatchObject([
      {
        rule: "media.model_budget_unavailable",
        fingerprint: "media.model_budget_unavailable:global",
        lastValue: { kind: "vision", reason: "unavailable", scope: "global" },
      },
    ]);
  });

  it.each(["quota_global", "quota_store"] as const)(
    "%s真实配额与告警upsert，无正文/链接/凭证",
    async (reason) => {
      await seed();
      await caps(reason === "quota_store" ? 1 : 200, reason === "quota_global" ? 3 : 10000);
      const firstPermit = (await permit())!;
      expect(await runtime.admission.reserve(firstPermit, signal())).toEqual({
        status: "reserved",
        units: 3,
        newFiles: 1,
      });
      for (let n = 0; n < 2; n++)
        expect(await runtime.admission.reserve((await permit())!, signal())).toEqual({
          status: "denied",
          reason,
        });
      const events = await prisma.alertEvent.findMany();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        rule: "media.model_budget_exhausted",
        occurrences: 2,
        lastValue: { kind: "vision", reason, scope: reason === "quota_store" ? "store" : "global" },
      });
      expect(events[0]!.fingerprint).toBe(
        `media.model_budget_exhausted:${reason === "quota_store" ? h.merchant.store.id : "global"}`,
      );
      expect(JSON.stringify(events)).not.toContain(firstPermit.expectedSourceHash);
      expect(await first.hget(key(), `g:${dayOf(firstPermit.readAtMs)}`)).toBe("3");
    },
  );

  it("duplicate/stale/合法0都不误报超限", async () => {
    await seed();
    await caps();
    const value = (await permit())!;
    expect((await runtime.admission.reserve(value, signal())).status).toBe("reserved");
    expect(await runtime.admission.reserve(value, signal())).toEqual({
      status: "denied",
      reason: "duplicate",
    });
    h.clock.advance(251);
    expect(await runtime.admission.reserve(value, signal())).toEqual({
      status: "denied",
      reason: "stale",
    });
    h.clock.set(new Date());
    await revision("media.model.daily_call_cap", 0);
    expect(await permit()).toBeNull();
    await runtime.drain();
    expect(await prisma.alertEvent.count()).toBe(0);
  });

  it("非法P1只排本次事实；活PG中零外呼，事务外才写告警", async () => {
    await caps();
    await revision("media.model.daily_call_cap", "非法历史值");
    const before = await prisma.paramValue.findMany({ orderBy: { seq: "asc" } });
    await expect(
      h.tx.run(async (tx) => {
        await expect(runtime.admission.readPermit(tx, facts())).rejects.toThrow("模型预算参数非法");
        expect(await tx.alertEvent.count()).toBe(0);
        expect(evaluate).not.toHaveBeenCalled();
      }),
    ).resolves.toBeUndefined();
    expect(await prisma.alertEvent.count()).toBe(0);
    await runtime.drain();
    expect(await prisma.alertEvent.findMany()).toMatchObject([
      { rule: "media.model_budget_unavailable", lastValue: { reason: "invalid_config" } },
    ]);
    expect(await prisma.paramValue.findMany({ orderBy: { seq: "asc" } })).toEqual(before);
    // 后一合法调用不会继承前次非法flag。
    h.clock.advance(1);
    await revision("media.model.daily_call_cap", 3);
    expect((await permit())?.dailyCallCap).toBe(3);
  });

  it.each(["reserve", "maintain", "drain"] as const)(
    "%s在真实PG事务内拒绝且零Redis/告警",
    async (method) => {
      await caps();
      const value = (await permit())!;
      const failure = await h.tx
        .run(async () => {
          if (method === "reserve") await runtime.admission.reserve(value, signal());
          else await runtime[method]();
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(KernelViolation);
      expect(evaluate).not.toHaveBeenCalled();
      expect(await prisma.alertEvent.count()).toBe(0);
    },
  );

  it("两实例两个Redis客户端竞争最后3槽，关闭一个不影响另一个", async () => {
    await seed();
    await caps(200, 3);
    other = createModelBudgetRuntime({
      clock: h.clock,
      prefix: prefix(),
      alerts,
      logger,
      transport: {
        eval: (script, keys, argv) => second.eval(script, keys.length, ...keys, ...argv),
      },
    });
    const a = (await permit())!,
      b = (await permit())!;
    const results = await Promise.all([
      runtime.admission.reserve(a, signal()),
      other.admission.reserve(b, signal()),
    ]);
    expect(results.filter((result) => result.status === "reserved")).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "denied" && result.reason === "quota_global"),
    ).toHaveLength(1);
    await runtime.close();
    h.clock.set(new Date());
    expect((await other.maintain()).status).toBe("maintained");
    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    expect(await first.hget(key(), `g:${dayOf(a.readAtMs)}`)).toBe("3");
  });

  it("稀疏维护清过期token，保活token/计数，重复attempt仍不可放行", async () => {
    await seed();
    await caps();
    const value = (await permit())!;
    expect((await runtime.admission.reserve(value, signal())).status).toBe("reserved");
    const expired = value.readAtMs - 6000,
      target = `t:${uuidv7()}:1:asr`;
    await first.hset(key(), {
      [target]: String(expired),
      "q:6": JSON.stringify(["t", String(expired), String(expired + 5000), target]),
      next: "7",
    });
    h.clock.set(new Date());
    expect(await runtime.maintain()).toEqual({ status: "maintained", scanned: 6, removed: 1 });
    expect(await first.hexists(key(), target)).toBe(0);
    expect(await first.hget(key(), `t:${value.jobId}:1:vision`)).toBe(
      String(value.originalDeadlineMs),
    );
    const again = {
      ...value,
      readAtMs: h.clock.now().getTime(),
      admitUntilMs: h.clock.now().getTime() + 250,
    };
    expect(await runtime.admission.reserve(again, signal())).toEqual({
      status: "denied",
      reason: "duplicate",
    });
    expect(await prisma.alertEvent.count()).toBe(0);
  });

  it("真实EVAL已扣留而回复迟到：关闭保守留槽，不退款或重放", async () => {
    await seed();
    await caps();
    let release!: () => void, entered!: () => void;
    const entry = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    evaluate.mockImplementationOnce(async (script, keys, argv) => {
      const reply = await first.eval(script, keys.length, ...keys, ...argv);
      entered();
      await gate;
      return reply;
    });
    const value = (await permit())!,
      pending = runtime.admission.reserve(value, signal());
    try {
      await entry;
      await runtime.close();
      expect(await pending).toEqual({ status: "denied", reason: "unavailable" });
      expect(await first.hget(key(), `g:${dayOf(value.readAtMs)}`)).toBe("3");
      release();
      await Promise.resolve();
      expect(evaluate).toHaveBeenCalledOnce();
      expect(h.fake.llm.callsOf("summarizeAsset")).toHaveLength(0);
    } finally {
      release();
      await pending;
    }
  });

  it.each([false, true])("真实public digest组合根%s：许可后P2失效仍保3槽", async (invalidate) => {
    await seed();
    await caps(200, 3);
    const job = await readyText();
    h.clock.set(new Date());
    const model = vi.spyOn(h.fake.llm, "summarizeAsset").mockResolvedValue(
      ok({
        title: "",
        keypoints: ["公开虚构菜品"],
        contentTags: [],
        suggestedUsage: [],
        faceHint: "none",
        qualityNotes: [],
      }),
    );
    if (invalidate) {
      const original = runtime.admission.reserve.bind(runtime.admission);
      vi.spyOn(runtime.admission, "reserve").mockImplementation(async (value, abort) => {
        const result = await original(value, abort);
        h.clock.set(new Date());
        await revision("media.model.daily_call_cap", 0);
        return result;
      });
    }
    await h.media.jobs.run({ jobId: job.id });
    const final = await prisma.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(final.state).toBe(invalidate ? "canceled" : "succeeded");
    expect(model).toHaveBeenCalledTimes(invalidate ? 0 : 1);
    const all = await first.hgetall(key());
    expect(
      Object.entries(all)
        .filter(([name]) => name.startsWith("g:"))
        .map(([, value]) => value),
    ).toEqual(["3"]);
    expect(all[`t:${job.id}:1:digest`]).toBe(String(job.deadlineAt.getTime()));
    expect(
      await prisma.storeAssetInsight.count({
        where: { storeAssetId: job.parentId!, kind: "digest" },
      }),
    ).toBe(invalidate ? 0 : 1);
    expect(await prisma.alertEvent.count()).toBe(0);
  });
});
