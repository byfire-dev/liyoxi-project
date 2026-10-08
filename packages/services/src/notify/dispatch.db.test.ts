import { beforeAll, afterAll, expect, it } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { notificationFixture } from "./__fixtures__/dispatch.js";
const db = useSeededDatabase("services");
let h: ReturnType<typeof notificationFixture>;
beforeAll(async () => {
  h = notificationFixture(await db.prisma());
}, 120_000);
afterAll(async () => {
  await h?.service.close();
});
it("两个真实事务重复及乱序order事件只生成一份消息和每通道一投递，event角色不替代当前归属", async () => {
  const own = await h.merchant();
  const event = {
    id: uuidv7(),
    type: "order.submitted",
    payload: { v: 1, dramaOrderId: own.order.id, role: "clerk" },
  };
  await Promise.all([
    h.tx.run((t) => h.service.onEvent(t, event)),
    h.tx.run((t) => h.service.onEvent(t, { ...event, id: uuidv7() })),
  ]);
  const notifications = await h.prisma.notification.findMany({ where: { bizId: own.order.id } });
  expect(notifications).toHaveLength(1);
  expect(
    await h.prisma.merchantMessage.count({ where: { notificationId: notifications[0]!.id } }),
  ).toBe(1);
  expect(
    await h.prisma.notificationDelivery.findMany({
      where: { notificationId: notifications[0]!.id },
      orderBy: { channel: "asc" },
    }),
  ).toMatchObject([
    { channel: "inbox", status: "sent" },
    { channel: "wx_subscribe", status: "pending" },
  ]);
  expect(h.providers.wechat.callsOf("sendSubscribeMessage")).toHaveLength(0);
});
it("调用方事务回滚同时撤回notification/message/delivery，重投可正常写入", async () => {
  const own = await h.merchant();
  await expect(
    h.tx.run(async (t) => {
      await h.service.onEvent(t, {
        id: uuidv7(),
        type: "order.submitted",
        payload: { v: 1, dramaOrderId: own.order.id },
      });
      throw new Error("fictional rollback");
    }),
  ).rejects.toThrow("fictional rollback");
  expect(await h.prisma.notification.count({ where: { bizId: own.order.id } })).toBe(0);
  await h.generated(own);
  expect(await h.prisma.notification.count({ where: { bizId: own.order.id } })).toBe(1);
});
it("当前已移除成员及不存在对象不派发，不使用event快照放行", async () => {
  const own = await h.merchant();
  await h.prisma.entityMember.update({
    where: { id: own.owner.id },
    data: {
      status: "removed",
      removedAt: h.clock.now(),
      removeReason: "self",
      removeActorType: "merchant",
      removeActorId: own.user.id,
      removeClient: "weapp",
    },
  });
  expect(
    await h.tx.run((t) =>
      h.service.onEvent(t, {
        id: uuidv7(),
        type: "order.submitted",
        payload: { v: 1, dramaOrderId: own.order.id },
      }),
    ),
  ).toBe(0);
  expect(
    await h.tx.run((t) =>
      h.service.onEvent(t, {
        id: uuidv7(),
        type: "order.submitted",
        payload: { v: 1, dramaOrderId: uuidv7() },
      }),
    ),
  ).toBe(0);
});
it("新微信登录SMS在未配置时受控降级", async () => {
  const own = await h.merchant();
  expect(
    await h.tx.run((t) =>
      h.service.onEvent(t, {
        id: uuidv7(),
        type: "merchant_user.wechat_bound",
        payload: { v: 1, merchantUserId: own.user.id, wechatIdentityId: uuidv7() },
      }),
    ),
  ).toBe(1);
  const notification = await h.prisma.notification.findFirstOrThrow({
    where: { bizId: own.user.id },
  });
  const sms = await h.prisma.notificationDelivery.findFirstOrThrow({
    where: { notificationId: notification.id, channel: "sms" },
  });
  await h.service.deliver({ deliveryId: sms.id });
  expect(await h.prisma.notificationDelivery.findUnique({ where: { id: sms.id } })).toMatchObject({
    status: "skipped",
    reason: "unconfigured",
    callStartedAt: null,
  });
  expect(h.providers.sms.callsOf("sendSubscribeFallback")).toHaveLength(0);
});

