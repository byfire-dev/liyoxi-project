import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { AppError, createTxRunner, isInTransaction } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import {
  connectTestDatabase,
  createFakeProviders,
  createSampleEvents,
  sampleSystemContext,
  useTestDatabase,
} from "../../testing/index.js";
import { createWebhooks } from "../index.js";
import type { VerifiedWebhook, WebhookPayload, WebhookSource } from "../index.js";
import { prepare, source } from "./__fixtures__/source.js";

const db = useTestDatabase("services");
const ctx = sampleSystemContext("lyxtest.projection");
type Projection = NonNullable<WebhookSource["projectPayload"]>;
const projected = (
  projectPayload: Projection,
  overrides: Partial<WebhookSource> = {},
): WebhookSource & { projectPayload: Projection } => ({
  ...source("PJ"),
  payload: () => ({ identityId: null }),
  ...overrides,
  projectPayload,
});
let prisma: PrismaClient;
let second: PrismaClient;
const stored = (eventId: string) =>
  prisma.webhookEvent.findUniqueOrThrow({
    where: { provider_eventId: { provider: "wecom", eventId } },
  });

beforeAll(async () => {
  prisma = await db.prisma();
  second = createPrismaClient({ connectionString: await db.url(), max: 1 });
  const owner = await connectTestDatabase(db.name, { role: null });
  try {
    await owner.query(
      "CREATE TABLE lyx_probe_projection_commit (id integer PRIMARY KEY, n integer NOT NULL, UNIQUE(n) DEFERRABLE INITIALLY DEFERRED); GRANT SELECT,INSERT ON lyx_probe_projection_commit TO lyx_app; INSERT INTO lyx_probe_projection_commit VALUES(1,1)",
    );
  } finally {
    await owner.end();
  }
}, 120_000);
afterAll(async () => second?.$disconnect());

