import { it, expect } from "vitest";
import { createSampleEvents, sampleSystemContext, useTestDatabase } from "../../testing/index.js";
import { createWebhooks } from "../index.js";
import { count, prepare, source, write } from "./__fixtures__/source.js";
const db = useTestDatabase("services");
it("五档退避精确边界/5次升级/8次dead；未知来源停用不吞收件，恢复后可忽略", async () => {
  const prisma = await db.prisma(),
    sample = createSampleEvents(prisma),
    alerts: unknown[] = [];
  const id = "backoff-8",
    hooks = createWebhooks({
      ...sample,
      sources: [
        source("WR", {
          escalateAfter: 5,
          handle: async (tx) => {
            await write(tx, "WR");
            throw new Error("secret payer/raw body");
          },
        }),
      ],
      alerts: {
        raise: async (input) => {
          alerts.push(input);
        },
      },
    });
  await hooks.accept(await prepare(hooks, id), sampleSystemContext());
  const original = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: id } });
  const delays = [60_000, 300_000, 900_000, 3_600_000, 21_600_000, 21_600_000, 21_600_000];
  for (let attempt = 1; attempt <= 8; attempt++) {
    const at = sample.clock.now();
    expect(await hooks.scan()).toBe(1);
    const row = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: original.id } });
    expect(row).toMatchObject({
      attempts: attempt,
      processState: attempt === 8 ? "dead" : "failed",
      error: "WEBHOOK_HANDLER_FAILED",
      processedAt: null,
    });
    expect(await count(prisma, "WR")).toBe(0);
    if (attempt < 8) {
      expect(row.nextAttemptAt).toEqual(new Date(at.getTime() + delays[attempt - 1]!));
      sample.clock.advance(delays[attempt - 1]! - 1);
      expect(await hooks.scan()).toBe(0);
      sample.clock.advance(1);
    } else expect(row.nextAttemptAt).toBeNull();
  }
  expect(alerts).toEqual([
    {
      rule: "webhook.failing",
      dimension: original.id,
      severity: "P1",
      detail: { provider: "wecom", attempts: 5 },
    },
    {
      rule: "webhook.dead",
      dimension: original.id,
      severity: "P1",
      detail: { provider: "wecom", attempts: 8 },
    },
  ]);
  expect(await hooks.scan()).toBe(0);
  const dead = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: original.id } });
  expect((await hooks.accept(await prepare(hooks, id), sampleSystemContext())).status).toBe(200);
  expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: original.id } })).toEqual(dead);
  let enabled = true;
  const recovery = createWebhooks({
    ...sample,
    sources: [source("WU", { enabled: () => enabled, handle: async () => "ignored" })],
  });
  await recovery.accept(await prepare(recovery, "unknown-until-rebound"), sampleSystemContext());
  const pending = await prisma.webhookEvent.findFirstOrThrow({
    where: { eventId: "unknown-until-rebound" },
  });
  const unknown = createWebhooks({
    ...sample,
    tx: {
      run: async () => {
        throw new Error("empty registry must not enter TX");
      },
    },
  });
  expect(await unknown.scan()).toBe(0);
  expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(
    pending,
  );
  enabled = false;
  expect(await recovery.scan()).toBe(0);
  expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(
    pending,
  );
  enabled = true;
  expect(await recovery.scan()).toBe(1);
  expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({
    processState: "ignored",
    processedAt: sample.clock.now(),
    attempts: 0,
  });
}, 120_000);

it.each(["unregistered", "disabled"] as const)(
  "50条更早%s来源不占领取额度，后方inline支付兜底失去wake仍处理；恢复后原50条可回放",
  async (caseName) => {
    const prisma = await db.prisma(),
      sample = createSampleEvents(prisma);
    const beforeCount = await count(prisma, "WSA");
    let enabled = true,
      failing = true;
    const blocked = source("WSB", { enabled: () => enabled, handle: async () => "ignored" });
    const payment = source("WSA", {
      provider: "wechatpay",
      mode: "inline",
      fallbackToInbox: true,
      payload: () => ({
        summary: { serial: "fake", state: "SUCCESS", amountFen: 1 },
        resourceCipher: { ciphertext: "fake", nonce: "fake", associated_data: "" },
      }),
      restore: async () => "local-decrypted-fixture",
      handle: async (tx) => {
        await write(tx, "WSA");
        if (failing) throw new Error("fixture first inline failure");
        return "processed";
      },
    });
    const seed = createWebhooks({ ...sample, sources: [blocked, payment] });
    const blockedIds = Array.from({ length: 50 }, (_, i) => `${caseName}-blocked-${i}`);
    for (const id of blockedIds) {
      expect((await seed.accept(await prepare(seed, id), sampleSystemContext())).status).toBe(200);
      sample.clock.advance(1);
    }
    const paymentId = `${caseName}-payment-fallback`;
    expect(
      (
        await seed.accept(
          await prepare(seed, paymentId, "wechatpay", { keyVersion: "fixture-kid" }),
          sampleSystemContext(),
        )
      ).status,
    ).toBe(200);
    const original = await prisma.webhookEvent.findMany({
      where: { eventId: { in: blockedIds } },
      orderBy: { id: "asc" },
    });
    expect(original).toHaveLength(50);
    expect(
      await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: paymentId } }),
    ).toMatchObject({ mode: "inbox", processState: "failed", attempts: 1 });
    expect(await count(prisma, "WSA")).toBe(beforeCount);
    enabled = false;
    failing = false;
    sample.clock.advance(60_000);
    const consumer = createWebhooks({
      ...sample,
      sources: caseName === "unregistered" ? [payment] : [blocked, payment],
    });
    expect(await consumer.scan()).toBe(1);
    expect(await consumer.scan()).toBe(0);
    expect(
      await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: paymentId } }),
    ).toMatchObject({ processState: "processed", attempts: 1 });
    expect(await count(prisma, "WSA")).toBe(beforeCount + 1);
    expect(
      await prisma.webhookEvent.findMany({
        where: { eventId: { in: blockedIds } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(original);
    // 新注册或重新启用均重新进入领取集合，保留的50条仍完整可处理。
    enabled = true;
    const restored = createWebhooks({ ...sample, sources: [blocked, payment] });
    expect(await restored.scan()).toBe(50);
    expect(await restored.scan()).toBe(0);
    expect(
      await prisma.webhookEvent.count({
        where: { eventId: { in: blockedIds }, processState: "ignored" },
      }),
    ).toBe(50);
  },
  120_000,
);
