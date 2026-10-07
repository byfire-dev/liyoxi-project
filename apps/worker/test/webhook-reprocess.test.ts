import { it, expect } from "vitest";
import { buildWorkerServices, createQueueChannel, security } from "@liyoxi/services";
import {
  createSampleEvents,
  createProviderHarness,
  sampleSystemContext,
  useTestDatabase,
  useTestRedis,
} from "@liyoxi/services/testing";
import { createWorkerRuntime } from "../src/runtime.js";
import { DOMAIN_LOOPS } from "../src/domain-loops.js";
import { silentLogger } from "../src/log.js";
const db = useTestDatabase("worker"),
  redis = useTestRedis();
it("真实worker subscriber消费既有TX：失败领域回滚而收件可扫描恢复，关停等在途后解绑", async () => {
  const prisma = await db.prisma(),
    sample = createSampleEvents(prisma, { registrations: [] });
  await redis.flush();
  const channel = createQueueChannel({
    redisUrl: process.env.REDIS_URL!,
    prefix: `${redis.prefix}bull`,
  });
  const providers = createProviderHarness({ clock: sample.clock }).providers;
  let broken = false,
    hold = false,
    entered!: () => void,
    release!: () => void;
  const waiting = new Promise<void>((r) => {
      entered = r;
    }),
    released = new Promise<void>((r) => {
      release = r;
    });
  const source: security.WebhookSource = {
    provider: "wecom",
    mode: "inbox",
    verify: async (input) => ({
      kind: "event",
      event: {
        eventId: Buffer.from(input.rawBody).toString(),
        eventType: "fixture.received",
        data: "known",
      },
    }),
    payload: (event) => ({ value: event.data }),
    restore: async (row) => row.payload?.["value"] ?? null,
    handle: async (tx) => {
      if (hold) {
        entered();
        await released;
      }
      await tx.bizSequence.upsert({
        where: { prefix_bizDate: { prefix: "WW", bizDate: new Date("2026-01-05") } },
        create: { prefix: "WW", bizDate: new Date("2026-01-05"), nextVal: 1 },
        update: { nextVal: { increment: 1 } },
      });
      if (broken) throw new Error("fixture secret failure");
      return "processed";
    },
    reply: (ok) => ({ kind: "reply", status: ok ? 200 : 500, body: ok ? "success" : "failure" }),
  };
  const worker = buildWorkerServices({
    appEnv: "test",
    prisma,
    assembly: sample.assembly,
    clock: sample.clock,
    providers,
    channel,
    webhookSources: [source],
  });
  const runtime = createWorkerRuntime({ services: worker, channel, logger: silentLogger });
  const receiving = security.createWebhooks({
    tx: sample.tx,
    clock: sample.clock,
    events: worker.events,
    sources: [source],
  });
  const accept = async (id: string) => {
    const prepared = await receiving.prepare("wecom", {
      method: "POST",
      operationId: "lyxtest.webhook",
      rawBody: Buffer.from(id),
      headers: {},
    });
    if (prepared.kind !== "ready") throw new Error("fixture rejected");
    return receiving.accept(prepared, sampleSystemContext());
  };
  try {
    const loop = runtime.domainLoops["webhook_reprocess"];
    expect(DOMAIN_LOOPS.find((d) => d.name === "webhook_reprocess")?.intervalMs).toBe(60_000);
    expect(loop).toBeDefined();
    broken = true;
    expect((await accept("worker-failure")).status).toBe(200);
    expect(await worker.relay()).toBe(1);
    expect((await worker.dispatch()).enqueued).toBe(1);
    const delivery = await prisma.outboxDelivery.findFirstOrThrow({
      where: { subscriber: "security.onWebhookReceived" },
    });
    expect(
      await worker.consume({
        eventId: delivery.outboxEventId,
        subscriber: delivery.subscriber,
        dispatchNo: delivery.dispatchNo,
      }),
    ).toBe("done");
    const failed = await prisma.webhookEvent.findFirstOrThrow({
      where: { eventId: "worker-failure" },
    });
    expect(failed).toMatchObject({
      processState: "failed",
      attempts: 1,
      error: "WEBHOOK_HANDLER_FAILED",
    });
    expect(await prisma.bizSequence.count({ where: { prefix: "WW" } })).toBe(0);
    broken = false;
    sample.clock.advance(60000);
    await loop!.tick();
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: failed.id } })).toMatchObject(
      { processState: "processed", attempts: 1, error: null },
    );
    expect((await prisma.bizSequence.findFirstOrThrow({ where: { prefix: "WW" } })).nextVal).toBe(
      1,
    );
    expect(
      await worker.consume({
        eventId: delivery.outboxEventId,
        subscriber: delivery.subscriber,
        dispatchNo: delivery.dispatchNo,
      }),
    ).toBe("stale");
    hold = true;
    await accept("worker-stop-flight");
    const tick = loop!.tick();
    await waiting;
    let stopped = false;
    const stop = runtime.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((r) => setImmediate(r));
    expect(stopped).toBe(false);
    release();
    await tick;
    await stop;
    await runtime.stop();
    expect((await prisma.bizSequence.findFirstOrThrow({ where: { prefix: "WW" } })).nextVal).toBe(
      2,
    );
    const subscriber = sample.assembly.subscribers.find(
      (s) => s.name === "security.onWebhookReceived",
    )!;
    await expect(
      sample.tx.run((tx) =>
        subscriber.handle(tx, {
          id: delivery.outboxEventId,
          type: "webhook.received",
          payload: { v: 1, provider: "wecom", webhookEventId: failed.id },
        }),
      ),
    ).rejects.toThrow("未绑定实际运行时");
  } finally {
    release();
    await runtime.stop();
    await channel.close();
  }
}, 120_000);
