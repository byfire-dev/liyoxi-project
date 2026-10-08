import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";
import {
  TimerListQuerySchema,
  OutboxDeliveryListQuerySchema,
  WebhookEventListQuerySchema,
} from "@liyoxi/contract";
import {
  useSeededDatabase,
  SAMPLE_EVENTS,
  workerSampleCounts,
  createRecordingPorts,
  createWorkerSample,
  assembleForTest,
  SAMPLE_TIMER_CATALOG,
  SAMPLE_TIMER_KINDS,
  sampleSystemContext,
} from "../testing/index.js";
import { createTimers, claimTimers, runTimer, countFailed, timerKey } from "../timers/index.js";
import { claimDeliveries, consumeDelivery, countDead, createEvents } from "../events/index.js";
import { createWebhooks } from "../security/index.js";
import type { WebhookSource } from "../security/index.js";
import { defineRegistration, alertsOf, uuidv7 } from "../kernel/index.js";
import { createFlowOps } from "./flow-ops.js";
import { timerView, webhookView } from "./flow-ops.projection.js";
import { PARAM_KEYS_BY_GROUP } from "@liyoxi/contract/config/params";
import { failingAuditTx } from "./__fixtures__/flow-ops.js";
import { fixture } from "./__fixtures__/flow-ops.js";
const db = useSeededDatabase("services");
let prisma: PrismaClient,
  f: ReturnType<typeof fixture>,
  admin: Awaited<ReturnType<ReturnType<typeof fixture>["actor"]>>;
