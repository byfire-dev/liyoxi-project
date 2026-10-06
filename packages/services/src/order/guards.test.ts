import { beforeAll, describe, expect, it } from "vitest";
import type { OrderCreateBody } from "@liyoxi/contract";
import { useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { harness, buyer, drama, body, version, residual } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
  await version(h);
}, 120000);
const cases = [
  ["建档", "STORE_PROFILE_INCOMPLETE"],
  ["闸门", "STORE_NOT_QUALIFIED"],
  ["行业", "INDUSTRY_NOT_OPEN"],
  ["未开通", "SUBSCRIPTION_INACTIVE"],
  ["退款", "PLAN_REFUND_IN_PROGRESS"],
  ["未上架", "DRAMA_NOT_ORDERABLE"],
  ["停止订购", "DRAMA_NOT_ORDERABLE"],
  ["平台", "DRAMA_NOT_ORDERABLE"],
  ["许可", "DRAMA_NOT_ORDERABLE"],
  ["外店账号", "ORDER_ACCOUNT_INVALID"],
  ["账号不可用", "ORDER_ACCOUNT_INVALID"],
  ["广告留桩", "ORDER_AD_INVALID"],
  ["素材留桩", "VALIDATION_FAILED"],
  ["上线日", "LAUNCH_DATE_TOO_EARLY"],
  ["协议", "AGREEMENT_VERSION_STALE"],
  ["重点", "VALIDATION_FAILED"],
] as const;
describe("同源守卫及失败事务", { timeout: 60000 }, () => {
  it.each(cases)("%s → %s，整单无残留", async (label, code) => {
    const b = await buyer(h),
      d = await drama(h),
      input: OrderCreateBody = await body(h, b, [d.id]);
    if (label === "建档")
      await h.prisma.storeProfile.update({
        where: { storeId: b.store.id },
        data: { brandName: null },
      });
    if (label === "闸门")
      await h.prisma.store.update({
        where: { id: b.store.id },
        data: { qualificationStatus: "unsubmitted" },
      });
    if (label === "行业")
      await h.prisma.storeProfile.update({
        where: { storeId: b.store.id },
        data: { categoryCode: "closed_unknown" },
      });
    if (label === "未开通") h.clock.set(new Date(b.term!.endsAt.getTime() + 1));
    if (label === "退款") {
      const f = await h.make.staff({ staffRoleKey: "finance" }),
        paid = await h.make.billingOrder({ entityId: b.entity.id, status: "paid" }),
        id = uuidv7(),
        now = h.clock.now();
      const approval = await h.prisma.approvalRequest.create({
        data: {
          id: uuidv7(),
          requestNo: `TK20260105${uuidv7().replaceAll("-", "")}`,
          kind: "plan_refund",
          category: "approval",
          subjectType: "billing_order",
          subjectId: paid.id,
          entityId: b.entity.id,
          status: "pending",
          summarySnapshot: { title: "套餐退款验收" },
          submitActorType: "staff",
          submitActorId: f.id,
          submitClient: "admin",
          requesterStaffId: f.id,
          submittedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      });
      const request = await h.prisma.refundRequest.create({
        data: {
          id,
          approvalRequestId: approval.id,
          entityId: b.entity.id,
          billingOrderId: paid.id,
          paymentTxnId: paid.paidPaymentTxnId!,
          source: "customer_service",
          baseAmountFen: paid.amountFen,
          amountFen: paid.amountFen,
          breakdownSnapshot: {},
          ruleCode: "window",
          ruleText: "测试退款中",
          reasonCode: "merchant_request",
          status: "pending_approval",
          createdAt: now,
          updatedAt: now,
        },
      });
      await h.prisma.subscriptionTerm.update({
        where: { id: b.term!.id },
        data: { refundRequestId: request.id, refundRule: "window" },
      });
    }
    if (label === "未上架")
      await h.prisma.drama.update({
        where: { id: d.id },
        data: { status: "delisted", delistedAt: h.clock.now(), delistReasonCode: "ops_strategy" },
      });
    if (label === "停止订购")
      await h.prisma.dramaCopyright.update({
        where: { dramaId: d.id },
        data: { licenseEndDate: new Date("2020-01-01") },
      });
    if (label === "平台")
      await h.prisma.dramaCopyright.update({
        where: { dramaId: d.id },
        data: { platforms: ["wechat_channels"] },
      });
    if (label === "许可")
      await h.prisma.dramaPermit.updateMany({
        where: { dramaId: d.id },
        data: { status: "retired", retiredAt: h.clock.now(), retireReason: "测试" },
      });
    if (label === "外店账号") input.channelAccountIds = [uuidv7()];
    if (label === "账号不可用")
      await h.prisma.channelAccount.update({
        where: { id: b.accountId },
        data: { status: "pending_verify", verifiedAt: null, verifiedByStaffId: null },
      });
    if (label === "广告留桩") input.adIds = [uuidv7()];
    if (label === "素材留桩") input.referenceStoreAssetIds = [uuidv7()];
    if (label === "上线日") input.expectedLaunchDate = "2020-01-01";
    if (label === "协议") input.agreementVersionId = uuidv7();
    if (label === "重点") input.focusCodes = ["unknown"];
    const before = await h.prisma.pointLot.aggregate({
      where: { entityId: b.entity.id },
      _sum: { availableQty: true, heldQty: true },
    });
    await expect(h.order.create(b.actor, input)).rejects.toMatchObject({ error: code });
    expect(await residual(h, b.entity.id)).toEqual({ orders: 0, items: 0, holds: 0, consents: 0 });
    expect(
      await h.prisma.pointLot.aggregate({
        where: { entityId: b.entity.id },
        _sum: { availableQty: true, heldQty: true },
      }),
    ).toEqual(before);
    if (
      [
        "建档",
        "闸门",
        "行业",
        "未上架",
        "停止订购",
        "平台",
        "许可",
        "外店账号",
        "账号不可用",
        "退款",
      ].includes(label)
    ) {
      const q = await h.order.quote(b.actor, {
        dramaIds: [d.id],
        isTopModel: false,
        channelAccountIds: input.channelAccountIds,
      });
      expect(q.blockers.map((e) => e.code)).toContain(code);
      if (label === "退款") {
        expect(q.spendablePoints).toBe(0);
        expect(q.pointsShortfall).toBe(q.totalChargePoints);
        expect(q.allocation).toEqual({ planLots: [], addonPoints: 0 });
        expect(q.balanceAfter).toEqual({ planPoints: 6600, addonPoints: 0 });
      }
    }
    // 恢复可拨时钟，其他用例不继承已到期时间。
    h.clock.set(new Date("2026-01-05T04:00:00Z"));
  });
});
