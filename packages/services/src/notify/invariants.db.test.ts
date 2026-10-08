import { beforeAll, expect, it } from "vitest";
import {
  createTxRunner,
  sqlStateOf,
  defineRegistration,
  notifyReadPort,
  uuidv7,
} from "../kernel/index.js";
import type { Tx, TxRunner } from "../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  createNotifyMessageFixture,
  createNotifyQuotaFixture,
  createNotifySessionFixture,
  useSeededDatabase,
} from "../testing/index.js";
import {
  findNotifyN1Violations,
  findNotifyN2Violations,
  findNotifyN3Violations,
  findNotifyN15Violations,
} from "./invariants.js";

const db = useSeededDatabase("services");
const clock = createClock(new Date("2026-10-08T08:00:00.000Z"));
let runner: TxRunner;
beforeAll(async () => {
  runner = createTxRunner({ prisma: await db.prisma(), appEnv: "test" });
}, 120_000);

// Keep intentionally inconsistent observations in a rolled-back real transaction.
async function isolated(run: (tx: Tx) => Promise<void>) {
  const rollback = new Error("fictional invariant fixture rollback");
  await expect(
    runner.run(async (tx) => {
      await run(tx);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}

it("N1 checks real inbox recipient and NULL account scope without flagging valid rows", async () => {
  await isolated(async (tx) => {
    const make = createFactories({ db: tx, clock });
    const own = await make.merchant();
    const message = await createNotifyMessageFixture(tx, clock, {
      merchantUserId: own.user.id,
      entityId: own.entity.id,
      storeId: own.store.id,
    });
    const account = await createNotifyMessageFixture(tx, clock, { merchantUserId: own.user.id });
    expect(await findNotifyN1Violations(tx)).toEqual([]);
    const other = await make.merchantUser();
    await tx.merchantMessage.update({
      where: { id: message.id },
      data: { merchantUserId: other.id },
    });
    await tx.merchantMessage.update({
      where: { id: account.id },
      data: { entityId: own.entity.id },
    });
    expect((await findNotifyN1Violations(tx)).map((item) => item.subject)).toEqual(
      expect.arrayContaining([
        { type: "notification", id: message.notificationId },
        { type: "notification", id: account.notificationId },
      ]),
    );
  });
});

it("N1 only exempts a deleted merchant's missing inbox; staff inbox still must match", async () => {
  await isolated(async (tx) => {
    const make = createFactories({ db: tx, clock });
    const deleted = await make.merchantUser({
      status: "deleted",
      deletedAt: clock.now(),
      phoneEnc: null,
      phoneBidx: null,
      phoneMask: null,
      phoneLast4: null,
      displayName: null,
    });
    const gone = await createNotifyMessageFixture(tx, clock, { merchantUserId: deleted.id });
    await tx.merchantMessage.delete({ where: { id: gone.id } });
    const staff = await make.staff();
    const notification = await tx.notification.create({
      data: {
        id: uuidv7(),
        notifySceneKey: "s.approval_pending",
        dedupeKey: `fixture:${uuidv7()}`,
        staffId: staff.id,
        vars: {},
        createdAt: clock.now(),
      },
    });
    expect(await findNotifyN1Violations(tx)).toMatchObject([
      { subject: { type: "notification", id: notification.id } },
    ]);
    await tx.staffMessage.create({
      data: {
        id: uuidv7(),
        notificationId: notification.id,
        staffId: staff.id,
        kind: "approval",
        title: "虚构审批消息",
        body: "仅不变量测试",
        link: { route: "approval.detail", params: {} },
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    expect(await findNotifyN1Violations(tx)).toEqual([]);
    const other = await make.staff();
    await tx.staffMessage.updateMany({
      where: { notificationId: notification.id },
      data: { staffId: other.id },
    });
    expect(await findNotifyN1Violations(tx)).toHaveLength(1);
  });
});

it("N2 uses injected business time and the strict five/ten minute boundaries", async () => {
  await isolated(async (tx) => {
    const make = createFactories({ db: tx, clock });
    const user = await make.merchantUser();
    const message = await createNotifyMessageFixture(tx, clock, { merchantUserId: user.id });
    const minute = 60_000;
    const create = (status: "pending" | "sending", offset: number, resendNo: number) =>
      tx.notificationDelivery.create({
        data: {
          id: uuidv7(),
          notificationId: message.notificationId,
          channel: "wecom",
          origin: resendNo ? "manual" : "primary",
          resendNo,
          status,
          dueAt: new Date(clock.now().getTime() - offset),
          ...(status === "sending" ? { leaseUntil: new Date(clock.now().getTime() - offset) } : {}),
          createdAt: clock.now(),
          updatedAt: clock.now(),
        },
      });
    await create("sending", 5 * minute, 0);
    await create("pending", 10 * minute, 1);
    expect(await findNotifyN2Violations(tx, { now: clock.now() })).toEqual([]);
    const lease = await create("sending", 5 * minute + 1, 2);
    const pending = await create("pending", 10 * minute + 1, 3);
    expect(await findNotifyN2Violations(tx, { now: clock.now() })).toEqual([
      {
        subject: { type: "notification_delivery", id: lease.id },
        detail: { problem: "expired_sending_lease" },
      },
      {
        subject: { type: "notification_delivery", id: pending.id },
        detail: { problem: "overdue_pending_delivery" },
      },
    ]);
  });
});

it("N3 keeps historical success before disabling valid and detects success during the disabled interval", async () => {
  await isolated(async (tx) => {
    const make = createFactories({ db: tx, clock });
    const user = await make.merchantUser();
    const message = await createNotifyMessageFixture(tx, clock, { merchantUserId: user.id });
    const scene = await tx.notifyScene.findFirstOrThrow({
      where: { wxTemplateSlotKey: { not: null } },
    });
    const slotKey = scene.wxTemplateSlotKey!;
    await tx.notification.update({
      where: { id: message.notificationId },
      data: { notifySceneKey: scene.sceneKey },
    });
    await tx.wxTemplateSlot.update({
      where: { slotKey },
      data: {
        status: "disabled",
        providerTemplateId: "fictional-template",
        disabledReason: "manual",
        updatedAt: clock.now(),
      },
    });
    const sentAt = new Date(clock.now().getTime() - 1);
    const delivery = await tx.notificationDelivery.create({
      data: {
        id: uuidv7(),
        notificationId: message.notificationId,
        channel: "wx_subscribe",
        origin: "primary",
        status: "sent",
        providerTemplateId: "fictional-template",
        sentAt,
        finishedAt: sentAt,
        dueAt: sentAt,
        createdAt: sentAt,
        updatedAt: sentAt,
      },
    });
    expect(await findNotifyN3Violations(tx)).toEqual([]);
    await tx.notificationDelivery.update({
      where: { id: delivery.id },
      data: { sentAt: clock.now() },
    });
    expect(await findNotifyN3Violations(tx)).toEqual([
      {
        subject: { type: "wx_template_slot", key: slotKey },
        detail: { problem: "sent_during_unavailable_slot" },
      },
    ]);
  });
});

it("the database rejects negative subscription quota without disabling its CHECK", async () => {
  const user = await createFactories({ db: await db.prisma(), clock }).merchantUser();
  const error = await runner
    .run(async (tx) => {
      const { identity } = await createNotifySessionFixture(tx, clock, user.id);
      const scene = await tx.notifyScene.findFirstOrThrow({
        where: { wxTemplateSlotKey: { not: null } },
      });
      await createNotifyQuotaFixture(tx, clock, {
        merchantUserId: user.id,
        wechatIdentityId: identity.id,
        slotKey: scene.wxTemplateSlotKey!,
        remaining: -1,
      });
    })
    .catch((cause: unknown) => cause);
  expect(sqlStateOf(error)).toBe("23514");
  expect(await runner.run((tx) => findNotifyN3Violations(tx))).toEqual([]);
});

it("N15 reads actual owning-domain existence and reports the original polymorphic subject", async () => {
  await isolated(async (tx) => {
    const make = createFactories({ db: tx, clock });
    const staff = await make.staff();
    const term = await make.subscriptionTerm();
    const absent = uuidv7();
    for (const subjectId of [term.id, absent])
      await tx.manualReminderLog.create({
        data: {
          id: uuidv7(),
          subjectType: "subscription_term",
          subjectId,
          scene: "renewal",
          bizDate: new Date("2026-10-08"),
          sentByStaffId: staff.id,
          createdAt: clock.now(),
        },
      });
    const actual = assembleForTest({ entry: "worker" });
    expect(await findNotifyN15Violations(tx, actual)).toEqual([
      {
        subject: { type: "subscription_term", id: absent },
        detail: { problem: "manual_reminder_subject_missing" },
      },
    ]);
    const missing = assembleForTest({
      entry: "worker",
      isolated: true,
      extra: [defineRegistration("lyxtest_notify_missing", { ports: [notifyReadPort] })],
    });
    await expect(findNotifyN15Violations(tx, missing)).rejects.toThrow("缺少实际对象事实登记");
  });
});