beforeAll(async () => {
  prisma = await db.prisma();
  f = fixture(prisma);
  admin = await f.actor();
}, 180000);
const error = (code: string) => ({ error: code });
describe("W223精确目标人工恢复", { timeout: 120000 }, () => {
  it("只failed两迁移/到期与序号不变/取消释放键/其他状态409/原样审计", async () => {
    const first = await f.timer({
      payload: { password: "fictional-secret" },
      result: { arbitrary: "secret" },
    });
    const recovered = await f.ops.rescheduleTimer(admin, first.id, {});
    expect(recovered).toMatchObject({
      status: "scheduled",
      attempts: 0,
      retryAt: null,
      fireAt: first.fireAt.toISOString(),
      dispatchNo: 6,
      payload: null,
      result: null,
    });
    const row = await prisma.timer.findUniqueOrThrow({ where: { id: first.id } });
    expect(row).toMatchObject({
      payload: first.payload,
      result: first.result,
      fireAt: first.fireAt,
    });
    await expect(async () =>
      f.ops.cancelTimer(admin, first.id, { reason: "不再需要此计时" }),
    ).rejects.toMatchObject(error("STATE_NOT_ALLOWED"));
    const other = await f.timer();
    await f.ops.cancelTimer(admin, other.id, { reason: "已核对并确认取消" });
    await f.timer({ dedupeKey: other.dedupeKey });
    expect(
      await prisma.auditLog.count({ where: { targetId: other.id, action: "flow.timer.cancel" } }),
    ).toBe(1);
    await expect(async () => f.ops.rescheduleTimer(admin, uuidv7(), {})).rejects.toMatchObject(
      error("NOT_FOUND"),
    );
    await expect(async () =>
      f.ops.rescheduleTimer(admin, first.id, { fireAt: first.fireAt.toISOString() }),
    ).rejects.toMatchObject(error("VALIDATION_FAILED"));
  });
  it("复合键dead重投/不可新建订阅者/不可重发事件/并发只有一条审计", async () => {
    const { event, row } = await f.delivery();
    const responses = await Promise.allSettled([
      f.ops.retryDelivery(admin, event.id, { subscriber: row.subscriber }),
      f.ops.retryDelivery(admin, event.id, { subscriber: row.subscriber }),
    ]);
    expect(responses.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = responses.find((result) => result.status === "rejected");
    expect(rejected?.status === "rejected" && rejected.reason).toMatchObject(
      error("STATE_NOT_ALLOWED"),
    );
    expect(await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event);
    expect(
      await prisma.outboxDelivery.findUniqueOrThrow({
        where: {
          outboxEventId_subscriber: { outboxEventId: event.id, subscriber: row.subscriber },
        },
      }),
    ).toMatchObject({
      status: "retry",
      attempts: 0,
      dispatchNo: row.dispatchNo,
      nextAttemptAt: f.clock.now(),
    });
    const key = event.id + ":" + row.subscriber;
    expect(
      await prisma.auditLog.count({ where: { action: "flow.outbox.retry", targetKey: key } }),
    ).toBe(1);
    await expect(async () =>
      f.ops.retryDelivery(admin, event.id, { subscriber: "support.onCalendarImported" }),
    ).rejects.toMatchObject(error("NOT_FOUND"));
    await expect(async () =>
      f.ops.retryDelivery(admin, event.id, { subscriber: "attacker" }),
    ).rejects.toMatchObject(error("VALIDATION_FAILED"));
  });
  it("收件证据/immutable列不动，不新增首次received事件；非dead拒绝", async () => {
    const first = await f.webhook(),
      events = await prisma.outboxEvent.count();
    await f.ops.retryWebhook(admin, first.id, {});
    const after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: first.id } });
    expect(after).toMatchObject({
      provider: first.provider,
      eventId: first.eventId,
      eventType: first.eventType,
      receivedAt: first.receivedAt,
      payloadDigest: first.payloadDigest,
      payload: first.payload,
      processState: "received",
      attempts: 0,
      nextAttemptAt: f.clock.now(),
    });
    expect(await prisma.outboxEvent.count()).toBe(events);
    await expect(async () => f.ops.retryWebhook(admin, first.id, {})).rejects.toMatchObject(
      error("STATE_NOT_ALLOWED"),
    );
  });
  it("读取真实默认/日期边界与游标同时间不重不漏，unknown摘要为null", async () => {
    const first = await f.timer({
      fireAt: new Date("2026-02-01T16:00:00Z"),
      lastError: "Error: postgres://secret",
      payload: { safeLooking: "Bearer secret" },
    });
    const list = await f.ops.listTimers(
      admin.staff,
      TimerListQuerySchema.parse({ fireFrom: "2026-02-02", fireTo: "2026-02-02" }),
    );
    expect(list.items.map((row) => row.timerId)).toContain(first.id);
    expect(list.items.find((row) => row.timerId === first.id)).toMatchObject({
      payload: null,
      lastError: "Error（原始详情已隐去）",
    });
    expect(
      (
        await f.ops.listTimers(admin.staff, TimerListQuerySchema.parse({ fireTo: "2026-02-01" }))
      ).items.map((row) => row.timerId),
    ).not.toContain(first.id);
    const ids = [];
    for (let n = 0; n < 3; n++)
      ids.push(
        (await f.webhook({ eventType: "cursor-tie", payload: { summary: { arbitrary: "token" } } }))
          .id,
      );
    const query = WebhookEventListQuerySchema.parse({ eventType: "cursor-tie", limit: 2 });
    const page = await f.ops.listWebhooks(admin.staff, query),
      next = await f.ops.listWebhooks(admin.staff, { ...query, cursor: page.nextCursor! });
    expect([...page.items, ...next.items].map((row) => row.webhookEventId).sort()).toEqual(
      ids.sort(),
    );
    expect(page.totalApprox).toBe(3);
    expect(page.items[0]?.summary).toBeNull();
    await expect(async () =>
      f.ops.listWebhooks(admin.staff, { ...query, cursor: "invalid" }),
    ).rejects.toMatchObject(error("VALIDATION_FAILED"));
    const delivery = await f.ops.listDeliveries(
      admin.staff,
      OutboxDeliveryListQuerySchema.parse({}),
    );
    expect(delivery.items.every((row) => row.status === "dead")).toBe(true);
    expect(await f.tx.run((t) => countFailed(t))).toBe(
      (await f.ops.listTimers(admin.staff, TimerListQuerySchema.parse({}))).total,
    );
    expect(await f.tx.run((t) => countDead(t))).toBe(delivery.total);
  });
  it("模块view可读但不可写；permission-only OR可读；完全无权限拒绝", async () => {
    const denied = await f.actor("editor");
    await expect(async () =>
      f.ops.listTimers(denied.staff, TimerListQuerySchema.parse({})),
    ).rejects.toMatchObject(error("PERMISSION_DENIED"));
    const readonly = {
      ...denied.staff,
      moduleLevels: { ...denied.staff.moduleLevels, system: "v" as const },
    };
    expect((await f.ops.listTimers(readonly, TimerListQuerySchema.parse({}))).items).toBeInstanceOf(
      Array,
    );
    const permissionOnly = {
      ...admin.staff,
      moduleLevels: { ...admin.staff.moduleLevels, system: "n" as const },
    };
    expect(
      (await f.ops.listTimers(permissionOnly, TimerListQuerySchema.parse({}))).items,
    ).toBeInstanceOf(Array);
    await expect(async () =>
      f.ops.rescheduleTimer({ ...denied, staff: readonly }, (await f.timer()).id, {}),
    ).rejects.toMatchObject(error("PERMISSION_DENIED"));
  });
  it("真实timer失败耗尽后复活，原scanner/run消费一次且旧dispatch过期", async () => {
    const workers = createWorkerSample(),
      ports = createRecordingPorts(),
      assembly = assembleForTest({
        entry: "worker",
        extra: [workers.registration, ports.registration],
        omitReal: ["recurringJobs"],
      });
    const timers = createTimers({ assembly, catalog: SAMPLE_TIMER_CATALOG }),
      alerts = alertsOf(assembly);
    const kind = SAMPLE_TIMER_KINDS.plain,
      subject = { type: "lyxtest_row", id: uuidv7() };
    const ref = await f.tx.run((t) =>
      timers.arm(t, { kind, subject, key: timerKey(kind, subject), fireAt: f.clock.now() }),
    );
    workers.control.failing.add(kind);
    let stale: Parameters<typeof runTimer>[1] | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      await prisma.timer.update({ where: { id: ref.id }, data: { retryAt: f.clock.now() } });
      const claims = await f.tx.run((t) => claimTimers(t, timers.registry, f.clock.now()));
      const claim = claims.claimed.find((row) => row.timerId === ref.id)!;
      stale = claim;
      await runTimer(
        { tx: f.tx, registry: timers.registry, assembly, clock: f.clock, alerts },
        claim,
      );
    }
    expect((await prisma.timer.findUniqueOrThrow({ where: { id: ref.id } })).status).toBe("failed");
    await f.ops.rescheduleTimer(admin, ref.id, {});
    workers.control.failing.delete(kind);
    const claim = (
      await f.tx.run((t) => claimTimers(t, timers.registry, f.clock.now()))
    ).claimed.find((row) => row.timerId === ref.id)!;
    expect(
      await runTimer(
        { tx: f.tx, registry: timers.registry, assembly, clock: f.clock, alerts },
        stale!,
      ),
    ).toBe("stale");
    expect(
      await runTimer(
        { tx: f.tx, registry: timers.registry, assembly, clock: f.clock, alerts },
        claim,
      ),
    ).toBe("fired");
    expect(
      await runTimer(
        { tx: f.tx, registry: timers.registry, assembly, clock: f.clock, alerts },
        claim,
      ),
    ).toBe("stale");
    expect((await workerSampleCounts(prisma))[kind]).toBe(1);
  });
  it("真实出站claim/consume与收件scan复位后处理，不更改执行器", async () => {
    let calls = 0;
    const registration = defineRegistration("support", {
      subscribers: [
        {
          name: "support.onBizEvent",
          events: ["lyxtest.order.placed"],
          handle: async () => {
            calls++;
          },
        },
      ],
    });
    const assembly = assembleForTest({ entry: "worker", isolated: true, extra: [registration] });
    const sample = {
      assembly,
      clock: f.clock,
      tx: f.tx,
      events: createEvents({ assembly, clock: f.clock, tx: f.tx, testEvents: SAMPLE_EVENTS }),
    };
    const emitted = await sample.tx.run((t) =>
      sample.events.emit(t, sampleSystemContext(), {
        type: "lyxtest.order.placed",
        aggregate: { type: "drama_order", id: uuidv7() },
        payload: { v: 1, dramaOrderId: uuidv7() },
      }),
    );
    if (!emitted.id) throw new Error("fixture event not emitted");
    await sample.events.expand(100);
    await prisma.outboxDelivery.update({
      where: {
        outboxEventId_subscriber: { outboxEventId: emitted.id, subscriber: "support.onBizEvent" },
      },
      data: { status: "dead", attempts: 10 },
    });
    await f.ops.retryDelivery(admin, emitted.id, { subscriber: "support.onBizEvent" });
    const claim = (await sample.tx.run((t) => claimDeliveries(t))).claimed.find(
      (row) => row.eventId === emitted.id,
    )!;
    const deps = {
      tx: sample.tx,
      subscribers: sample.events.subscribers,
      alerts: { raise: async () => {} },
    };
    expect(await consumeDelivery(deps, claim)).toBe("done");
    expect(await consumeDelivery(deps, claim)).toBe("stale");
    expect(calls).toBe(1);
    let failing = true;
    const source: WebhookSource = {
      provider: "wecom",
      mode: "inbox",
      verify: async () => ({
        kind: "event",
        event: { eventId: "w223-real-" + uuidv7(), eventType: "fictional", data: {} },
      }),
      payload: () => ({ summary: { fictional: true } }),
      restore: async () => ({}),
      handle: async () => {
        if (failing) throw new Error("fictional failure");
        return "processed";
      },
      reply: (ok) => ({ kind: "reply", status: ok ? 200 : 500, body: ok ? "success" : "failure" }),
    };
    const hooks = createWebhooks({ ...sample, sources: [source] });
    const receipt = await hooks.prepare("wecom", {
      operationId: "hooks.wecom.event.receive",
      rawBody: Buffer.from("fictional"),
      headers: {},
      method: "POST",
    });
    if (receipt.kind !== "ready") throw new Error("fixture not ready");
    await hooks.accept(receipt, sampleSystemContext());
    const inbox = await prisma.webhookEvent.findFirstOrThrow({
      where: { eventId: { startsWith: "w223-real-" } },
    });
    for (let attempt = 0; attempt < 8; attempt++) {
      await hooks.scan();
      sample.clock.advance(21600000);
    }
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: inbox.id } })).processState,
    ).toBe("dead");
    const count = await prisma.outboxEvent.count({ where: { eventType: "webhook.received" } });
    failing = false;
    f.clock.set(sample.clock.now());
    await f.ops.retryWebhook(admin, inbox.id, {});
    expect(await hooks.scan()).toBeGreaterThan(0);
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: inbox.id } })).processState,
    ).toBe("processed");
    expect(await prisma.outboxEvent.count({ where: { eventType: "webhook.received" } })).toBe(
      count,
    );
  });
  it("审计插入失败：四个人工动作连目标变更整体回滚", async () => {
    const ops = createFlowOps({ clock: f.clock, tx: failingAuditTx(f.tx) });
    const reschedule = await f.timer(),
      cancel = await f.timer(),
      delivery = await f.delivery(),
      inbox = await f.webhook();
    const actions = [
      () => ops.rescheduleTimer(admin, reschedule.id, {}),
      () => ops.cancelTimer(admin, cancel.id, { reason: "受控模拟审计失败" }),
      () => ops.retryDelivery(admin, delivery.event.id, { subscriber: delivery.row.subscriber }),
      () => ops.retryWebhook(admin, inbox.id, {}),
    ];
    for (const action of actions) await expect(action()).rejects.toThrow("fictional audit failure");
    for (const row of [reschedule, cancel])
      expect(await prisma.timer.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(
      await prisma.outboxDelivery.findUniqueOrThrow({
        where: {
          outboxEventId_subscriber: {
            outboxEventId: delivery.event.id,
            subscriber: delivery.row.subscriber,
          },
        },
      }),
    ).toEqual(delivery.row);
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: inbox.id } })).toEqual(inbox);
    expect(
      await prisma.auditLog.count({
        where: {
          OR: [
            { targetId: { in: [reschedule.id, cancel.id, inbox.id] } },
            { targetKey: delivery.event.id + ":" + delivery.row.subscriber },
          ],
        },
      }),
    ).toBe(0);
  });
  it("仅正式结构投影；额外字段/任意文本/密文都不返回", async () => {
    const snapshot = {
      policy: PARAM_KEYS_BY_GROUP.sla[0]!.slice(4),
      amount: 60,
      unit: "work_minutes",
      calendarVersion: 1,
      computedAt: f.clock.now().toISOString(),
    };
    const timer = await f.timer({ kind: "sla.breach", payload: snapshot });
    expect(timerView(timer, true).payload).toEqual(snapshot);
    expect(
      timerView({ ...timer, payload: { ...snapshot, apiKey: "fictional-key" } }, true).payload,
    ).toBeNull();
    expect(
      timerView({ ...timer, payload: { ...snapshot, policy: "postgres://fictional" } }, true)
        .payload,
    ).toBeNull();
    expect(timerView(timer, false).actions).toEqual([]);
    const summary = { serial: "A1", state: "SUCCESS", amountFen: 123, transactionId: "12345" };
    const inbox = await f.webhook({
      provider: "wechatpay",
      keyVersion: "fictional-v1",
      payloadPurgeAt: new Date(f.clock.now().getTime() + 86400000),
      payload: {
        summary,
        resourceCipher: {
          ciphertext: "fictional",
          nonce: "fictional",
          associated_data: "fictional",
        },
      },
    });
    expect(webhookView(inbox, true).summary).toEqual(summary);
    expect(JSON.stringify(webhookView(inbox, true))).not.toContain("resourceCipher");
    expect(JSON.stringify(webhookView(inbox, true))).not.toContain("ciphertext");
    expect(
      webhookView(
        { ...inbox, payload: { summary: { ...summary, openid: "fictional-openid" } } },
        true,
      ).summary,
    ).toBeNull();
    expect(
      webhookView(
        { ...inbox, payload: { summary: { ...summary, transactionId: "Bearer fictional" } } },
        true,
      ).summary,
    ).toBeNull();
    expect(webhookView({ ...inbox, provider: "wecom" }, true).summary).toBeNull();
  });
});
