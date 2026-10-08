import { beforeAll, afterAll, expect, it } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import { useSeededDatabase, notificationFixture } from "../testing/index.js";
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

it("同账号两次真实新微信绑定分别通知并排除对应新身份，旧event跨绑定重放不新增", async () => {
  const own = await h.merchant(),
    now = h.clock.now();
  const identities = [];
  for (let index = 0; index < 3; index++)
    identities.push(
      await h.prisma.wechatIdentity.create({
        data: {
          id: uuidv7(),
          merchantUserId: own.user.id,
          appid: h.deps.appid!,
          openid: `fictional-occurrence-${uuidv7()}`,
          lastLoginAt: now,
          lastActiveAt: now,
          createdAt: now,
          updatedAt: now,
        },
      }),
    );
  const events = identities.slice(1).map((identity) => ({
    id: uuidv7(),
    type: "merchant_user.wechat_bound",
    payload: { v: 1, merchantUserId: own.user.id, wechatIdentityId: identity.id },
  }));
  const made = [];
  for (const event of events) made.push(await h.tx.run((tx) => h.service.onEvent(tx, event)));
  const replay = await Promise.all(
    events.map((event) => h.tx.run((tx) => h.service.onEvent(tx, event))),
  );
  expect(made).toEqual([1, 1]);
  expect(replay).toEqual([0, 0]);
  const notifications = await h.prisma.notification.findMany({
    where: { bizId: own.user.id, notifySceneKey: "m.account_security" },
    orderBy: { sourceOutboxEventId: "asc" },
  });
  expect(notifications).toHaveLength(2);
  for (const event of events) {
    const notification = notifications.find((row) => row.sourceOutboxEventId === event.id);
    expect(notification?.vars).toMatchObject({
      excludeWechatIdentityId: event.payload.wechatIdentityId,
    });
    expect(
      await h.prisma.merchantMessage.count({ where: { notificationId: notification!.id } }),
    ).toBe(1);
    expect(
      await h.prisma.notificationDelivery.findMany({
        where: { notificationId: notification!.id },
        orderBy: { channel: "asc" },
      }),
    ).toMatchObject([
      { channel: "inbox", status: "sent" },
      { channel: "sms", status: "pending" },
    ]);
  }
});

