import { afterAll, beforeAll, expect, it } from "vitest";
import { useSeededDatabase, notificationFixture } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";

const db = useSeededDatabase("services");
let h: ReturnType<typeof notificationFixture>;
beforeAll(async () => {
  h = notificationFixture(await db.prisma());
}, 120_000);
afterAll(async () => {
  await h?.service.close();
});

for (const mode of ["in_app", "offline_contract", "hidden"] as const)
  it(`真实付款按 ${mode} 定格金额、文案和通道，事件不能替代真实单据`, async () => {
    const own = await h.merchant();
    const order = await h.make.billingOrder({
      entityId: own.entity.id,
      storeId: own.store.id,
      placedByUserId: own.user.id,
      type: "plan_renew",
      amountFen: 1050,
    });
    h.deps.purchaseMode = async () => mode;
    await h.tx.run((tx) =>
      h.service.onEvent(tx, {
        id: uuidv7(),
        type: "billing_order.paid",
        payload: { v: 1, billingOrderId: order.id, amountFen: 999_999 },
      }),
    );
    const message = await h.prisma.merchantMessage.findFirstOrThrow({
      where: { notification: { bizId: order.id, notifySceneKey: "m.pay_success" } },
      include: { notification: true },
    });
    expect(message.notification.copyMode).toBe(mode);
    expect(message.body).not.toContain("9999.99");
    if (mode === "in_app") {
      expect(message.title).toBe("付款成功");
      expect(message.body).toContain("10.50");
      expect(message.link).toEqual({
        route: "payment.result",
        params: { paymentOrderId: order.id },
      });
      expect(
        await h.prisma.notificationDelivery.count({
          where: { notificationId: message.notificationId, channel: "wx_subscribe" },
        }),
      ).toBe(1);
    } else {
      expect(message.title).toBe("服务已续期");
      expect(message.body).not.toMatch(/10\.50|¥|￥|付款|购买/);
      expect(message.link).toEqual({ route: "wallet.home", params: {} });
      expect(
        await h.prisma.notificationDelivery.count({
          where: { notificationId: message.notificationId, channel: { not: "inbox" } },
        }),
      ).toBe(0);
    }
  });
