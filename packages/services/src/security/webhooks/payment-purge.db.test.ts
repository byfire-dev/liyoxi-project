import { it, expect } from "vitest";
import { createSampleEvents, sampleSystemContext, useTestDatabase } from "../../testing/index.js";
import { createWebhooks, bindWebhooks } from "../index.js";
import { count, prepare, source, write } from "./__fixtures__/source.js";
import type { WebhookPayload } from "../index.js";
const db = useTestDatabase("services"),
  DAY = 86_400_000;
const paymentPayload: WebhookPayload = {
  summary: { serial: "fake-serial", outTradeNo: "fake-order", state: "SUCCESS", amountFen: 100 },
  resourceCipher: {
    algorithm: "AEAD_AES_256_GCM",
    ciphertext: "fake-encrypted",
    nonce: "fake-nonce",
    associated_data: "",
  },
};
it("支付失败独立兜底保留密文/kid，首失败时钟与收件时钟独立，复读密文重放后180天仅留summary", async () => {
  const prisma = await db.prisma(),
    sample = createSampleEvents(prisma);
  let broken = true,
    restored = false;
  const hooks = createWebhooks({
    ...sample,
    sources: [
      source("WY", {
        provider: "wechatpay",
        mode: "inline",
        fallbackToInbox: true,
        escalateAfter: 5,
        payload: () => paymentPayload,
        restore: async (row) => {
          expect(row.keyVersion).toBe("fixture-kid");
          expect(row.payload).toEqual(paymentPayload);
          restored = true;
          return "local-decrypted-fixture";
        },
        handle: async (tx, event) => {
          await write(tx, "WY");
          if (broken) {
            sample.clock.advance(7000);
            throw new Error("decrypted secret payer");
          }
          expect(event.data).toBe("local-decrypted-fixture");
          return "processed";
        },
      }),
    ],
  });
  const at = sample.clock.now(),
    id = "payment-fallback";
  expect(
    (
      await hooks.accept(
        await prepare(hooks, id, "wechatpay", { keyVersion: "fixture-kid" }),
        sampleSystemContext(),
      )
    ).status,
  ).toBe(200);
  const failed = await prisma.webhookEvent.findFirstOrThrow({ where: { eventId: id } });
  expect(failed).toMatchObject({
    mode: "inbox",
    processState: "failed",
    attempts: 1,
    receivedAt: at,
    error: "WEBHOOK_HANDLER_FAILED",
    processedAt: null,
    nextAttemptAt: new Date(at.getTime() + 67000),
    updatedAt: new Date(at.getTime() + 7000),
    payload: paymentPayload,
    payloadPurgeAt: new Date(at.getTime() + 180 * DAY),
  });
  expect(await count(prisma, "WY")).toBe(0);
  broken = false;
  sample.clock.advance(60000);
  expect(await hooks.scan()).toBe(1);
  expect(restored).toBe(true);
  expect(await count(prisma, "WY")).toBe(1);
  const processed = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: failed.id } });
  const unbind = bindWebhooks(hooks);
  try {
    sample.clock.set(new Date(at.getTime() + 180 * DAY - 1));
    expect(
      await sample.tx.run((tx) => hooks.purge(tx, { now: sample.clock.now(), limit: 1 })),
    ).toBe(0);
    sample.clock.advance(1);
    const cleanup = sample.assembly.cleanups.find((c) => c.name === "security.webhook_payload")!;
    expect(cleanup.every).toBe("day");
    expect(
      await sample.tx.run((tx) => cleanup.run(tx, { now: sample.clock.now(), limit: 1 })),
    ).toBe(1);
    const purged = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: failed.id } });
    expect(purged).toEqual({
      ...processed,
      payload: { summary: paymentPayload["summary"] },
      payloadPurgedAt: sample.clock.now(),
      updatedAt: sample.clock.now(),
    });
    expect(
      await sample.tx.run((tx) => hooks.purge(tx, { now: sample.clock.now(), limit: 1 })),
    ).toBe(0);
  } finally {
    unbind();
  }
}, 120_000);

it("支付null/缺密文/缺kid在TX前拒绝；其他inbox-null也拒绝；CI/ASR inline null合法", async () => {
  const prisma = await db.prisma(),
    sample = createSampleEvents(prisma);
  const before = await prisma.webhookEvent.count();
  for (const [payload, keyVersion] of [
    [null, "fixture-kid"],
    [{ summary: {} }, "fixture-kid"],
    [paymentPayload, undefined],
  ] as const) {
    const hooks = createWebhooks({
      ...sample,
      tx: {
        run: async () => {
          throw new Error("不得进入TX");
        },
      },
      sources: [
        source("WN", {
          provider: "wechatpay",
          mode: "inline",
          fallbackToInbox: true,
          payload: () => payload,
        }),
      ],
    });
    expect(
      await hooks.accept(
        await prepare(
          hooks,
          "invalid-payment",
          "wechatpay",
          keyVersion === undefined ? {} : { keyVersion },
        ),
        sampleSystemContext(),
      ),
    ).toMatchObject({ status: 500, body: "failure:WEBHOOK_PAYLOAD_INVALID" });
  }
  const invalid = createWebhooks({ ...sample, sources: [source("WN", { payload: () => null })] });
  expect(
    (await invalid.accept(await prepare(invalid, "invalid-inbox"), sampleSystemContext())).status,
  ).toBe(500);
  expect(await prisma.webhookEvent.count()).toBe(before);
  for (const provider of ["ci", "asr"] as const) {
    const hooks = createWebhooks({
      ...sample,
      sources: [
        source("WZ", {
          provider,
          mode: "inline",
          payload: () => null,
          handle: async (_tx, event) => {
            expect(event.data).toBeNull();
            return "processed";
          },
        }),
      ],
    });
    expect(
      (
        await hooks.accept(
          await prepare(hooks, `null-${provider}`, provider, { data: null }),
          sampleSystemContext(),
        )
      ).status,
    ).toBe(200);
    expect(
      await prisma.webhookEvent.findFirstOrThrow({
        where: { provider, eventId: `null-${provider}` },
      }),
    ).toMatchObject({ payload: null, payloadPurgeAt: null, processState: "processed" });
  }
}, 120_000);

