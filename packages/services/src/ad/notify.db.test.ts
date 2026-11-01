import { afterEach, beforeEach, expect, it } from "vitest";
import { addDays, atMinuteOfDay, calendarDate } from "@liyoxi/shared/time";
import { createIdempotencyContext, uuidv7 } from "../kernel/index.js";
import {
  createFactories,
  snapshotTables,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { assignDeliveryManager } from "../profile/index.js";
import { createTenant } from "../tenant/index.js";
import { claimTimers, runTimer } from "../timers/index.js";
import { adFixture } from "./__fixtures__/lifecycle.js";
import { adsAwaitingMerchant, adVersionForNotify, revalidateAdReminder } from "./notify-facts.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let active: Awaited<ReturnType<typeof adFixture>> | undefined;
beforeEach(() => db.reset(), 120_000);
afterEach(async () => {
  await active?.close();
  active = undefined;
});

it(
  "真实广告SLA通知当前剪辑师/经理/可见主管，资质在审只提醒且旧截止不借新状态",
  { timeout: 120_000 },
  async () => {
    const p = await db.prisma(),
      f = (active = await adFixture(p, {
        databaseUrl: await db.url(),
        redisUrl: process.env.REDIS_URL!,
        redisKeyPrefix: redis.prefix,
      })),
      r = f.runtime,
      make = createFactories({ db: p, clock: f.clock });
    const group = await p.staffGroup.create({
        data: {
          id: uuidv7(),
          name: "广告时限同组",
          staffRoleKey: "delivery_manager",
          createdAt: f.clock.now(),
          updatedAt: f.clock.now(),
        },
      }),
      otherGroup = await p.staffGroup.create({
        data: {
          id: uuidv7(),
          name: "广告时限其他组",
          staffRoleKey: "delivery_manager",
          createdAt: f.clock.now(),
          updatedAt: f.clock.now(),
        },
      }),
      manager = await make.staff({ staffRoleKey: "delivery_manager", staffGroupId: group.id }),
      lead = await make.staff({
        staffRoleKey: "delivery_manager",
        staffGroupId: group.id,
        isLead: true,
      }),
      outsider = await make.staff({
        staffRoleKey: "delivery_manager",
        staffGroupId: otherGroup.id,
        isLead: true,
      });
    const common = {
      tx: r.tx,
      clock: f.clock,
      assembly: r.assembly,
      flow: r.flow,
      events: r.events,
    };
    await r.tx.run((tx) =>
      assignDeliveryManager(
        tx,
        { clock: f.clock, assembly: r.assembly, tenant: createTenant(common) },
        f.adminActor.ctx,
        {
          storeId: f.actor.membership.storeId,
          staffId: manager.id,
          scope: f.adminActor.staff.scope,
        },
      ),
    );
    const fire = async (adId: string) => {
      const timer = await p.timer.findFirstOrThrow({
        where: { dedupeKey: `sla.breach:ad:${adId}:first:0`, status: "scheduled" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      f.clock.set(new Date(timer.fireAt.getTime() + 1000));
      const claimed = await r.tx.run((tx) =>
        claimTimers(tx, r.timers.registry, f.clock.now(), 100),
      );
      const ref = claimed.claimed.find((entry) => entry.timerId === timer.id);
      if (!ref) throw new Error("广告SLA未被真实扫描认领");
      expect(
        await runTimer(
          {
            tx: r.tx,
            assembly: r.assembly,
            registry: r.timers.registry,
            clock: f.clock,
            alerts: {
              raise: async () => {
                throw new Error("广告SLA不应产生失败告警");
              },
            },
          },
          ref,
        ),
      ).toBe("fired");
      return p.outboxEvent.findFirstOrThrow({
        where: { eventType: "ad.sla_breached", aggregateId: adId },
        orderBy: { seq: "desc" },
      });
    };
    const first = await fire(f.created.adId),
      deliver = (event: typeof first) =>
        r.tx.run((tx) =>
          r.notify.onEvent(tx, {
            id: event.id,
            type: event.eventType,
            payload: event.payload as Record<string, unknown>,
          }),
        );
    expect(await deliver(first)).toBe(3);
    expect(await deliver(first)).toBe(0);
    const messages = await p.staffMessage.findMany({
      where: { notification: { bizId: f.created.adId, notifySceneKey: "s.step_overdue" } },
    });
    expect(messages.map((message) => message.staffId).sort()).toEqual(
      [f.editorId, manager.id, lead.id].sort(),
    );
    expect(
      messages.every(
        (message) =>
          JSON.stringify(message.link) ===
          JSON.stringify({ route: "delivery.ad_tasks", params: { adId: f.created.adId } }),
      ),
    ).toBe(true);
    expect(messages.some((message) => message.staffId === outsider.id)).toBe(false);
    await f.push();
    expect(await deliver(first)).toBe(0);
    // Explicit nonterminal qualification input; the actual SLA writer must not create a breach.
    await p.store.update({
      where: { id: f.actor.membership.storeId },
      data: { qualificationStatus: "pending", isPrimary: true },
    });
    const waiting = await r.ads.create(f.actor, f.createBody),
      reminder = await fire(waiting.adId);
    // The existing ad_editor unassigned pool makes both leads visible only while unassigned.
    expect(await deliver(reminder)).toBe(3);
    expect(await p.ad.findUniqueOrThrow({ where: { id: waiting.adId } })).toMatchObject({
      status: "pending_assign",
      firstBreachedAt: null,
      capturedAt: null,
    });
    const waitingMessages = await p.staffMessage.findMany({
      where: { notification: { bizId: waiting.adId, notifySceneKey: "s.step_overdue" } },
    });
    expect(waitingMessages.map((message) => message.staffId).sort()).toEqual(
      [manager.id, lead.id, outsider.id].sort(),
    );
    expect(
      waitingMessages.every(
        (message) => message.body.includes("资质仍在审核") && !message.body.includes("已超过"),
      ),
    ).toBe(true);
  },
);

it(
  "真实广告推送/手工日节流/R5通知沿当前老板和版次，旧事件不能借同clock新版",
  { timeout: 120_000 },
  async () => {
    const p = await db.prisma(),
      f = (active = await adFixture(p, {
        databaseUrl: await db.url(),
        redisUrl: process.env.REDIS_URL!,
        redisKeyPrefix: redis.prefix,
      })),
      r = f.runtime,
      adId = f.created.adId;
    await f.playback(false);
    const v1 = await f.push();
    const pushed = (versionNo: number) =>
      p.outboxEvent.findFirstOrThrow({
        where: {
          eventType: "ad.version_pushed",
          aggregateId: adId,
          payload: { path: ["versionNo"], equals: versionNo },
        },
      });
    const latestManual = () =>
      p.outboxEvent.findFirstOrThrow({
        where: {
          eventType: "manual_reminder.sent",
          payload: { path: ["subjectId"], equals: adId },
        },
        orderBy: { seq: "desc" },
      });
    const dispatch = async (id: string) => {
      const event = await p.outboxEvent.findUniqueOrThrow({ where: { id } });
      return r.tx.run((tx) =>
        r.notify.onEvent(tx, {
          id: event.id,
          type: event.eventType,
          payload: event.payload as Record<string, unknown>,
        }),
      );
    };
    const firstPush = await pushed(v1.versionNo);
    expect(await dispatch(firstPush.id)).toBe(1);
    const first = await p.notification.findFirstOrThrow({ where: { bizId: adId, node: "N0" } });
    expect(first).toMatchObject({
      notifySceneKey: "m.ad_pending",
      merchantUserId: f.actor.ctx.actor.id,
    });
    expect(
      (await p.merchantMessage.findFirstOrThrow({ where: { notificationId: first.id } })).link,
    ).toEqual({ route: "ad.detail", params: { adId, storeId: f.actor.membership.storeId } });
    const key = uuidv7(),
      idem = () =>
        createIdempotencyContext({
          mode: "required",
          scope: "admin.ad.remind",
          actor: f.staffActor.ctx.actor,
          key,
          request: { method: "POST", pathParams: { adId }, body: {} },
        });
    const reminded = await r.adminAds.remind(f.staffActor, adId, {}, { idem: idem() });
    expect(reminded).toMatchObject({ scene: "confirm_ad", subjectType: "ad", subjectId: adId });
    const manual1 = await latestManual();
    expect(await dispatch(manual1.id)).toBe(1);
    expect(await dispatch(manual1.id)).toBe(0);
    const beforeReplay = await snapshotTables(p, [
      "manual_reminder_log",
      "outbox_event",
      "notification",
      "notification_delivery",
      "merchant_message",
      "point_hold",
      "ledger_operation",
    ]);
    await r.adminAds.remind(f.staffActor, adId, {}, { idem: idem() });
    expect(
      await snapshotTables(p, [
        "manual_reminder_log",
        "outbox_event",
        "notification",
        "notification_delivery",
        "merchant_message",
        "point_hold",
        "ledger_operation",
      ]),
    ).toEqual(beforeReplay);
    await expect(r.adminAds.remind(f.staffActor, adId, {})).rejects.toMatchObject({
      error: "REMINDED_TODAY",
    });
    f.clock.set(new Date(f.clock.now().getTime() + 86_400_000));
    await r.adminAds.remind(f.staffActor, adId, {});
    const manual2 = await latestManual();
    expect(manual2.id).not.toBe(manual1.id);
    expect(await dispatch(manual2.id)).toBe(1);
    expect(await p.notification.count({ where: { bizId: adId, node: "M" } })).toBe(2);
    // A valid log paired with another event ID is not proof of this request occurrence.
    expect(
      await r.tx.run((tx) =>
        r.notify.onEvent(tx, {
          id: manual1.id,
          type: "manual_reminder.sent",
          payload: manual2.payload as Record<string, unknown>,
        }),
      ),
    ).toBe(0);
    f.clock.set(new Date(f.clock.now().getTime() + 86_400_000));
    await r.adminAds.remind(f.staffActor, adId, {});
    const delayed = await latestManual(),
      target = { adId, version: v1.versionNo },
      sameClock = f.clock.now();
    await r.ads.requestChange(f.actor, adId, { versionNo: v1.versionNo, note: "真实新修改轮次" });
    const v2 = await f.push();
    expect(f.clock.now()).toEqual(sameClock);
    expect(await dispatch(delayed.id)).toBe(0);
    expect(await dispatch(firstPush.id)).toBe(0);
    expect(await r.tx.run((tx) => revalidateAdReminder(tx, target))).toEqual({ valid: false });
    expect(await dispatch((await pushed(v2.versionNo)).id)).toBe(1);
    expect(await p.notification.count({ where: { bizId: adId, node: "M" } })).toBe(2);
    const rawPayload = manual2.payload as Record<string, unknown>;
    expect(
      await r.tx.run((tx) =>
        r.notify.onEvent(tx, {
          id: uuidv7(),
          type: "manual_reminder.sent",
          payload: { ...rawPayload, manualReminderLogId: uuidv7() },
        }),
      ),
    ).toBe(0);
    f.clock.set(atMinuteOfDay(addDays(calendarDate(sameClock), 2), 0));
    const oldDate = atMinuteOfDay(calendarDate(sameClock), 0),
      rows = await r.tx.run((tx) =>
        adsAwaitingMerchant(tx, {
          pushedFrom: oldDate,
          pushedTo: new Date(oldDate.getTime() + 86_400_000 - 1),
        }),
      );
    expect(rows).toContainEqual({ adId, version: v2.versionNo });
    await r.notify.remindScan({ scheduledFor: f.clock.now() });
    await r.notify.remindScan({ scheduledFor: f.clock.now() });
    expect(
      await p.notification.count({ where: { bizId: adId, node: "R1", sourceRule: "R5" } }),
    ).toBe(1);
    await r.ads.download(f.actor, adId, { versionNo: v2.versionNo });
    await r.ads.confirm(f.actor, adId, {
      versionNo: v2.versionNo,
      viewedVia: "album",
      hasViewed: true,
    });
    expect(await r.tx.run((tx) => adVersionForNotify(tx, adId))).toBeNull();
    expect(await dispatch((await pushed(v2.versionNo)).id)).toBe(0);
    expect(
      await r.tx.run((tx) => revalidateAdReminder(tx, { adId, version: v2.versionNo })),
    ).toEqual({ valid: false });
  },
);
