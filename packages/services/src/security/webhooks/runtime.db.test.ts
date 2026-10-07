import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "@liyoxi/db";
import { createTxRunner, uuidv7 } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { createSampleEvents, sampleSystemContext, useTestDatabase } from "../../testing/index.js";
import type { SampleEvents } from "../../testing/index.js";
import { createWebhooks } from "../index.js";
import type { PreparedWebhook, VerifiedWebhook, WebhookRequest, WebhookSource } from "../index.js";

const database = useTestDatabase("services");
let prisma: PrismaClient;
let second: PrismaClient;
let sample: SampleEvents;
const ctx = sampleSystemContext("lyxtest.webhook");
const request = (eventId: string): WebhookRequest => ({
  method: "POST",
  operationId: "lyxtest.webhook",
  headers: {},
  rawBody: Buffer.from(JSON.stringify({ eventId, eventType: "fixture.received", data: "known" })),
});
const write = (tx: Tx, prefix: string) =>
  tx.bizSequence.upsert({
    where: { prefix_bizDate: { prefix, bizDate: new Date("2026-01-05") } },
    create: { prefix, bizDate: new Date("2026-01-05"), nextVal: 1 },
    update: { nextVal: { increment: 1 } },
  });
const source = (prefix: string, overrides: Partial<WebhookSource> = {}): WebhookSource => ({
  provider: "wecom",
  mode: "inline",
  verify: async (input) => ({
    kind: "event",
    event: JSON.parse(Buffer.from(input.rawBody).toString()) as VerifiedWebhook,
  }),
  payload: (event) => ({ value: event.data }),
  restore: async (row) => row.payload?.["value"] ?? null,
  handle: async (tx) => {
    await write(tx, prefix);
    return "processed";
  },
  reply: (ok) => ({ kind: "reply", status: ok ? 200 : 500, body: ok ? "success" : "failure" }),
  ...overrides,
});
const ready = async (hooks: ReturnType<typeof createWebhooks>, id: string) => {
  const receipt = await hooks.prepare("wecom", request(id));
  if (receipt.kind !== "ready") throw new Error("fixture 验证失败");
  return receipt;
};
const stored = (provider: string, eventId: string) =>
  prisma.webhookEvent.findUniqueOrThrow({ where: { provider_eventId: { provider, eventId } } });

beforeAll(async () => {
  prisma = await database.prisma();
  second = createPrismaClient({ connectionString: await database.url(), max: 1 });
  sample = createSampleEvents(prisma);
}, 120_000);
afterAll(async () => second?.$disconnect());

