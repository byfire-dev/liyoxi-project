import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Prisma } from "@liyoxi/db";
import { useSeededDatabase, notificationFixture } from "../testing/index.js";
import { createNotifyDispatcher } from "./service.js";

const db = useSeededDatabase("services");
let h: ReturnType<typeof notificationFixture>;
beforeAll(async () => {
  h = notificationFixture(await db.prisma());
}, 120_000);
afterAll(async () => {
  await h?.service.close();
});
it("默认真实unconfigured空字段可启动，不把外部模板未配当成站内失败", async () => {
  await expect(h.service.validateConfiguration()).resolves.toBeUndefined();
});
it("active字段错误在test真实拒绝，错误不包含配置原值", async () => {
  const scene = await h.prisma.notifyScene.findUniqueOrThrow({
    where: { sceneKey: "s.followup_due" },
  });
  await h.prisma.notifyScene.delete({ where: { sceneKey: scene.sceneKey } });
  try {
    await expect(h.service.validateConfiguration()).rejects.toMatchObject({ error: "INTERNAL" });
  } finally {
    await h.prisma.notifyScene.create({
      data: { ...scene, smsNodes: scene.smsNodes === null ? Prisma.DbNull : scene.smsNodes },
    });
  }
  await h.prisma.wxTemplateSlot.update({
    where: { slotKey: "pay_result" },
    data: {
      status: "active",
      providerTemplateId: "fictional-config-secret",
      fields: [{ name: "thing999", type: "thing", label: "fictional-private-label" }],
    },
  });
  const error = await h.service.validateConfiguration().catch((value: unknown) => value);
  expect(error).toMatchObject({ error: "INTERNAL" });
  expect(JSON.stringify(error)).not.toMatch(/fictional-config-secret|fictional-private-label/);
});
it("prod只安全告警且错误槽位不可发，未消费额度或Provider调用", async () => {
  const own = await h.merchant(),
    wx = await h.wx(own),
    raise = vi.fn(async () => {}),
    prod = createNotifyDispatcher({ ...h.deps, appEnv: "prod", alerts: { raise } });
  await h.prisma.wxTemplateSlot.update({
    where: { slotKey: "order_result" },
    data: { fields: [{ name: "thing999", type: "thing", label: "fictional-private-label" }] },
  });
  try {
    await expect(prod.validateConfiguration()).resolves.toBeUndefined();
    expect(raise).toHaveBeenCalled();
    expect(JSON.stringify(raise.mock.calls)).not.toMatch(
      /fictional-private-label|fictional-config-secret/,
    );
    await prod.deliver({ deliveryId: wx.delivery.id });
    expect(
      await h.prisma.notificationDelivery.findUnique({ where: { id: wx.delivery.id } }),
    ).toMatchObject({ status: "skipped", reason: "unconfigured", callStartedAt: null });
    expect(
      await h.prisma.wxSubscribeQuota.findFirst({ where: { wechatIdentityId: wx.identity.id } }),
    ).toMatchObject({ estRemaining: 1 });
    expect(h.providers.wechat.callsOf("sendSubscribeMessage")).toHaveLength(0);
  } finally {
    await prod.close();
  }
});
