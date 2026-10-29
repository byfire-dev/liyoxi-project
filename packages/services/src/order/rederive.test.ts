import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlanContentSchema } from "@liyoxi/contract";
import { createClock, useSeededDatabase } from "../testing/index.js";
import { reevaluate, orderSidePort } from "../delivery/index.js";
import { createIdempotencyContext, lockRows, uuidv7 } from "../kernel/index.js";
import { bindOrder, boundOrder } from "./binding.js";
import { detail } from "./read.js";
import { earliestLaunch } from "./checks.js";
import { findDerivedViolations } from "./derived-invariants.js";
import { harness } from "./__fixtures__/harness.js";
import { derivedHarness } from "./__fixtures__/derived-harness.js";
import type { DerivedHarness } from "./__fixtures__/derived-harness.js";
const db = useSeededDatabase("services");
let h: DerivedHarness;
beforeAll(async () => {
  h = derivedHarness(harness(await db.prisma()));
}, 120000);
afterAll(() => h?.clear());
const side = () => h.assembly.port(orderSidePort);
async function counts(id: string) {
  return {
    history: await h.prisma.statusTransition.count({ where: { subjectId: id } }),
    events: await h.prisma.outboxEvent.count({ where: { aggregateId: id } }),
    audit: await h.prisma.auditLog.count({ where: { targetId: id } }),
  };
}
async function delivered(count = 1) {
  const o = await h.orderFixture(count),
    id = o.items[0]!.id;
  // 已交付/停滞事实夹具；本包只负责真port+flow推导，不提前实现W1-16 PR2成片推送。
  await h.prisma.deliveryTicket.update({
    where: { id: o.deliveryTicketIds[0]! },
    data: { step: "awaiting_launch" },
  });
  return { ...o, id };
}
describe("真实订单侧端口、同事务物化", { timeout: 60000 }, () => {
  it("合法前向自愈只有一条项历史/父事件；同事实第二次完全不写", async () => {
    const o = await delivered(),
      first = await counts(o.id);
    await h.tx.run((tx) => side().rederive(tx, { orderItemIds: [o.id] }));
    expect(await counts(o.id)).toEqual({
      history: first.history + 1,
      audit: first.audit + 1,
      events: first.events,
    });
    expect(await h.prisma.dramaOrder.findUnique({ where: { id: o.o.id } })).toMatchObject({
      status: "to_launch",
      subStatus: "awaiting_links",
    });
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: o.o.id, eventType: "order.status_changed" },
      }),
    ).toBe(1);
    const after = await counts(o.id),
      parent = await counts(o.o.id);
    await h.tx.run((tx) => side().rederive(tx, { orderItemIds: [o.id] }));
    expect(await counts(o.id)).toEqual(after);
    expect(await counts(o.o.id)).toEqual(parent);
  });
  it("真实delivery求值到in_service；首日/集数同UPDATE，首上线只发一次，混合单仍制作中", async () => {
    const o = await delivered(2);
    await h.tx.run((tx) => side().rederive(tx, { orderItemIds: [o.id] }));
    await h.prisma.launchTask.create({
      data: {
        id: uuidv7(),
        entityId: o.b.entity.id,
        storeId: o.b.store.id,
        orderItemId: o.id,
        deliveryTicketId: o.deliveryTicketIds[0]!,
        channelAccountId: o.b.accountId,
        platform: "douyin",
        reviewStatus: "passed",
        currentRoundNo: 1,
        isLive: true,
        firstLaunchDate: new Date("2026-01-05"),
        wentLiveAt: h.clock.now(),
        verifiedEpisodeCount: 2,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    await h.tx.run((tx) => reevaluate(tx, h.core, o.b.actor.ctx, o.deliveryTicketIds[0]!));
    expect(await h.prisma.orderItem.findUnique({ where: { id: o.id } })).toMatchObject({
      phase: "live",
      usageStartDate: new Date("2026-01-05"),
      liveEpisodeCount: 2,
    });
    expect(await h.prisma.dramaOrder.findUnique({ where: { id: o.o.id } })).toMatchObject({
      status: "producing",
    });
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: o.id, eventType: "order.item.went_live" },
      }),
    ).toBe(1);
    const before = await counts(o.id);
    await h.tx.run((tx) => reevaluate(tx, h.core, o.b.actor.ctx, o.deliveryTicketIds[0]!));
    expect(await counts(o.id)).toEqual(before);
  });
  it("真实delivery迁移后故障回滚工单/项/父/历史/事件，重试一次成功", async () => {
    const o = await delivered();
    await h.tx.run((tx) => side().rederive(tx, { orderItemIds: [o.id] }));
    await h.prisma.launchTask.create({
      data: {
        id: uuidv7(),
        entityId: o.b.entity.id,
        storeId: o.b.store.id,
        orderItemId: o.id,
        deliveryTicketId: o.deliveryTicketIds[0]!,
        channelAccountId: o.b.accountId,
        platform: "douyin",
        reviewStatus: "passed",
        currentRoundNo: 1,
        isLive: true,
        firstLaunchDate: new Date("2026-01-05"),
        wentLiveAt: h.clock.now(),
        verifiedEpisodeCount: 1,
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const before = {
      item: await counts(o.id),
      parent: await counts(o.o.id),
      ticket: await counts(o.deliveryTicketIds[0]!),
    };
    await expect(
      h.tx.run(async (tx) => {
        await reevaluate(tx, h.core, o.b.actor.ctx, o.deliveryTicketIds[0]!);
        throw new Error("after callback");
      }),
    ).rejects.toThrow("after callback");
    expect(await h.prisma.orderItem.findUnique({ where: { id: o.id } })).toMatchObject({
      phase: "to_launch",
      usageStartDate: null,
      liveEpisodeCount: 0,
    });
    expect(
      await h.prisma.deliveryTicket.findUnique({ where: { id: o.deliveryTicketIds[0]! } }),
    ).toMatchObject({ step: "awaiting_launch" });
    expect({
      item: await counts(o.id),
      parent: await counts(o.o.id),
      ticket: await counts(o.deliveryTicketIds[0]!),
    }).toEqual(before);
    await h.tx.run((tx) => reevaluate(tx, h.core, o.b.actor.ctx, o.deliveryTicketIds[0]!));
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: o.id, eventType: "order.item.went_live" },
      }),
    ).toBe(1);
  });
  it("同一facts不能复制给两个订单项；非live最大计数不会触发首上线", async () => {
    const o = await delivered(2),
      facts = {
        hasLive: false,
        hasVerifying: false,
        liveEpisodeCount: 3,
        firstLaunchDate: null,
        accounts: [
          {
            channelAccountId: o.b.accountId,
            isLive: false,
            verifiedEpisodeCount: 3,
            firstLaunchDate: null,
          },
        ],
      };
    await expect(
      h.tx.run((tx) =>
        side().rederive(tx, { orderItemIds: o.items.map((i) => i.id), launchFacts: facts }),
      ),
    ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
    await h.tx.run((tx) => side().rederive(tx, { orderItemIds: [o.id], launchFacts: facts }));
    expect(await h.prisma.orderItem.findUnique({ where: { id: o.id } })).toMatchObject({
      phase: "to_launch",
      usageStartDate: null,
      liveEpisodeCount: 0,
    });
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: o.id, eventType: "order.item.went_live" },
      }),
    ).toBe(0);
  });
  it("作用域乱序解绑不污染仍活动的绑定", () => {
    const older = bindOrder({ ...h.binding, clock: createClock() }),
      newerBinding = { ...h.binding, clock: createClock() },
      newer = bindOrder(newerBinding);
    older();
    expect(boundOrder()).toBe(newerBinding);
    newer();
    expect(boundOrder()).toBe(h.binding);
  });
  it("真实待上线审核状态经delivery投影：verifying优先、need_fix回补、过期覆盖，已上线不被另一平台退回", async () => {
    const o = await delivered(),
      account = await h.prisma.channelAccount.findUniqueOrThrow({ where: { id: o.b.accountId } }),
      otherAccountId = uuidv7();
    await h.prisma.channelAccount.create({
      data: {
        ...account,
        id: otherAccountId,
        platform: "wechat_channels",
        accountUid: otherAccountId,
        accountUidNorm: otherAccountId,
      },
    });
    const task = {
      entityId: o.b.entity.id,
      storeId: o.b.store.id,
      orderItemId: o.id,
      deliveryTicketId: o.deliveryTicketIds[0]!,
      currentRoundNo: 1,
      isLive: false,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    };
    const returnedId = uuidv7(),
      verifyingId = uuidv7();
    await h.prisma.launchTask.create({
      data: {
        ...task,
        id: returnedId,
        channelAccountId: o.b.accountId,
        platform: "douyin",
        reviewStatus: "need_fix",
      },
    });
    const evaluate = () =>
      h.tx.run((tx) => reevaluate(tx, h.core, o.b.actor.ctx, o.deliveryTicketIds[0]!));
    const state = () => h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: o.o.id } });
    await evaluate();
    expect(await state()).toMatchObject({ status: "to_launch", subStatus: "need_fix" });
    await h.prisma.launchTask.create({
      data: {
        ...task,
        id: verifyingId,
        channelAccountId: otherAccountId,
        platform: "wechat_channels",
        reviewStatus: "verifying",
      },
    });
    await evaluate();
    expect(await state()).toMatchObject({ subStatus: "verifying" });
    await h.prisma.launchTask.update({
      where: { id: verifyingId },
      data: { reviewStatus: "void", voidReason: "account_changed" },
    });
    await evaluate();
    expect(await state()).toMatchObject({ subStatus: "need_fix" });
    const item = await h.prisma.orderItem.findUniqueOrThrow({ where: { id: o.id } });
    // 北京今天为1月5日：止日当天仍可提交；只有超过止日才覆盖补件状态。
    await h.prisma.orderItem.update({
      where: { id: o.id },
      data: { usageEndDate: new Date("2026-01-05") },
    });
    await evaluate();
    expect(await state()).toMatchObject({ subStatus: "need_fix" });
    // 到期会真实收尾进 takedown；用独立未上线订单验证，不能为后续上线断言复活终态。
    const expired = await delivered(),
      expiredTaskId = uuidv7();
    await h.prisma.launchTask.create({
      data: {
        ...task,
        id: expiredTaskId,
        entityId: expired.b.entity.id,
        storeId: expired.b.store.id,
        orderItemId: expired.id,
        deliveryTicketId: expired.deliveryTicketIds[0]!,
        channelAccountId: expired.b.accountId,
        platform: "douyin",
        reviewStatus: "need_fix",
      },
    });
    await h.prisma.orderItem.update({
      where: { id: expired.id },
      data: { usageEndDate: new Date("2026-01-04") },
    });
    const evaluateExpired = () =>
      h.tx.run((tx) => reevaluate(tx, h.core, expired.b.actor.ctx, expired.deliveryTicketIds[0]!));
    const expiredState = () =>
      h.prisma.dramaOrder.findUniqueOrThrow({ where: { id: expired.o.id } });
    await evaluateExpired();
    expect(await expiredState()).toMatchObject({ subStatus: "expired_unlaunched" });
    expect(
      await h.prisma.deliveryTicket.findUniqueOrThrow({
        where: { id: expired.deliveryTicketIds[0]! },
      }),
    ).toMatchObject({ step: "takedown" });
    expect(
      await h.prisma.launchTask.findUniqueOrThrow({ where: { id: expiredTaskId } }),
    ).toMatchObject({ reviewStatus: "void", voidReason: "usage_expired" });
    await evaluateExpired();
    expect(await expiredState()).toMatchObject({ subStatus: "expired_unlaunched" });
    await h.prisma.launchTask.update({
      where: { id: verifyingId },
      data: { reviewStatus: "verifying", voidReason: null },
    });
    await h.prisma.orderItem.update({
      where: { id: o.id },
      data: { usageEndDate: item.usageEndDate },
    });
    await h.prisma.launchTask.update({
      where: { id: verifyingId },
      data: {
        reviewStatus: "passed",
        isLive: true,
        verifiedEpisodeCount: 1,
        firstLaunchDate: new Date("2026-01-05"),
        wentLiveAt: h.clock.now(),
      },
    });
    await evaluate();
    expect(await state()).toMatchObject({ status: "live", subStatus: "in_service" });
    const before = { item: await counts(o.id), parent: await counts(o.o.id) };
    await evaluate();
    expect({ item: await counts(o.id), parent: await counts(o.o.id) }).toEqual(before);
  });
  it("读侧来自真实公开工单/方案/阶段，GET聚合不写", async () => {
    const o = await h.orderFixture(),
      before = await counts(o.o.id);
    const view = await h.tx.run((tx) => detail(tx, o.b.actor, o.o.id));
    expect(view.items[0]).toMatchObject({
      ticketStep: "plan_confirm",
      timeline: expect.arrayContaining([
        { key: "manager_assigned", state: "done", at: h.clock.now().toISOString() },
      ]),
    });
    expect(view.deliveryPlan).toMatchObject({
      deliveryPlanId: o.deliveryPlanId,
      summaryVersionNo: null,
      focus: [],
      launchMode: null,
      placements: [],
    });
    expect(await counts(o.o.id)).toEqual(before);
  });
});
describe("真实方案确认账号差分与同TX", { timeout: 60000 }, () => {
  it("确认原样保留未变账号createdAt、推导子状态，不重验账号available", async () => {
    const o = await h.orderFixture(),
      beforeAccount = await h.prisma.orderItemAccount.findMany({
        where: { orderItemId: o.items[0]!.id },
      });
    await h.delivery.replaceDraft(o.staffCtx, o.staff, o.deliveryPlanId, {
      draftLockVersion: 0,
      content: {
        focusCodes: ["W115F"],
        referenceAssetIds: [],
        note: null,
        launchMode: "merchant_self",
        items: o.items.map((i) => ({
          orderItemId: i.id,
          channelAccountIds: [o.b.accountId],
          placements: [],
          agreedLaunchDate: "2026-01-20",
          expectedDeliveryDate: null,
        })),
      },
    });
    await h.delivery.push(o.staffCtx, o.staff, o.deliveryPlanId, { draftLockVersion: 1 });
    // 既定主契约：推送之后账号状态变化不能使确认新增available守卫。
    await h.prisma.channelAccount.update({
      where: { id: o.b.accountId },
      data: {
        status: "abnormal",
        abnormalSource: "manual",
        abnormalReasonCode: "test",
        abnormalNote: "测试人工标记异常",
      },
    });
    const key = uuidv7(),
      idem = () =>
        createIdempotencyContext({
          mode: "required",
          scope: "m.deliveryPlan.confirm",
          actor: o.b.actor.ctx.actor,
          key,
          request: { method: "POST", body: { versionNo: 1 } },
          redact: ["content.items[].posterUrl"],
        });
    await h.delivery.confirm(o.b.actor, o.deliveryPlanId, { versionNo: 1 }, { idem: idem() });
    expect(
      await h.prisma.orderItemAccount.findMany({ where: { orderItemId: o.items[0]!.id } }),
    ).toEqual(beforeAccount);
    expect(await h.prisma.orderItem.findUnique({ where: { id: o.items[0]!.id } })).toMatchObject({
      agreedLaunchDate: new Date("2026-01-20"),
      phase: "producing",
    });
    expect(await h.prisma.dramaOrder.findUnique({ where: { id: o.o.id } })).toMatchObject({
      subStatus: "sample_making",
    });
    expect(
      await h.prisma.outboxEvent.count({
        where: { aggregateId: o.deliveryPlanId, eventType: "plan.confirmed" },
      }),
    ).toBe(1);
    const before = {
        item: await counts(o.items[0]!.id),
        order: await counts(o.o.id),
        plan: await counts(o.deliveryPlanId),
      },
      replay = idem();
    await h.delivery.confirm(o.b.actor, o.deliveryPlanId, { versionNo: 1 }, { idem: replay });
    expect(replay.replayed).toBe(true);
    expect({
      item: await counts(o.items[0]!.id),
      order: await counts(o.o.id),
      plan: await counts(o.deliveryPlanId),
    }).toEqual(before);
  });
  it("直接端口核 immutable snapshot；已有account190锁时不逆序", async () => {
    const o = await h.orderFixture();
    const content = PlanContentSchema.parse(
      (await h.prisma.deliveryPlan.findUniqueOrThrow({ where: { id: o.deliveryPlanId } })).draft,
    );
    // 用真实push形成不可变版本，之后从同版本读取，不伪造端口输入。
    await h.delivery.replaceDraft(o.staffCtx, o.staff, o.deliveryPlanId, {
      draftLockVersion: 0,
      content: {
        focusCodes: ["W115F"],
        referenceAssetIds: [],
        note: null,
        launchMode: "merchant_self",
        items: o.items.map((i) => ({
          orderItemId: i.id,
          channelAccountIds: [o.b.accountId],
          placements: [],
          agreedLaunchDate: "2026-01-20",
          expectedDeliveryDate: null,
        })),
      },
    });
    await h.delivery.push(o.staffCtx, o.staff, o.deliveryPlanId, { draftLockVersion: 1 });
    const p = await h.prisma.deliveryPlanVersion.findFirstOrThrow({
      where: { deliveryPlanId: o.deliveryPlanId, versionNo: 1 },
    });
    const versionContent = PlanContentSchema.parse(p.contentSnapshot);
    await expect(
      h.tx.run((tx) =>
        side().applyConfirmedPlan(tx, {
          ctx: o.b.actor.ctx,
          dramaOrderId: o.o.id,
          deliveryPlanId: o.deliveryPlanId,
          versionNo: 1,
          content,
        }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await h.tx.run(async (tx) => {
      await lockRows(tx, "drama_order", [o.o.id]);
      await lockRows(
        tx,
        "order_item",
        o.items.map((i) => i.id),
      );
      await lockRows(tx, "channel_account", [o.b.accountId]);
      await lockRows(tx, "delivery_plan", [o.deliveryPlanId]);
      await side().applyConfirmedPlan(tx, {
        ctx: o.b.actor.ctx,
        dramaOrderId: o.o.id,
        deliveryPlanId: o.deliveryPlanId,
        versionNo: 1,
        content: versionContent,
      });
    });
  });
  it("账号增删保留未变行，合法日期两端允许；同版坏日期/外店账号/外单项拒绝且零写", async () => {
    const o = await h.orderFixture(),
      id = o.items[0]!.id;
    const existing = await h.prisma.channelAccount.findUniqueOrThrow({
      where: { id: o.b.accountId },
    });
    const obsolete = await h.prisma.channelAccount.create({
      data: {
        ...existing,
        id: uuidv7(),
        platform: "wechat_channels",
        accountUid: uuidv7(),
        accountUidNorm: uuidv7(),
      },
    });
    const incoming = await h.prisma.channelAccount.create({
      data: {
        ...existing,
        id: uuidv7(),
        platform: "wechat_channels",
        accountUid: uuidv7(),
        accountUidNorm: uuidv7(),
      },
    });
    await h.prisma.orderItemAccount.create({
      data: {
        orderItemId: id,
        channelAccountId: obsolete.id,
        platform: "wechat_channels",
        createdAt: h.clock.now(),
      },
    });
    await h.delivery.replaceDraft(o.staffCtx, o.staff, o.deliveryPlanId, {
      draftLockVersion: 0,
      content: {
        focusCodes: ["W115F"],
        referenceAssetIds: [],
        note: null,
        launchMode: "merchant_self",
        items: [
          {
            orderItemId: id,
            channelAccountIds: [o.b.accountId, incoming.id],
            placements: [],
            agreedLaunchDate: "2026-01-20",
            expectedDeliveryDate: null,
          },
        ],
      },
    });
    await h.delivery.push(o.staffCtx, o.staff, o.deliveryPlanId, { draftLockVersion: 1 });
    const v = await h.prisma.deliveryPlanVersion.findFirstOrThrow({
        where: { deliveryPlanId: o.deliveryPlanId, versionNo: 1 },
      }),
      original = PlanContentSchema.parse(v.contentSnapshot);
    let versionNo = 1;
    const invoke = async (content: typeof original) => {
      versionNo++;
      await h.prisma.deliveryPlanVersion.create({
        data: { ...v, id: uuidv7(), versionNo, contentSnapshot: content },
      });
      await h.prisma.deliveryPlan.update({
        where: { id: o.deliveryPlanId },
        data: { currentVersionNo: versionNo },
      });
      return h.tx.run((tx) =>
        side().applyConfirmedPlan(tx, {
          ctx: o.b.actor.ctx,
          dramaOrderId: o.o.id,
          deliveryPlanId: o.deliveryPlanId,
          versionNo,
          content,
        }),
      );
    };
    const min = await h.tx.run((tx) => earliestLaunch(tx, h.core, o.o.submittedAt)),
      max = o.items[0]!.usageEndDate.toISOString().slice(0, 10);
    const old = await h.prisma.orderItemAccount.findUniqueOrThrow({
      where: { orderItemId_channelAccountId: { orderItemId: id, channelAccountId: o.b.accountId } },
    });
    for (const agreedLaunchDate of [min, max]) {
      const content = structuredClone(original);
      content.items[0]!.agreedLaunchDate = agreedLaunchDate;
      await invoke(content);
      expect(
        (await h.prisma.orderItem.findUniqueOrThrow({ where: { id } })).agreedLaunchDate
          ?.toISOString()
          .slice(0, 10),
      ).toBe(agreedLaunchDate);
    }
    expect(
      await h.prisma.orderItemAccount.findMany({
        where: { orderItemId: id },
        orderBy: { channelAccountId: "asc" },
      }),
    ).toHaveLength(2);
    expect(
      await h.prisma.orderItemAccount.findUnique({
        where: { orderItemId_channelAccountId: { orderItemId: id, channelAccountId: obsolete.id } },
      }),
    ).toBeNull();
    expect(
      await h.prisma.orderItemAccount.findUnique({
        where: {
          orderItemId_channelAccountId: { orderItemId: id, channelAccountId: o.b.accountId },
        },
      }),
    ).toEqual(old);
    const foreign = await h.orderFixture(),
      itemBefore = await h.prisma.orderItem.findUniqueOrThrow({ where: { id } }),
      accountsBefore = await h.prisma.orderItemAccount.findMany({
        where: { orderItemId: id },
        orderBy: { channelAccountId: "asc" },
      });
    const badDate = structuredClone(original);
    badDate.items[0]!.agreedLaunchDate = "2026-01-01";
    await expect(invoke(badDate)).rejects.toMatchObject({ error: "LAUNCH_DATE_OUT_OF_RANGE" });
    badDate.items[0]!.agreedLaunchDate = "2028-01-01";
    await expect(invoke(badDate)).rejects.toMatchObject({ error: "LAUNCH_DATE_OUT_OF_RANGE" });
    const badAccount = structuredClone(original);
    badAccount.items[0]!.accounts = [{ channelAccountId: foreign.b.accountId, platform: "douyin" }];
    await expect(invoke(badAccount)).rejects.toMatchObject({ error: "ORDER_ACCOUNT_INVALID" });
    const badItem = structuredClone(original);
    badItem.items[0]!.orderItemId = foreign.items[0]!.id;
    await expect(invoke(badItem)).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await h.prisma.orderItem.findUniqueOrThrow({ where: { id } })).toEqual(itemBefore);
    expect(
      await h.prisma.orderItemAccount.findMany({
        where: { orderItemId: id },
        orderBy: { channelAccountId: "asc" },
      }),
    ).toEqual(accountsBefore);
  });
  it("I1缺失工单只告警；I2真实重新推导；不合法回退I3保留未自愈告警", async () => {
    const missing = await h.make.orderItem({ phase: "producing" });
    expect(
      await h.tx.run((tx) => findDerivedViolations(tx, "I1", { entityIds: [missing.entityId] })),
    ).toEqual([
      expect.objectContaining({
        subject: { type: "order_item", id: missing.id },
        detail: { phase: "producing", expectedTicketCount: 1, actualTicketCount: 0 },
      }),
    ]);
    const o = await h.orderFixture();
    await h.prisma.dramaOrder.update({
      where: { id: o.o.id },
      data: { status: "to_launch", subStatus: "awaiting_links" },
    });
    expect(
      await h.tx.run((tx) => findDerivedViolations(tx, "I2", { entityIds: [o.b.entity.id] })),
    ).toEqual([
      expect.objectContaining({ healed: { action: expect.any(String), at: h.clock.now() } }),
    ]);
    expect(await h.prisma.dramaOrder.findUnique({ where: { id: o.o.id } })).toMatchObject({
      status: "producing",
      subStatus: "plan_confirm",
    });
    await h.prisma.orderItem.update({
      where: { id: o.items[0]!.id },
      data: { phase: "to_launch" },
    });
    const before = await counts(o.items[0]!.id),
      violations = await h.tx.run((tx) =>
        findDerivedViolations(tx, "I3", { entityIds: [o.b.entity.id] }),
      );
    expect(violations).toEqual([
      expect.objectContaining({
        detail: { phase: "to_launch", expected: "producing", ticketStep: "plan_confirm" },
      }),
    ]);
    expect(violations[0]).not.toHaveProperty("healed");
    expect(await counts(o.items[0]!.id)).toEqual(before);
  });
});