it("90天到期按实际now批量UPDATE；失败外围TX保留原文举证，不删行；支付PII由冻结约束拒绝", async () => {
  const prisma = await db.prisma(),
    sample = createSampleEvents(prisma);
  const hooks = createWebhooks({ ...sample, sources: [source("WX", { mode: "inline" })] });
  const ids = ["purge90-a", "purge90-b"];
  for (const id of ids) await hooks.accept(await prepare(hooks, id), sampleSystemContext());
  const original = await prisma.webhookEvent.findMany({
    where: { eventId: { in: ids } },
    orderBy: { id: "asc" },
  });
  sample.clock.advance(90 * DAY - 1);
  expect(await sample.tx.run((tx) => hooks.purge(tx, { now: sample.clock.now(), limit: 1 }))).toBe(
    0,
  );
  sample.clock.advance(1);
  await expect(
    sample.tx.run(async (tx) => {
      expect(await hooks.purge(tx, { now: sample.clock.now(), limit: 1 })).toBe(1);
      throw new Error("commit prevented");
    }),
  ).rejects.toThrow("commit prevented");
  expect(
    await prisma.webhookEvent.findMany({ where: { eventId: { in: ids } }, orderBy: { id: "asc" } }),
  ).toEqual(original);
  expect(await sample.tx.run((tx) => hooks.purge(tx, { now: sample.clock.now(), limit: 1 }))).toBe(
    1,
  );
  expect(
    await prisma.webhookEvent.count({
      where: { eventId: { in: ids }, payloadPurgedAt: sample.clock.now() },
    }),
  ).toBe(1);
  expect(await sample.tx.run((tx) => hooks.purge(tx, { now: sample.clock.now(), limit: 1 }))).toBe(
    1,
  );
  expect(
    await prisma.webhookEvent.findMany({ where: { eventId: { in: ids } }, orderBy: { id: "asc" } }),
  ).toEqual(
    original.map((row) => ({
      ...row,
      payload: null,
      payloadPurgedAt: sample.clock.now(),
      updatedAt: sample.clock.now(),
    })),
  );
  const payment = createWebhooks({
    ...sample,
    sources: [
      source("WX", {
        provider: "wechatpay",
        mode: "inline",
        payload: () => ({ summary: { nested: { OPENID: "secret" } } }),
      }),
    ],
  });
  expect(
    (
      await payment.accept(
        await prepare(payment, "forbidden-payer", "wechatpay"),
        sampleSystemContext(),
      )
    ).status,
  ).toBe(500);
  expect(await prisma.webhookEvent.count({ where: { eventId: "forbidden-payer" } })).toBe(0);
}, 120_000);

it("支付重复失败推进原inbox失败行到dead，举证列不改；第5次告警端口失败仍准确ACK", async () => {
  const prisma = await db.prisma(),
    sample = createSampleEvents(prisma),
    alerts: unknown[] = [];
  let calls = 0;
  const hooks = createWebhooks({
    ...sample,
    alerts: {
      raise: async (input) => {
        alerts.push(input);
        throw new Error("fake alert unavailable");
      },
    },
    sources: [
      source("WDD", {
        provider: "wechatpay",
        mode: "inline",
        fallbackToInbox: true,
        payload: () => paymentPayload,
        handle: async (tx) => {
          calls++;
          await write(tx, "WDD");
          throw new Error("handler failure");
        },
      }),
    ],
  });
  let first: Awaited<ReturnType<typeof prisma.webhookEvent.findFirstOrThrow>> | undefined;
  for (let i = 1; i <= 8; i++) {
    expect(
      (
        await hooks.accept(
          await prepare(hooks, "payment-repeat", "wechatpay", { keyVersion: "fixture-kid" }),
          sampleSystemContext(),
        )
      ).status,
    ).toBe(200);
    const row = await prisma.webhookEvent.findFirstOrThrow({
      where: { eventId: "payment-repeat" },
    });
    first ??= row;
    expect(row).toMatchObject({
      id: first.id,
      mode: "inbox",
      attempts: i,
      processState: i === 8 ? "dead" : "failed",
      receivedAt: first.receivedAt,
      payloadDigest: first.payloadDigest,
    });
    expect(await count(prisma, "WDD")).toBe(0);
    sample.clock.advance(1000);
  }
  expect(alerts).toEqual([
    {
      rule: "webhook.failing",
      dimension: first!.id,
      severity: "P1",
      detail: { provider: "wechatpay", attempts: 5 },
    },
    {
      rule: "webhook.dead",
      dimension: first!.id,
      severity: "P1",
      detail: { provider: "wechatpay", attempts: 8 },
    },
  ]);
  const dead = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: first!.id } });
  expect(
    (
      await hooks.accept(
        await prepare(hooks, "payment-repeat", "wechatpay", { keyVersion: "fixture-kid" }),
        sampleSystemContext(),
      )
    ).status,
  ).toBe(200);
  expect(calls).toBe(8);
  expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: first!.id } })).toEqual(dead);
}, 120_000);
