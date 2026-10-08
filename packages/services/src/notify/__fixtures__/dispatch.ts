import type { PrismaClient } from "@liyoxi/db";
import { assembleServices } from "../../assembly.js";
import { createConfig } from "../../config/index.js";
import { createTxRunner, uuidv7 } from "../../kernel/index.js";
import { merchantTargetForNotify, wechatTargetForNotify } from "../../identity/index.js";
import { phoneBidx } from "../../security/index.js";
import { maskPhone } from "@liyoxi/shared/mask";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { nextWorkStart } from "@liyoxi/shared/workcal";
import { loadWorkCalendar, workHoursAt } from "../../sla/index.js";
import { staffTargetForNotify } from "../../staff/index.js";
import {
  createClock,
  createFactories,
  createFakeProviders,
  TEST_KEYRING,
} from "../../testing/index.js";
import { createNotifyDispatcher } from "../service.js";
import type { NotifyDispatchDeps } from "../context.js";

/** Fictional fixtures use production recipient locks and the real provider TX guard. */
export function notificationFixture(prisma: PrismaClient) {
  const clock = createClock(new Date("2026-10-08T04:00:00.000Z"));
  const tx = createTxRunner({ prisma, appEnv: "test" });
  const make = createFactories({ db: prisma, clock });
  const providers = createFakeProviders({ clock });
  const config = createConfig({ db: prisma, clock, redis: null });
  const deps: NotifyDispatchDeps = {
    appEnv: "test",
    tx,
    clock,
    assembly: assembleServices({ entry: "api", appEnv: "test" }),
    providers,
    params: config.params,
    logger: { info() {}, warn() {}, error() {} },
    alerts: { async raise() {} },
    appid: "fictional-w217",
    wxEnabled: async () => true,
    smsEnabled: async () => true,
    purchaseMode: async () => "in_app",
    approvalRecipients: async () => [],
    merchantTarget: (t, id) => merchantTargetForNotify(t, id, () => TEST_KEYRING, true),
    staffTarget: (t, id) => staffTargetForNotify(t, id, () => TEST_KEYRING),
    staffWorkAt: async (t, at) => {
      const from = calendarDate(at);
      const calendar = await loadWorkCalendar(
        t,
        { from, to: addDays(from, 366) },
        await workHoursAt(t, at),
      );
      return nextWorkStart(calendar, at).at;
    },

    directTarget: (phone) => ({
      phoneRef: phoneBidx(TEST_KEYRING, phone).toString("hex"),
      phoneMask: maskPhone(phone),
    }),
    wechatTarget: (t, id, user) => wechatTargetForNotify(t, id, user, "fictional-w217"),
  };
  const service = createNotifyDispatcher(deps);
  async function merchant() {
    const own = await make.subscribedMerchant();
    const order = await make.dramaOrder({
      entityId: own.entity.id,
      storeId: own.store.id,
      placedByUserId: own.user.id,
      subscriptionTermId: own.term.id,
    });
    return { ...own, order };
  }
  async function generated(own: Awaited<ReturnType<typeof merchant>>) {
    await tx.run((t) =>
      service.onEvent(t, {
        id: uuidv7(),
        type: "order.submitted",
        payload: { v: 1, dramaOrderId: own.order.id },
      }),
    );
    return prisma.notification.findFirstOrThrow({
      where: { bizId: own.order.id, merchantUserId: own.user.id },
    });
  }
  async function wx(own: Awaited<ReturnType<typeof merchant>>) {
    const identity = await prisma.wechatIdentity.create({
      data: {
        id: uuidv7(),
        merchantUserId: own.user.id,
        appid: deps.appid!,
        openid: `fictional-${uuidv7()}`,
        lastLoginAt: clock.now(),
        lastActiveAt: clock.now(),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    await prisma.wxTemplateSlot.update({
      where: { slotKey: "order_result" },
      data: {
        status: "active",
        providerTemplateId: "fictional-order-result",
        fields: [{ name: "thing1", type: "thing" }],
        updatedAt: clock.now(),
      },
    });
    await prisma.wxSubscribeQuota.create({
      data: {
        wechatIdentityId: identity.id,
        merchantUserId: own.user.id,
        wxTemplateSlotKey: "order_result",
        estRemaining: 1,
        lastAcceptAt: clock.now(),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      },
    });
    const notification = await generated(own);
    const delivery = await prisma.notificationDelivery.findFirstOrThrow({
      where: { notificationId: notification.id, channel: "wx_subscribe" },
    });
    return { identity, notification, delivery };
  }
  return { prisma, clock, tx, make, providers, config, deps, service, merchant, generated, wx };
}