it("prepare后的事实变更由accept同一真实Tx读取，去敏载荷与真实出站原子落库", async () => {
  const sample = createSampleEvents(prisma);
  const day = new Date("2026-01-05");
  await prisma.bizSequence.create({ data: { prefix: "PJ", bizDate: day, nextVal: 1 } });
  const txids: string[] = [];
  let projectionFailure: unknown;
  const ids = (tx: Tx) =>
    tx.$queryRawUnsafe<Array<{ id: string }>>("SELECT txid_current()::text AS id");
  const projection = vi.fn(async (tx: Tx, event: VerifiedWebhook) => {
    try {
      expect(isInTransaction()).toBe(true);
      expect(event.data).toBe("fixture-private-openid");
      txids.push((await ids(tx))[0]!.id);
      const fact = await tx.bizSequence.findUniqueOrThrow({
        where: { prefix_bizDate: { prefix: "PJ", bizDate: day } },
      });
      return { identityId: `fixture-${fact.nextVal}` };
    } catch (error) {
      projectionFailure = error;
      throw error;
    }
  });
  const input = projected(projection, {
    verify: async (request) => {
      expect(isInTransaction()).toBe(false);
      return source("PJ").verify(request);
    },
  });
  const hooks = createWebhooks({
    ...sample,
    sources: [input],
    events: {
      emit: async (tx, ...args) => {
        txids.push((await ids(tx))[0]!.id);
        return sample.events.emit(tx, ...args);
      },
    },
  });
  const receipt = await prepare(hooks, "same-tx", "wecom", { data: "fixture-private-openid" });
  await prisma.bizSequence.updateMany({ where: { prefix: "PJ" }, data: { nextVal: 2 } });
  const response = await hooks.accept(receipt, ctx);
  expect(projectionFailure).toBeUndefined();
  expect(response).toMatchObject({ status: 200, body: "success" });
  expect(projection).toHaveBeenCalledOnce();
  expect(txids).toHaveLength(2);
  expect(new Set(txids).size).toBe(1);
  const row = await stored("same-tx");
  expect(row).toMatchObject({ payload: { identityId: "fixture-2" }, attempts: 0, error: null });
  const outbox = await prisma.outboxEvent.findMany({
    where: { dedupeKey: `webhook.received:${row.id}` },
  });
  expect(outbox).toHaveLength(1);
  expect(
    JSON.stringify([row.payload, outbox], (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  ).not.toContain("fixture-private-openid");
  expect(await prisma.bizSequence.count({ where: { prefix: "PJ" } })).toBe(1);
});

it("新口仅inbox，inline与支付fallback不能登记投影；旧来源仍可构造", () => {
  const sample = createSampleEvents(prisma);
  for (const overrides of [
    { mode: "inline" as const },
    { mode: "inline" as const, provider: "wechatpay" as const, fallbackToInbox: true },
  ])
    expect(() =>
      createWebhooks({ ...sample, sources: [projected(async () => ({}), overrides)] }),
    ).toThrow("载荷投影仅限收件箱来源");
  expect(() =>
    createWebhooks({ ...sample, sources: [source("PJ", { mode: "inline" })] }),
  ).not.toThrow();
});

it("坏同步模板在TX前拒绝，不调用投影或开启事务", async () => {
  const sample = createSampleEvents(prisma);
  const projection = vi.fn(async () => ({}));
  const run = vi.spyOn(sample.tx, "run");
  const hooks = createWebhooks({
    ...sample,
    sources: [projected(projection, { payload: () => null })],
  });
  expect(await hooks.accept(await prepare(hooks, "bad-template"), ctx)).toMatchObject({
    status: 500,
    body: "failure:WEBHOOK_PAYLOAD_INVALID",
  });
  expect(run).not.toHaveBeenCalled();
  expect(projection).not.toHaveBeenCalled();
  expect(await prisma.webhookEvent.count({ where: { eventId: "bad-template" } })).toBe(0);
});

it.each([
  null,
  [],
  "not-object",
  new Date(),
  { value: undefined },
  { value: Number.NaN },
  { value: () => "private" },
  { value: 1n },
  { value: new Array(1) },
  new Map([["x", 1]]),
])("非法投影输出 %# 固定PAYLOAD且INSERT/emit零调用", async (value) => {
  const sample = createSampleEvents(prisma);
  const create = vi.fn();
  const emit = vi.fn(sample.events.emit);
  const input = projected(async (tx) => {
    tx.webhookEvent.createMany = create;
    return value as WebhookPayload | null;
  });
  const hooks = createWebhooks({ ...sample, sources: [input], events: { emit } });
  const eventId = `invalid-${typeof value}-${Array.isArray(value) ? "array" : String(value)}`;
  expect(await hooks.accept(await prepare(hooks, eventId), ctx)).toMatchObject({
    status: 500,
    body: "failure:WEBHOOK_PAYLOAD_INVALID",
  });
  expect(create).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
  expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(0);
});

it("投影异常与SQL异常保留PERSIST，原始错误不进入协议或持久化", async () => {
  const sample = createSampleEvents(prisma);
  for (const [eventId, projection] of [
    [
      "projection-throws",
      async () => {
        throw new Error("fixture-private-openid");
      },
    ],
    [
      "projection-app-error",
      async () => {
        throw new AppError("WEBHOOK_PAYLOAD_INVALID");
      },
    ],
    [
      "projection-sql",
      async (tx: Tx) => {
        await tx.$queryRawUnsafe("SELECT missing_projection_column");
        return {};
      },
    ],
  ] as const) {
    const hooks = createWebhooks({ ...sample, sources: [projected(projection)] });
    expect(await hooks.accept(await prepare(hooks, eventId), ctx)).toEqual({
      kind: "reply",
      status: 500,
      body: "failure:WEBHOOK_PERSIST_FAILED",
    });
    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(0);
  }
});

it("循环输出受控PAYLOAD；未匹配身份的null字段仍是合法可恢复载荷", async () => {
  const sample = createSampleEvents(prisma);
  const circular: Record<string, unknown> = {};
  circular["self"] = circular;
  const broken = createWebhooks({
    ...sample,
    sources: [projected(async () => circular as WebhookPayload)],
  });
  expect(await broken.accept(await prepare(broken, "projection-cycle"), ctx)).toMatchObject({
    status: 500,
    body: "failure:WEBHOOK_PAYLOAD_INVALID",
  });
  expect(await prisma.webhookEvent.count({ where: { eventId: "projection-cycle" } })).toBe(0);
  const hooks = createWebhooks({
    ...sample,
    sources: [projected(async () => ({ identityId: null, items: [] }))],
  });
  expect(await hooks.accept(await prepare(hooks, "projection-null-identity"), ctx)).toMatchObject({
    status: 200,
  });
  expect((await stored("projection-null-identity")).payload).toEqual({
    identityId: null,
    items: [],
  });
});

it("GET与清单外skip仍在prepare原协议应答，零投影、零事务", async () => {
  const sample = createSampleEvents(prisma);
  const projection = vi.fn(async () => ({}));
  const run = vi.spyOn(sample.tx, "run");
  const hooks = createWebhooks({
    ...sample,
    sources: [
      projected(projection, {
        verify: async (request) =>
          request.method === "GET"
            ? { kind: "reply", status: 200, body: "challenge" }
            : {
                kind: "skip",
                reason: "unregistered_event",
                reply: { kind: "reply", status: 200, body: "success" },
              },
      }),
    ],
  });
  for (const method of ["GET", "POST"])
    expect(
      await hooks.prepare("wecom", {
        method,
        headers: {},
        rawBody: new Uint8Array(),
        operationId: "lyxtest.projection",
      }),
    ).toMatchObject({ status: 200, body: method === "GET" ? "challenge" : "success" });
  expect(projection).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});

it("投影后emit异常使收件回滚，不保存投影、错误或失败attempts", async () => {
  const sample = createSampleEvents(prisma);
  const emit = vi.fn(async () => {
    throw new Error("fixture-private-openid");
  });
  const hooks = createWebhooks({
    ...sample,
    events: { emit },
    sources: [projected(async () => ({ identityId: "safe" }))],
  });
  expect(await hooks.accept(await prepare(hooks, "emit-rollback"), ctx)).toMatchObject({
    status: 500,
    body: "failure:WEBHOOK_PERSIST_FAILED",
  });
  expect(emit).toHaveBeenCalledOnce();
  expect(await prisma.webhookEvent.count({ where: { eventId: "emit-rollback" } })).toBe(0);
});

it("真实COMMIT失败使投影后的收件和出站整体回滚", async () => {
  const sample = createSampleEvents(prisma);
  let emitted = false;
  let dedupeKey = "";
  const hooks = createWebhooks({
    ...sample,
    sources: [projected(async () => ({ identityId: "safe" }))],
    events: {
      emit: async (tx, ...args) => {
        const row = await sample.events.emit(tx, ...args);
        dedupeKey = args[1].dedupeKey!;
        await tx.$executeRawUnsafe("INSERT INTO lyx_probe_projection_commit VALUES(2,1)");
        emitted = true;
        return row;
      },
    },
  });
  expect(await hooks.accept(await prepare(hooks, "commit-rollback"), ctx)).toMatchObject({
    status: 500,
    body: "failure:WEBHOOK_PERSIST_FAILED",
  });
  expect(emitted).toBe(true);
  expect(await prisma.webhookEvent.count({ where: { eventId: "commit-rollback" } })).toBe(0);
  expect(dedupeKey).toMatch(/^webhook\.received:/);
  expect(await prisma.outboxEvent.count({ where: { dedupeKey } })).toBe(0);
});

it("真实40001重试重新投影和clone，回滚输出不缓存、不污染原验签快照", async () => {
  const sample = createSampleEvents(prisma);
  const values: unknown[] = [];
  const txids: string[] = [];
  const hooks = createWebhooks({
    ...sample,
    sources: [
      projected(async (tx, event) => {
        values.push(event.data);
        txids.push(
          (await tx.$queryRawUnsafe<Array<{ id: string }>>("SELECT txid_current()::text AS id"))[0]!
            .id,
        );
        (event as { data: string }).data = "mutated";
        if (values.length === 1)
          await tx.$executeRawUnsafe(
            "DO $$ BEGIN RAISE EXCEPTION 'fixture retry' USING ERRCODE='40001'; END $$",
          );
        return { identityId: `attempt-${values.length}` };
      }),
    ],
  });
  const receipt = await prepare(hooks, "projection-retry");
  expect(await hooks.accept(receipt, ctx)).toMatchObject({ status: 200 });
  expect(values).toEqual(["known", "known"]);
  expect(new Set(txids).size).toBe(2);
  const row = await stored("projection-retry");
  expect(row).toMatchObject({ payload: { identityId: "attempt-2" }, attempts: 0, error: null });
  expect(
    await prisma.outboxEvent.count({ where: { dedupeKey: `webhook.received:${row.id}` } }),
  ).toBe(1);
});

it("双连接20次重放仅一收件/一出站；后续投影不覆盖首次payload或举证", async () => {
  const sample = createSampleEvents(prisma);
  let identityId = "first";
  const input = projected(async () => ({ identityId }));
  const left = createWebhooks({ ...sample, sources: [input] });
  const right = createWebhooks({
    ...sample,
    tx: createTxRunner({ prisma: second, appEnv: "test" }),
    sources: [input],
  });
  const responses = await Promise.all(
    Array.from({ length: 20 }, async (_, i) => {
      const hooks = i % 2 ? left : right;
      return hooks.accept(await prepare(hooks, "projection-duplicate"), ctx);
    }),
  );
  expect(responses.every((reply) => reply.status === 200)).toBe(true);
  const before = await stored("projection-duplicate");
  expect(before.payload).toEqual({ identityId: "first" });
  identityId = "second";
  sample.clock.advance(5000);
  await left.accept(await prepare(left, "projection-duplicate"), ctx);
  expect(await stored("projection-duplicate")).toEqual(before);
  expect(await prisma.webhookEvent.count({ where: { eventId: "projection-duplicate" } })).toBe(1);
  expect(
    await prisma.outboxEvent.count({ where: { dedupeKey: `webhook.received:${before.id}` } }),
  ).toBe(1);
});

it("投影已经返回后真实40001使整TX重跑，不复用回滚载荷或重复出站", async () => {
  const sample = createSampleEvents(prisma);
  let projectedCount = 0;
  let emittedCount = 0;
  const hooks = createWebhooks({
    ...sample,
    sources: [
      projected(async (tx) => {
        await tx.$queryRawUnsafe("SELECT 1");
        projectedCount++;
        return { identityId: `projection-${projectedCount}` };
      }),
    ],
    events: {
      emit: async (tx, ...args) => {
        const row = await sample.events.emit(tx, ...args);
        emittedCount++;
        if (emittedCount === 1)
          await tx.$executeRawUnsafe(
            "DO $$ BEGIN RAISE EXCEPTION 'fixture retry after output' USING ERRCODE='40001'; END $$",
          );
        return row;
      },
    },
  });
  expect(
    await hooks.accept(await prepare(hooks, "projection-retry-after-output"), ctx),
  ).toMatchObject({ status: 200 });
  expect(projectedCount).toBe(2);
  expect(emittedCount).toBe(2);
  const row = await stored("projection-retry-after-output");
  expect(row).toMatchObject({ payload: { identityId: "projection-2" }, attempts: 0, error: null });
  expect(
    await prisma.outboxEvent.count({ where: { dedupeKey: `webhook.received:${row.id}` } }),
  ).toBe(1);
});

it("投影不能nested tx或Provider外呼；真实guard拒绝且无调用记录", async () => {
  const sample = createSampleEvents(prisma);
  const fakes = createFakeProviders();
  for (const [eventId, projection] of [
    [
      "projection-nested",
      async () => {
        await sample.tx.run(async () => {});
        return {};
      },
    ],
    [
      "projection-provider",
      async () => {
        await fakes.wechat.code2Session({ code: "private" });
        return {};
      },
    ],
  ] as const) {
    const hooks = createWebhooks({ ...sample, sources: [projected(projection)] });
    expect(await hooks.accept(await prepare(hooks, eventId), ctx)).toMatchObject({
      status: 500,
      body: "failure:WEBHOOK_PERSIST_FAILED",
    });
    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(0);
  }
  expect(fakes.wechat.calls).toHaveLength(0);
});
