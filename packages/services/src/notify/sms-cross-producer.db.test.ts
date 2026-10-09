import { afterEach, describe, expect, it } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { notificationFixture, TEST_KEYRING, useSeededDatabase } from "../testing/index.js";
import { createSmsHealth } from "./sms-health.js";
import { createSmsInit, SMS_FIELDS } from "./sms-init.js";
import { smsDayUsage } from "./sms-budget.js";

const db = useSeededDatabase("services");
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup() {
  await db.reset();
  const prisma = await db.prisma();
  const h = notificationFixture(prisma);
  closers.push(() => h.service.close());
  const staff = await h.make.staff({ staffRoleKey: "super_admin" });
  const own = await h.merchant();
  const target = await h.tx.run((tx) => h.deps.merchantTarget(tx, own.user.id));
  if (!target?.phone || !target.phoneRef) throw new Error("测试主体必须有真实合法电话事实");
  const phone = target.phone;
  await createSmsInit({ tx: h.tx, clock: h.clock })({
    staffId: staff.id,
    config: {
      templates: Object.entries(SMS_FIELDS).map(([templateKey, fields], index) => ({
        templateKey,
        kind: templateKey === "verify_code" ? "verify" : "notice",
        providerTemplateId: String(1000 + index),
        signName: "虚构测试平台",
        params: fields.map(({ name, maxLen }) => ({ name, maxLen })),
        status: "active",
        approval: {
          templateApproved: true,
          signApproved: true,
          reference: "fictional-test-approval",
        },
      })),
    },
  });
  for (const [key, value] of [
    ["notify.test_recipients", [{ staffId: staff.id, phone }]],
    ["notify.sms.daily_cap", 1],
  ] as const)
    await prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key,
        value: value as never,
        createdByStaffId: staff.id,
        effectiveAt: h.clock.now(),
        createdAt: h.clock.now(),
      },
    });
  await prisma.smsTemplate.updateMany({
    where: { templateKey: { notIn: ["account_notice", "ops_alert"] } },
    data: { status: "disabled" },
  });
  h.clock.advance(6 * 86_400_000);
  const health = createSmsHealth({
    db: prisma,
    tx: h.tx,
    clock: h.clock,
    config: h.config,
    sms: h.providers.sms,
    alerts: h.deps.alerts,
    keyring: () => TEST_KEYRING,
    env: "test",
  });
  closers.push(() => health.close());
  const context = { scheduledFor: h.clock.now(), runTx: h.tx.run.bind(h.tx) };
  const claimed = latch();
  const release = latch();
  const run = context.runTx;
  const paused = {
    ...context,
    runTx: async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
      const result = await run(work);
      if (
        await prisma.notificationDelivery.count({
          where: { purpose: "keepalive", status: "sending", callStartedAt: null },
        })
      ) {
        claimed.resolve();
        await release.promise;
      }
      return result;
    },
  };
  const direct = (templateKey = "account_notice") =>
    h.service.sendDirect({
      purpose: templateKey === "ops_alert" ? "ops_alert" : "account_notice",
      templateKey,
      phone,
      params: templateKey === "ops_alert" ? { rule_name: "短信保活" } : {},
      directKey: `cross-producer:${uuidv7()}`,
    });
  const used = () =>
    h.tx.run((tx) => smsDayUsage(tx, { targetRef: target.phoneRef!, now: h.clock.now() }));
  return { ...h, own, health, context, paused, claimed, release, direct, used };
}