it("强制公告在合法主体归属更换后重入分别保留历史，撤回只发当前老板且无外呼", async () => {
  const own = await h.merchant();
  const staff = await h.make.staff();
  const now = h.clock.now();
  const notice = await h.prisma.siteNotice.create({
    data: {
      id: uuidv7(),
      kind: "plan_revision",
      refId: uuidv7(),
      title: "虚构规则调整",
      summary: "虚构新价格100元",
      summaryNoPrice: "虚构规则调整说明",
      effectiveAt: new Date(now.getTime() + 7 * 86_400_000),
      announcedAt: now,
      leadDays: 7,
      link: { route: "wallet.home", params: {} },
      createdByStaffId: staff.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  await h.prisma.notifyScene.update({
    where: { sceneKey: "m.rule_change_notice" },
    data: { sceneEnabled: false, updatedAt: now },
  });
  await h.tx.run((t) =>
    h.service.onEvent(t, {
      id: uuidv7(),
      type: "site_notice.announced",
      payload: { v: 1, siteNoticeId: notice.id },
    }),
  );
  const replacement = await h.make.merchantUser(),
    second = await h.make.entity({ createdByUserId: own.user.id });
  await h.tx.run(async (tx) => {
    await tx.entityMember.update({
      where: { id: own.owner.id },
      data: {
        status: "removed",
        removedAt: now,
        removeReason: "owner_transfer",
        removeActorType: "staff",
        removeActorId: staff.id,
        removeClient: "admin",
      },
    });
    await tx.entityMember.createMany({
      data: [
        {
          id: uuidv7(),
          entityId: own.entity.id,
          merchantUserId: replacement.id,
          role: "owner",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: uuidv7(),
          entityId: second.id,
          merchantUserId: own.user.id,
          role: "owner",
          status: "active",
          createdAt: now,
          updatedAt: now,
        },
      ],
    });
  });
  expect(
    await h.prisma.entityMember.count({
      where: { merchantUserId: own.user.id, status: "active" },
    }),
  ).toBe(1);
  await h.tx.run((t) =>
    h.service.onEvent(t, {
      id: uuidv7(),
      type: "site_notice.announced",
      payload: { v: 1, siteNoticeId: notice.id },
    }),
  );
  const messages = await h.prisma.merchantMessage.findMany({
    where: { merchantUserId: own.user.id, notification: { bizId: notice.id } },
    orderBy: { entityId: "asc" },
  });
  expect(messages.map((row) => row.entityId)).toEqual([own.entity.id, second.id].sort());
  expect(messages.every((row) => row.isOwnerOnly)).toBe(true);
  await h.prisma.siteNotice.update({
    where: { id: notice.id },
    data: { status: "withdrawn", withdrawnAt: now, withdrawnByStaffId: staff.id },
  });
  await h.tx.run((t) =>
    h.service.onEvent(t, {
      id: uuidv7(),
      type: "site_notice.withdrawn",
      payload: { v: 1, siteNoticeId: notice.id },
    }),
  );
  expect(
    await h.prisma.merchantMessage.count({
      where: { merchantUserId: own.user.id, notification: { bizId: notice.id } },
    }),
  ).toBe(3);
  expect(
    await h.prisma.notificationDelivery.count({
      where: { channel: { not: "inbox" }, notification: { bizId: notice.id } },
    }),
  ).toBe(0);
});
it("actual order.started 与 asset.adopted 生成正式深链，素材只当前可进店上传人且员工代传不发", async () => {
  const own = await h.merchant(),
    now = h.clock.now(),
    reviewer = await h.make.staff();
  const started = await h.make.dramaOrder({
    entityId: own.entity.id,
    storeId: own.store.id,
    placedByUserId: own.user.id,
    subscriptionTermId: own.term.id,
    status: "producing",
  });
  await h.tx.run((t) =>
    h.service.onEvent(t, {
      id: uuidv7(),
      type: "order.started",
      payload: { v: 1, dramaOrderId: started.id },
    }),
  );
  expect(
    await h.prisma.merchantMessage.findFirst({
      where: { notification: { bizId: started.id, notifySceneKey: "m.order_progress" } },
    }),
  ).toMatchObject({
    link: { route: "order.detail", params: { orderId: started.id, storeId: own.store.id } },
  });
  const clerk = await h.make.merchantUser(),
    member = await h.make.entityMember({
      entityId: own.entity.id,
      merchantUserId: clerk.id,
      role: "clerk",
    });
  await h.make.storeMember({
    entityId: own.entity.id,
    entityMemberId: member.id,
    storeId: own.store.id,
    addedByMemberId: own.owner.id,
  });
  const common = {
    entityId: own.entity.id,
    storeId: own.store.id,
    type: "image",
    title: "虚构素材",
    processingState: "processed",
    reviewState: "reviewed",
    usability: "ready",
    reviewedByStaffId: reviewer.id,
    reviewedAt: now,
    adoptedCount: 1,
    createdAt: now,
    updatedAt: now,
  };
  const asset = await h.prisma.storeAsset.create({
    data: {
      ...common,
      id: uuidv7(),
      idempotencyKey: uuidv7(),
      uploadActorType: "merchant",
      uploadActorId: clerk.id,
      uploadActorRole: "clerk",
      uploadClient: "weapp",
    },
  });
  const staffAsset = await h.prisma.storeAsset.create({
    data: {
      ...common,
      id: uuidv7(),
      idempotencyKey: uuidv7(),
      uploadActorType: "staff",
      uploadActorId: reviewer.id,
      uploadClient: "admin",
    },
  });
  await h.tx.run((t) =>
    h.service.onEvent(t, {
      id: uuidv7(),
      type: "asset.adopted",
      payload: { v: 1, storeAssetId: asset.id },
    }),
  );
  const message = await h.prisma.merchantMessage.findFirstOrThrow({
    where: { notification: { bizId: asset.id } },
  });
  expect(message).toMatchObject({
    merchantUserId: clerk.id,
    isOwnerOnly: false,
    link: { route: "asset.detail", params: { storeAssetId: asset.id, storeId: own.store.id } },
  });
  expect(
    await h.tx.run((t) =>
      h.service.onEvent(t, {
        id: uuidv7(),
        type: "asset.adopted",
        payload: { v: 1, storeAssetId: staffAsset.id },
      }),
    ),
  ).toBe(0);
  await h.prisma.storeMember.delete({
    where: { entityMemberId_storeId: { entityMemberId: member.id, storeId: own.store.id } },
  });
  expect(
    await h.tx.run((t) =>
      h.service.onEvent(t, {
        id: uuidv7(),
        type: "asset.adopted",
        payload: { v: 1, storeAssetId: asset.id },
      }),
    ),
  ).toBe(0);
});