async function pendingReview(
  own: Pick<Awaited<ReturnType<typeof h.merchant>>, "user" | "entity" | "store">,
  kind: "qualification" | "channel_account",
  subjectId: string,
  roundNo: number,
) {
  return h.prisma.approvalRequest.create({
    data: {
      id: uuidv7(),
      kind,
      category: "review",
      subjectType: kind === "qualification" ? "store" : "channel_account",
      subjectId,
      entityId: own.entity.id,
      storeId: own.store.id,
      roundNo,
      status: "pending",
      summarySnapshot: { title: "虚构重复审核轮次" },
      submitActorType: "merchant",
      submitActorId: own.user.id,
      submitClient: "weapp",
      submittedAt: h.clock.now(),
      dedupeKey: `${kind}:${subjectId}`,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
}

it("同门店真实资质两轮提交及驳回各通知一次，旧event跨轮重放不新增", async () => {
  const own = await h.make.merchant(),
    staff = await h.make.staff(),
    now = h.clock.now();
  const events: Parameters<typeof h.service.onEvent>[1][] = [],
    made = [];
  let previousId: string | null = null;
  for (const roundNo of [1, 2]) {
    const approval = await pendingReview(own, "qualification", own.store.id, roundNo);
    const submissionId = uuidv7();
    await h.prisma.qualificationSubmission.create({
      data: {
        id: submissionId,
        entityId: own.entity.id,
        storeId: own.store.id,
        kind: "initial",
        roundNo,
        resubmitOfQualificationSubmissionId: previousId,
        claimedEntityType: "enterprise",
        proposedStoreName: "虚构资质门店",
        proposedIndustryCode: "fictional",
        proposedCategoryCode: "fictional",
        proposedAddressSnapshot: { detail: "虚构地址" },
        declarationConfirmedAt: now,
        declarationVersion: "fictional",
        approvalRequestId: approval.id,
        submittedAt: now,
        submittedByUserId: own.user.id,
        createdByUserId: own.user.id,
        createdAt: now,
        updatedAt: now,
      },
    });
    const submitted = {
      id: uuidv7(),
      type: "store.qualification.submitted",
      payload: {
        v: 1,
        storeId: own.store.id,
        entityId: own.entity.id,
        submissionId,
        kind: "initial",
        roundNo,
      },
    };
    made.push(
      await h.tx.run(async (tx) => {
        await tx.store.update({
          where: { id: own.store.id },
          data: { qualificationStatus: "pending", name: "虚构资质门店" },
        });
        return h.service.onEvent(tx, submitted);
      }),
    );
    const rejected = {
      id: uuidv7(),
      type: "store.qualification.rejected",
      payload: {
        v: 1,
        storeId: own.store.id,
        entityId: own.entity.id,
        submissionId,
        isFinal: false,
        reasonCodes: ["fictional"],
        isSystem: false,
      },
    };
    made.push(
      await h.tx.run(async (tx) => {
        await tx.approvalRequest.update({
          where: { id: approval.id },
          data: {
            status: "rejected",
            decidedAt: now,
            decidedByStaffId: staff.id,
            decisionNote: "虚构审核驳回",
            reasonCodes: ["fictional"],
          },
        });
        await tx.qualificationSubmission.update({
          where: { id: submissionId },
          data: { closedAt: now, outcome: "rejected" },
        });
        await tx.store.update({
          where: { id: own.store.id },
          data: { qualificationStatus: "rejected" },
        });
        return h.service.onEvent(tx, rejected);
      }),
    );
    events.push(submitted, rejected);
    previousId = submissionId;
  }
  const replay = await Promise.all(
    events.map((event) => h.tx.run((tx) => h.service.onEvent(tx, event))),
  );
  expect(made).toEqual([1, 1, 1, 1]);
  expect(replay).toEqual([0, 0, 0, 0]);
  expect(
    await h.prisma.qualificationSubmission.findMany({
      where: { storeId: own.store.id },
      orderBy: { roundNo: "asc" },
    }),
  ).toMatchObject([
    { roundNo: 1, outcome: "rejected" },
    { roundNo: 2, outcome: "rejected" },
  ]);
  expect(await h.prisma.notification.count({ where: { bizId: own.store.id } })).toBe(4);
  expect(
    await h.prisma.merchantMessage.count({ where: { notification: { bizId: own.store.id } } }),
  ).toBe(4);
  expect(
    await h.prisma.notificationDelivery.count({
      where: { channel: "inbox", notification: { bizId: own.store.id } },
    }),
  ).toBe(4);
});

it("同渠道账号真实两轮审核驳回分别通知，旧event跨重新提交重放不新增", async () => {
  const own = await h.merchant(),
    staff = await h.make.staff(),
    now = h.clock.now();
  const accountId = uuidv7();
  await h.prisma.channelAccount.create({
    data: {
      id: accountId,
      entityId: own.entity.id,
      storeId: own.store.id,
      platform: "douyin",
      accountName: "虚构审核账号",
      accountUid: accountId,
      accountUidNorm: accountId,
      status: "pending_verify",
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  const events: Parameters<typeof h.service.onEvent>[1][] = [],
    made = [];
  for (const roundNo of [1, 2]) {
    const approval = await pendingReview(own, "channel_account", accountId, roundNo);
    const screenshot = await h.make.fileObject({
      entityId: own.entity.id,
      storeId: own.store.id,
      category: "channel_screenshot",
      bucket: "asset",
      scopeType: "store",
      uploadActorType: "merchant",
      uploadActorId: own.user.id,
      uploadClient: "weapp",
    });
    await h.prisma.channelAccountSubmission.create({
      data: {
        id: uuidv7(),
        entityId: own.entity.id,
        storeId: own.store.id,
        channelAccountId: accountId,
        roundNo,
        kind: roundNo === 1 ? "new_binding" : "resubmit",
        filledSnapshot: {
          platform: "douyin",
          accountName: "虚构审核账号",
          accountUid: accountId,
          accountType: "none",
        },
        screenshotFileIds: [screenshot.id],
        approvalRequestId: approval.id,
        submittedByUserId: own.user.id,
        submittedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    const event = {
      id: uuidv7(),
      type: "account.abnormal",
      payload: {
        v: 1,
        channelAccountId: accountId,
        entityId: own.entity.id,
        storeId: own.store.id,
        fromState: "pending_verify",
        toState: "abnormal",
        transition: "account.verify_reject",
        abnormalSource: "verify",
        reasonCode: "fictional",
      },
    };
    made.push(
      await h.tx.run(async (tx) => {
        await tx.approvalRequest.update({
          where: { id: approval.id },
          data: {
            status: "rejected",
            decidedAt: now,
            decidedByStaffId: staff.id,
            decisionNote: "虚构审核驳回",
            reasonCodes: ["fictional"],
          },
        });
        await tx.channelAccount.update({
          where: { id: accountId },
          data: {
            status: "abnormal",
            abnormalSource: "verify",
            abnormalReasonCode: "fictional",
            abnormalNote: "虚构核验失败",
          },
        });
        return h.service.onEvent(tx, event);
      }),
    );
    events.push(event);
    if (roundNo === 1)
      await h.prisma.channelAccount.update({
        where: { id: accountId },
        data: {
          status: "pending_verify",
          abnormalSource: null,
          abnormalReasonCode: null,
          abnormalNote: null,
        },
      });
  }
  const replay = await Promise.all(
    events.map((event) => h.tx.run((tx) => h.service.onEvent(tx, event))),
  );
  expect(made).toEqual([1, 1]);
  expect(replay).toEqual([0, 0]);
  expect(
    await h.prisma.channelAccountSubmission.findMany({
      where: { channelAccountId: accountId },
      orderBy: { roundNo: "asc" },
    }),
  ).toMatchObject([
    { roundNo: 1, kind: "new_binding" },
    { roundNo: 2, kind: "resubmit" },
  ]);
  expect(await h.prisma.notification.count({ where: { bizId: accountId } })).toBe(2);
  expect(
    await h.prisma.merchantMessage.count({ where: { notification: { bizId: accountId } } }),
  ).toBe(2);
  expect(
    await h.prisma.notificationDelivery.count({
      where: { channel: "inbox", notification: { bizId: accountId } },
    }),
  ).toBe(2);
});