describe("回调两模式：真实冻结表与领域事务", () => {
  it("inline 同ID并发20次只提交一份领域事实，重复原文不改变举证列", async () => {
    const input = source("WA");
    const left = createWebhooks({ ...sample, sources: [input] });
    const right = createWebhooks({
      ...sample,
      tx: createTxRunner({ prisma: second, appEnv: "test" }),
      sources: [input],
    });
    const id = uuidv7();
    const responses = await Promise.all(
      Array.from({ length: 20 }, async (_, i) => {
        const hooks = i % 2 ? left : right;
        return hooks.accept(await ready(hooks, id), ctx);
      }),
    );
    expect(responses.every((reply) => reply.status === 200)).toBe(true);
    expect(await prisma.webhookEvent.count({ where: { provider: "wecom", eventId: id } })).toBe(1);
    expect((await prisma.bizSequence.findFirstOrThrow({ where: { prefix: "WA" } })).nextVal).toBe(
      1,
    );
    const before = await stored("wecom", id);
    sample.clock.advance(5000);
    await left.accept(await ready(left, id), ctx);
    expect(await stored("wecom", id)).toEqual(before);
  });

  it("inline 在领域写后抛错，收件和领域写全部回滚且协议失败", async () => {
    const hooks = createWebhooks({
      ...sample,
      sources: [
        source("WB", {
          handle: async (tx) => {
            await write(tx, "WB");
            throw new Error("sensitive raw token");
          },
        }),
      ],
    });
    const id = uuidv7();
    expect((await hooks.accept(await ready(hooks, id), ctx)).status).toBe(500);
    expect(await prisma.webhookEvent.count({ where: { eventId: id } })).toBe(0);
    expect(await prisma.bizSequence.count({ where: { prefix: "WB" } })).toBe(0);
  });

  it("inbox 先原子落收件+出站事实，不执行领域；不派发唤醒也可由扫描处理", async () => {
    const hooks = createWebhooks({ ...sample, sources: [source("WC", { mode: "inbox" })] });
    const id = uuidv7();
    expect((await hooks.accept(await ready(hooks, id), ctx)).status).toBe(200);
    const row = await stored("wecom", id);
    expect(row).toMatchObject({
      processState: "received",
      attempts: 0,
      nextAttemptAt: sample.clock.now(),
      processedAt: null,
    });
    expect(await prisma.bizSequence.count({ where: { prefix: "WC" } })).toBe(0);
    expect(
      await prisma.outboxEvent.count({ where: { dedupeKey: `webhook.received:${row.id}` } }),
    ).toBe(1);
    await hooks.accept(await ready(hooks, id), ctx);
    expect(
      await prisma.outboxEvent.count({ where: { dedupeKey: `webhook.received:${row.id}` } }),
    ).toBe(1);
    await hooks.scan();
    expect((await stored("wecom", id)).processState).toBe("processed");
    expect((await prisma.bizSequence.findFirstOrThrow({ where: { prefix: "WC" } })).nextVal).toBe(
      1,
    );
  });

  it("领域保存点回滚后失败记录提交；到期前不重做、到期后成功，不留下敏感摘要", async () => {
    let broken = true;
    const hooks = createWebhooks({
      ...sample,
      sources: [
        source("WD", {
          mode: "inbox",
          handle: async (tx) => {
            await write(tx, "WD");
            if (broken) throw new Error("secret body payer");
            return "processed";
          },
        }),
      ],
    });
    const id = uuidv7();
    await hooks.accept(await ready(hooks, id), ctx);
    const row = await stored("wecom", id);
    await sample.tx.run((tx) => hooks.process(tx, row.id, ctx));
    expect(await stored("wecom", id)).toMatchObject({
      processState: "failed",
      attempts: 1,
      error: "WEBHOOK_HANDLER_FAILED",
      nextAttemptAt: new Date(sample.clock.now().getTime() + 60_000),
    });
    expect(await prisma.bizSequence.count({ where: { prefix: "WD" } })).toBe(0);
    broken = false;
    await sample.tx.run((tx) => hooks.process(tx, row.id, ctx));
    expect((await stored("wecom", id)).attempts).toBe(1);
    sample.clock.advance(60_000);
    await sample.tx.run((tx) => hooks.process(tx, row.id, ctx));
    expect(await stored("wecom", id)).toMatchObject({
      processState: "processed",
      attempts: 1,
      error: null,
      nextAttemptAt: null,
    });
    expect((await prisma.bizSequence.findFirstOrThrow({ where: { prefix: "WD" } })).nextVal).toBe(
      1,
    );
  });

  it("外层事务最终失败，不能声称失败记录已经提交", async () => {
    const hooks = createWebhooks({
      ...sample,
      sources: [
        source("WE", {
          mode: "inbox",
          handle: async (tx) => {
            await write(tx, "WE");
            throw new Error("handler failed");
          },
        }),
      ],
    });
    const id = uuidv7();
    await hooks.accept(await ready(hooks, id), ctx);
    const row = await stored("wecom", id);
    await expect(
      sample.tx.run(async (tx) => {
        await hooks.process(tx, row.id, ctx);
        throw new Error("outer failure");
      }),
    ).rejects.toThrow("outer failure");
    expect(await stored("wecom", id)).toMatchObject({
      processState: "received",
      attempts: 0,
      error: null,
    });
    expect(await prisma.bizSequence.count({ where: { prefix: "WE" } })).toBe(0);
  });

  it("inbox 出站写失败时收件行也必须回滚", async () => {
    const hooks = createWebhooks({
      ...sample,
      sources: [source("WF", { mode: "inbox" })],
      events: {
        emit: async () => {
          throw new Error("event failure");
        },
      },
    });
    const id = uuidv7();
    expect((await hooks.accept(await ready(hooks, id), ctx)).status).toBe(500);
    expect(await prisma.webhookEvent.count({ where: { eventId: id } })).toBe(0);
  });

  it("伪造prepared结果与未注册/不合法兜底均拒绝，零收件写", async () => {
    const hooks = createWebhooks({ ...sample, sources: [source("WG")] });
    await expect(hooks.prepare("unregistered", request(uuidv7()))).rejects.toMatchObject({
      error: "WEBHOOK_SOURCE_DISABLED",
    });
    const fake = { ...(await ready(hooks, uuidv7())) } as PreparedWebhook;
    await expect(hooks.accept(fake, ctx)).rejects.toThrow("本实例验签");
    expect(() =>
      createWebhooks({ ...sample, sources: [source("WG", { fallbackToInbox: true })] }),
    ).toThrow("只有支付");
    expect(await prisma.bizSequence.count({ where: { prefix: "WG" } })).toBe(0);
  });
  it("prepared私有快照隔离调用者原文/验证器结果的后续修改", async () => {
    const event: VerifiedWebhook = {
      eventId: "opaque-facts",
      eventType: "fixture.received",
      data: { value: "before" },
    };
    const hooks = createWebhooks({
      ...sample,
      sources: [
        source("WV", {
          verify: async () => ({ kind: "event", event }),
          handle: async (tx, input) => {
            expect(input.data).toEqual({ value: "before" });
            await write(tx, "WV");
            return "processed";
          },
        }),
      ],
    });
    const input = request("caller-input"),
      raw = Buffer.from(input.rawBody);
    const prepared = await hooks.prepare("wecom", input);
    if (prepared.kind !== "ready") throw new Error("fixture rejected");
    input.rawBody.fill(0);
    (event as { eventId: string }).eventId = "changed-id";
    (event.data as { value: string }).value = "after";
    expect((await hooks.accept(prepared, ctx)).status).toBe(200);
    const row = await stored("wecom", "opaque-facts");
    expect(row.payload).toEqual({ value: { value: "before" } });
    expect(Buffer.from(row.payloadDigest)).toEqual(
      (await import("node:crypto")).createHash("sha256").update(raw).digest(),
    );
    expect(await prisma.webhookEvent.count({ where: { eventId: "changed-id" } })).toBe(0);
  });
});