describe("真实普通直发/场景发送与健康预约共用同号码预算", () => {
  it("health已claim未start时普通sendDirect不能抢最后一个日名额", async () => {
    const h = await setup();
    const job = h.health.keepalive(h.paused);
    try {
      await h.claimed.promise;
      expect(await h.used()).toBe(1);
      await expect(h.direct()).rejects.toMatchObject({ error: "RATE_LIMITED" });
      expect(h.providers.sms.callsOf("sendSubscribeFallback")).toHaveLength(0);
      expect(h.providers.sms.callsOf("sendTemplate")).toHaveLength(0);
      h.release.resolve();
      expect(await job).toMatchObject({ sent: 1 });
      expect(await h.used()).toBe(1);
      expect(h.providers.sms.callsOf("sendTemplate")).toHaveLength(1);
      expect(await h.prisma.notificationDelivery.count()).toBe(1);
    } finally {
      h.release.resolve();
      await Promise.allSettled([job, h.health.close()]);
    }
  }, 60_000);

  it("场景SMS看到有效health预约即rate_limited，不外呼、不错误补发", async () => {
    const h = await setup();
    const identity = await h.prisma.wechatIdentity.create({
      data: {
        id: uuidv7(),
        merchantUserId: h.own.user.id,
        appid: h.deps.appid!,
        openid: `fictional-cross-${uuidv7()}`,
        lastLoginAt: h.clock.now(),
        lastActiveAt: h.clock.now(),
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await h.prisma.notifyScene.update({
      where: { sceneKey: "m.account_security" },
      data: { sceneEnabled: true, extEnabled: true, smsPolicy: "always" },
    });
    await h.tx.run((tx) =>
      h.service.onEvent(tx, {
        id: uuidv7(),
        type: "merchant_user.wechat_bound",
        payload: {
          v: 1,
          merchantUserId: h.own.user.id,
          wechatIdentityId: identity.id,
        },
      }),
    );
    const delivery = await h.prisma.notificationDelivery.findFirstOrThrow({
      where: { channel: "sms", notification: { notifySceneKey: "m.account_security" } },
    });
    const job = h.health.keepalive(h.paused);
    try {
      await h.claimed.promise;
      await h.service.deliver({ deliveryId: delivery.id });
      expect(
        await h.prisma.notificationDelivery.findUnique({ where: { id: delivery.id } }),
      ).toMatchObject({ status: "skipped", reason: "rate_limited", callStartedAt: null });
      expect(h.providers.sms.callsOf("sendSubscribeFallback")).toHaveLength(0);
      h.release.resolve();
      expect(await job).toMatchObject({ sent: 1 });
      expect(await h.used()).toBe(1);
      expect(h.providers.sms.callsOf("sendTemplate")).toHaveLength(1);
    } finally {
      h.release.resolve();
      await Promise.allSettled([job, h.health.close()]);
    }
  }, 60_000);

  it("普通另一个模板已开始时health不能再claim同号码日额度", async () => {
    const h = await setup();
    expect(await h.direct("ops_alert")).toMatchObject({ status: "sent" });
    expect(await h.health.keepalive(h.context)).toMatchObject({ sent: 0 });
    expect(h.providers.sms.callsOf("sendTemplate")).toHaveLength(0);
    expect(h.providers.sms.callsOf("sendSubscribeFallback")).toHaveLength(1);
    expect(await h.used()).toBe(1);
    expect(await h.prisma.notificationDelivery.count({ where: { purpose: "keepalive" } })).toBe(0);
  }, 60_000);

  it("预约过期释放容量，原health start不能复活且回收不重发", async () => {
    const h = await setup();
    const job = h.health.keepalive(h.paused);
    try {
      await h.claimed.promise;
      h.clock.advance(31_000);
      expect(await h.used()).toBe(0);
      expect(await h.direct()).toMatchObject({ status: "sent" });
      h.release.resolve();
      expect(await job).toMatchObject({ sent: 0 });
      await h.health.keepalive(h.context);
      expect(
        await h.prisma.notificationDelivery.findFirst({ where: { purpose: "keepalive" } }),
      ).toMatchObject({ status: "failed", reason: "claim_exhausted", callStartedAt: null });
      expect(h.providers.sms.callsOf("sendTemplate")).toHaveLength(0);
      expect(h.providers.sms.callsOf("sendSubscribeFallback")).toHaveLength(1);
      expect(await h.used()).toBe(1);
    } finally {
      h.release.resolve();
      await Promise.allSettled([job, h.health.close()]);
    }
  }, 60_000);
});
