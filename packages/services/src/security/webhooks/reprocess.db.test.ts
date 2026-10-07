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
  const unknown = createWebhooks({ ...sample });
  expect(await unknown.scan()).toBe(1);
  expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: pending.id } })).toEqual(
    pending,
  );
  enabled = false;
  expect(await recovery.scan()).toBe(1);
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
