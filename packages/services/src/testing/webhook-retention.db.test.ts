// 组合验收在testing层，只用两个域的公开出口；security不向上引ops。
import { it, expect } from "vitest";
import { createWebhooks, bindWebhooks } from "../security/index.js";
import type { WebhookSource } from "../security/index.js";
import { runRetention } from "../ops/index.js";
import { createSampleEvents, sampleSystemContext, useTestDatabase } from "./index.js";
const db = useTestDatabase("services");
it("实际ops.retention只在日首轮调用security清理：payload UPDATE后summary/行/digest举证全保留", async () => {
  const prisma = await db.prisma(),
    sample = createSampleEvents(prisma);
  const source: WebhookSource = {
    provider: "wecom",
    mode: "inline",
    verify: async () => ({
      kind: "event",
      event: { eventId: "retention-assembly", eventType: "fixture.received", data: null },
    }),
    payload: () => ({ summary: { event: "known" }, minimum: "erase-after-retention" }),
    restore: async () => null,
    handle: async () => "processed",
    reply: (ok) => ({ kind: "reply", status: ok ? 200 : 500, body: ok ? "success" : "failure" }),
  };
  const hooks = createWebhooks({ ...sample, sources: [source] }),
    unbind = bindWebhooks(hooks);
  try {
    const receipt = await hooks.prepare("wecom", {
      method: "POST",
      operationId: "lyxtest.retention",
      headers: {},
      rawBody: Buffer.from("verified-fixture"),
    });
    if (receipt.kind !== "ready") throw new Error("fixture rejected");
    await hooks.accept(receipt, sampleSystemContext());
    const before = await prisma.webhookEvent.findFirstOrThrow({
      where: { eventId: "retention-assembly" },
    });
    sample.clock.advance(90 * 86_400_000);
    const deps = {
      assembly: {
        cleanups: sample.assembly.cleanups.filter((c) => c.name === "security.webhook_payload"),
      },
      clock: sample.clock,
      alerts: { raise: async () => {} },
    };
    expect(
      await sample.tx.run((tx) =>
        runRetention(tx, deps, { scheduledFor: new Date("2026-04-05T17:00:00Z") }),
      ),
    ).toEqual({ daily: false, rows: {}, failed: {} });
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: before.id } })).toEqual(
      before,
    );
    expect(
      await sample.tx.run((tx) =>
        runRetention(tx, deps, { scheduledFor: new Date("2026-04-05T16:00:00Z"), limit: 1 }),
      ),
    ).toEqual({ daily: true, rows: { "security.webhook_payload": 1 }, failed: {} });
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: before.id } })).toEqual({
      ...before,
      payload: { summary: { event: "known" } },
      payloadPurgedAt: sample.clock.now(),
      updatedAt: sample.clock.now(),
    });
  } finally {
    unbind();
  }
}, 120_000);
