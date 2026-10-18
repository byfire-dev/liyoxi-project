import { afterEach, beforeEach, expect, it } from "vitest";
import { addDays, endOfDay, calendarDate } from "@liyoxi/shared/time";
import {
  captureHold,
  holdDrama,
  priceDrama,
  refundHold,
  snapshotTables,
  useSeededDatabase,
} from "../../testing/index.js";
import { createIdempotencyContext, uuidv7 } from "../../kernel/index.js";
import {
  world,
  tables,
  ledgerTables,
  pointConfirm,
  extensionConfirm,
} from "./__fixtures__/world.js";
import type { World } from "./__fixtures__/world.js";

const db = useSeededDatabase("services", { max: 1 });
let h: World;
beforeEach(async () => {
  await db.reset();
  h = await world(await db.prisma());
}, 60000);
afterEach(() => h?.close());

it("提交零动账，拒绝自己审批、旧版本和确认不符；通过只记一次真实调整与同TX领域结果", async () => {
  const who = await h.subscribed(),
    proposer = await h.actor(),
    decider = await h.actor("finance");
  const before = await snapshotTables(h.prisma, ledgerTables);
  const r = await h.svc.points.create(
    proposer,
    await h.adjustmentInput(who.entityId, { note: "补".repeat(200), storeId: who.storeId }),
  );
  expect(r).toMatchObject({
    applied: null,
    approval: { status: "pending" },
    spendableBeforePoints: 6600,
  });
  expect(await snapshotTables(h.prisma, ledgerTables)).toEqual(before);
  const pending = await snapshotTables(h.prisma, tables);
  await expect(
    h.svc.points.approve(proposer, r.pointAdjustmentRequestId, pointConfirm(r)),
  ).rejects.toMatchObject({ error: "APPROVAL_SELF_FORBIDDEN" });
  await expect(
    h.svc.points.approve(decider, r.pointAdjustmentRequestId, {
      ...pointConfirm(r),
      lockVersion: 1,
    }),
  ).rejects.toMatchObject({ error: "VERSION_CONFLICT" });
  await expect(
    h.svc.points.approve(decider, r.pointAdjustmentRequestId, {
      ...pointConfirm(r),
      confirm: { ...pointConfirm(r).confirm, adjustPoints: 101 },
    }),
  ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(pending);
  const body = pointConfirm(r),
    key = uuidv7();
  const idem = () => ({
    idem: createIdempotencyContext({
      mode: "required",
      scope: "admin.pointAdjustmentRequest.approve",
      key,
      actor: decider.identity.actor,
      request: {
        method: "POST",
        pathParams: { pointAdjustmentRequestId: r.pointAdjustmentRequestId },
        body,
      },
    }),
  });
  const approved = await h.svc.points.approve(decider, r.pointAdjustmentRequestId, body, idem());
  expect(approved).toMatchObject({
    approval: { status: "approved", confirmChecks: ["basis_checked"] },
    applied: { spendableAfterPoints: 6700 },
  });
  const domain = await h.prisma.pointAdjustmentRequest.findUniqueOrThrow({
    where: { id: r.pointAdjustmentRequestId },
  });
  const op = await h.prisma.ledgerOperation.findUniqueOrThrow({
    where: { id: domain.ledgerOperationId! },
  });
  expect(domain.appliedAt).toEqual(op.occurredAt);
  expect(op).toMatchObject({
    refType: "approval_request",
    refId: r.approval.approvalId,
    opType: "adjust",
    planDeltaQty: 100,
    spendableAfterQty: 6700,
  });
  expect(
    await h.prisma.pointLot.findFirstOrThrow({
      where: { sourceType: "adjust", sourceId: r.approval.approvalId },
    }),
  ).toMatchObject({ costBasisFen: 0, originalQty: 100, subscriptionTermId: who.term.id });
  const done = await snapshotTables(h.prisma, tables);
  expect(await h.svc.points.approve(decider, r.pointAdjustmentRequestId, body, idem())).toEqual(
    approved,
  );
  expect(await snapshotTables(h.prisma, tables)).toEqual(done);
  expect(
    await h.prisma.outboxEvent.count({
      where: { entityId: who.entityId, eventType: "billing.points.adjusted" },
    }),
  ).toBe(1);
}, 60000);

it("审批重新核实可扣余额；不足或写账中断均回滚pending，之后恢复可通过而不重复写历史", async () => {
  const who = await h.subscribed(),
    author = await h.actor(),
    reviewer = await h.actor("finance");
  const r = await h.svc.points.create(
    author,
    await h.adjustmentInput(who.entityId, {
      direction: "decrease",
      adjustPoints: 6000,
      reasonCode: "correction",
    }),
  );
  const drama = await h.make.drama(),
    staff = await h.make.staff();
  await priceDrama(h, { dramaId: drama.id, points: 1200, staffId: staff.id });
  await holdDrama(h, { ...who, dramaId: drama.id });
  const pending = await snapshotTables(h.prisma, tables);
  await expect(
    h.svc.points.approve(reviewer, r.pointAdjustmentRequestId, pointConfirm(r)),
  ).rejects.toMatchObject({ error: "PRECONDITION_CHANGED", details: { reason: "insufficient" } });
  expect(await snapshotTables(h.prisma, tables)).toEqual(pending);
  await h.svc.points.withdraw(author, r.pointAdjustmentRequestId, {});
  const gain = await h.svc.points.create(author, await h.adjustmentInput(who.entityId));
  const fault = h.faulty((step) => {
    if (step === "entry.insert") throw new Error("w408-write-fault");
  });
  const baseline = await snapshotTables(h.prisma, tables);
  try {
    await expect(
      fault.svc.points.approve(reviewer, gain.pointAdjustmentRequestId, pointConfirm(gain)),
    ).rejects.toThrow("w408-write-fault");
  } finally {
    fault.close();
  }
  expect(await snapshotTables(h.prisma, tables)).toEqual(baseline);
  expect(
    await h.svc.points.approve(reviewer, gain.pointAdjustmentRequestId, pointConfirm(gain)),
  ).toMatchObject({ approval: { status: "approved" }, applied: { spendableAfterPoints: 5620 } });
}, 60000);

it("平台退回必须关联真实已扣冻结；过期原套餐退回转加购，无现金退款或新增有价积分", async () => {
  const who = await h.subscribed(),
    author = await h.actor(),
    reviewer = await h.actor("finance"),
    drama = await h.make.drama(),
    staff = await h.make.staff();
  await priceDrama(h, { dramaId: drama.id, points: 1000, staffId: staff.id });
  const held = await holdDrama(h, { ...who, dramaId: drama.id });
  const invalid = await h.svc.adjustmentQuote(author, who.entityId, {
    direction: "increase",
    lotKind: "addon",
    adjustPoints: 300,
    reasonCode: "platform_refund",
    pointHoldId: held.pointHoldId,
  });
  expect(invalid).toMatchObject({ isAllowed: false, blockReasons: ["hold_invalid"] });
  await captureHold(h, held.pointHoldId);
  h.clock.set(new Date(who.term.endsAt.getTime() + 1000));
  const quote = await h.svc.adjustmentQuote(author, who.entityId, {
    direction: "increase",
    lotKind: "addon",
    adjustPoints: 300,
    reasonCode: "platform_refund",
    pointHoldId: held.pointHoldId,
  });
  expect(quote).toMatchObject({ isAllowed: true, spendableAfterPoints: 0, lotAvailableAfter: 300 });
  const r = await h.svc.points.create(
    author,
    await h.adjustmentInput(who.entityId, {
      lotKind: "addon",
      adjustPoints: 300,
      reasonCode: "platform_refund",
      pointHoldId: held.pointHoldId,
    }),
  );
  const result = await h.svc.points.approve(
    await h.reload(reviewer.staff.staff.id),
    r.pointAdjustmentRequestId,
    pointConfirm(r),
  );
  expect(result).toMatchObject({
    approval: { status: "approved" },
    applied: { spendableAfterPoints: 0 },
  });
  expect(
    await h.prisma.pointHold.findUniqueOrThrow({ where: { id: held.pointHoldId } }),
  ).toMatchObject({ status: "refunded_partial", returnedQty: 300 });
  expect(
    await h.prisma.pointLot.findFirstOrThrow({
      where: { entityId: who.entityId, sourceType: "conversion" },
    }),
  ).toMatchObject({ kind: "addon", originalQty: 300, availableQty: 300, subscriptionTermId: null });
  expect(await h.prisma.refundTxn.count()).toBe(0);
  expect(await h.prisma.refundRequest.count()).toBe(0);
  expect(
    await h.prisma.ledgerOperation.findUniqueOrThrow({
      where: { id: result.applied!.ledgerOperationId },
    }),
  ).toMatchObject({
    opType: "refund",
    refType: "approval_request",
    refId: r.approval.approvalId,
    addonDeltaQty: 300,
  });
  const tooMuch = await h.svc.adjustmentQuote(author, who.entityId, {
    direction: "increase",
    lotKind: "addon",
    adjustPoints: 701,
    reasonCode: "platform_refund",
    pointHoldId: held.pointHoldId,
  });
  expect(tooMuch).toMatchObject({ isAllowed: false, pointHold: { returnablePoints: 600 } });
}, 60000);

it("延长由同组不同主管决定，顺延当前和预约链，不补积分；驳回/撤回与停用代撤保持公共守卫", async () => {
  const who = await h.subscribed(),
    group = await h.group(),
    otherGroup = await h.group();
  const author = await h.actor("delivery_manager", group),
    reviewer = await h.actor("delivery_manager", group, true),
    outsider = await h.actor("delivery_manager", otherGroup, true);
  await h.prisma.store.update({
    where: { id: who.storeId },
    data: { deliveryManagerId: author.staff.staff.id },
  });
  const nextOrder = await pendingRenewal(who.entityId);
  const before = await snapshotTables(h.prisma, ledgerTables),
    r = await h.svc.extensions.create(author, h.extensionInput(who.term, 7));
  expect(await snapshotTables(h.prisma, ledgerTables)).toEqual(before);
  await expect(
    h.svc.extensions.approve(outsider, r.termExtensionRequestId, extensionConfirm(r)),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  // 同主体另有一店在范围内，仍不能跨发起人的组审批延长。
  await h.make.store({ entityId: who.entityId, deliveryManagerId: outsider.staff.staff.id });
  await expect(
    h.svc.extensions.approve(outsider, r.termExtensionRequestId, extensionConfirm(r)),
  ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  const applied = await h.svc.extensions.approve(
    reviewer,
    r.termExtensionRequestId,
    extensionConfirm(r),
  );
  expect(applied).toMatchObject({
    applied: {
      appliedMode: "extend",
      appliedSubscriptionTermId: who.term.id,
      prevEndDate: "2026-02-04",
      newEndDate: "2026-02-11",
    },
  });
  const next = await h.prisma.subscriptionTerm.findUniqueOrThrow({
    where: { sourceBillingOrderId: nextOrder.id },
  });
  expect(next.startDate.toISOString().slice(0, 10)).toBe("2026-02-12");
  expect(await h.prisma.pointLot.count({ where: { entityId: who.entityId } })).toBe(1);
  const current = await h.prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: who.term.id } });
  const second = await h.svc.extensions.create(author, h.extensionInput(current));
  const baseline = await snapshotTables(h.prisma, ledgerTables);
  expect(
    await h.svc.extensions.reject(reviewer, second.termExtensionRequestId, {
      note: "依据不足请补充",
    }),
  ).toMatchObject({ approval: { status: "rejected" } });
  expect(await snapshotTables(h.prisma, ledgerTables)).toEqual(baseline);
  const third = await h.svc.extensions.create(author, h.extensionInput(current));
  await h.prisma.staff.update({
    where: { id: author.staff.staff.id },
    data: { status: "disabled", disabledAt: h.clock.now(), disabledReason: "other" },
  });
  expect(
    await h.svc.extensions.withdraw(reviewer, third.termExtensionRequestId, {
      note: "发起人停用，代撤",
    }),
  ).toMatchObject({ approval: { status: "withdrawn" } });
  expect(await snapshotTables(h.prisma, ledgerTables)).toEqual(baseline);
}, 60000);

async function pendingRenewal(entityId: string) {
  const { pendingPlanOrder, transferReceipt, applyReceipt } =
    await import("../../testing/index.js");
  const pending = await pendingPlanOrder(h, { entityId });
  const order = await h.prisma.billingOrder.update({
    where: { id: pending.id },
    data: { type: "plan_renew" },
  });
  await applyReceipt(h, await transferReceipt(h, order));
  return order;
}

it("原期已续接后延长作用新期，旧期已清零积分不恢复；补积分需另张关联二人审批", async () => {
  const who = await h.subscribed(),
    author = await h.actor(),
    reviewer = await h.actor();
  await pendingRenewal(who.entityId);
  const extension = await h.svc.extensions.create(author, h.extensionInput(who.term, 3));
  h.clock.set(new Date(who.term.endsAt.getTime() + 1000));
  const quote = await h.svc.extensionQuote(author, who.term.id, 3);
  expect(quote).toMatchObject({
    targetSubscriptionTermId: expect.any(String),
    isTargetDifferent: true,
  });
  const result = await h.svc.extensions.approve(
    reviewer,
    extension.termExtensionRequestId,
    extensionConfirm(extension),
  );
  expect(result).toMatchObject({ applied: { appliedMode: "extend" } });
  expect(result.applied!.appliedSubscriptionTermId).not.toBe(who.term.id);
  expect(
    await h.prisma.ledgerOperation.count({ where: { entityId: who.entityId, opType: "unexpire" } }),
  ).toBe(0);
  const oldLots = await h.prisma.pointLot.findMany({ where: { subscriptionTermId: who.term.id } });
  expect(oldLots.map((lot) => [lot.availableQty, lot.expiredQty])).toEqual([[0, 6600]]);
  const adjustment = await h.svc.points.create(
    author,
    await h.adjustmentInput(who.entityId, {
      termExtensionRequestId: extension.termExtensionRequestId,
      adjustPoints: 40,
    }),
  );
  await expect(
    h.svc.points.approve(
      await h.reload(author.staff.staff.id),
      adjustment.pointAdjustmentRequestId,
      pointConfirm(adjustment),
    ),
  ).rejects.toMatchObject({ error: "APPROVAL_SELF_FORBIDDEN" });
  await h.svc.points.approve(
    await h.reload(reviewer.staff.staff.id),
    adjustment.pointAdjustmentRequestId,
    pointConfirm(adjustment),
  );
  expect(
    await h.svc.extensions.get(reviewer.staff, extension.termExtensionRequestId),
  ).toMatchObject({
    relatedAdjustments: [
      { pointAdjustmentRequestId: adjustment.pointAdjustmentRequestId, status: "approved" },
    ],
  });
}, 60000);

it("到期补批只恢复真实清零数量，排除旧forfeit；同TX恢复缓存/期限/事件，重复决定不追加", async () => {
  const who = await h.subscribed(),
    author = await h.actor(),
    reviewer = await h.actor(),
    drama = await h.make.drama(),
    staff = await h.make.staff();
  await priceDrama(h, { dramaId: drama.id, points: 1000, staffId: staff.id });
  h.clock.advance(1);
  await h.prisma.billingParam.create({
    data: {
      id: uuidv7(),
      key: "expiredTermRefund",
      value: { merchant: "forfeit", platform: "addon", qualification: "addon" },
      effectiveAt: h.clock.now(),
      changeId: uuidv7(),
      createdAt: h.clock.now(),
    },
  });
  const held = await holdDrama(h, { ...who, dramaId: drama.id });
  await captureHold(h, held.pointHoldId);
  const r = await h.svc.extensions.create(author, h.extensionInput(who.term, 7));
  h.clock.set(new Date(who.term.endsAt.getTime() + 2 * 86400000));
  await refundHold(h, { pointHoldId: held.pointHoldId, qty: 200, reasonClass: "merchant" });
  const lot = await h.prisma.pointLot.findFirstOrThrow({
    where: { subscriptionTermId: who.term.id },
  });
  expect(lot).toMatchObject({ availableQty: 0, expiredQty: 5900, consumedQty: 700 });
  const entries = await h.prisma.pointLedgerEntry.findMany({ orderBy: { seq: "asc" } });
  const result = await h.svc.extensions.approve(
    reviewer,
    r.termExtensionRequestId,
    extensionConfirm(r),
  );
  const expectedEnd = addDays(calendarDate(h.clock.now()), 6);
  expect(result).toMatchObject({
    approval: { status: "approved" },
    applied: { appliedMode: "revive", newEndDate: expectedEnd },
  });
  expect(
    await h.prisma.billingAccount.findUniqueOrThrow({ where: { entityId: who.entityId } }),
  ).toMatchObject({
    subStatus: "active",
    currentSubscriptionTermId: who.term.id,
    planAvailableQty: 5700,
  });
  expect(await h.prisma.pointLot.findUniqueOrThrow({ where: { id: lot.id } })).toMatchObject({
    availableQty: 5700,
    expiredQty: 200,
    consumedQty: 700,
    expiresAt: endOfDay(expectedEnd),
  });
  expect(
    await h.prisma.pointLedgerEntry.findMany({
      where: { id: { in: entries.map((e) => e.id) } },
      orderBy: { seq: "asc" },
    }),
  ).toEqual(entries);
  expect(await h.prisma.pointLot.count({ where: { entityId: who.entityId } })).toBe(1);
  expect(
    await h.prisma.outboxEvent.count({
      where: { entityId: who.entityId, eventType: "billing.subscription.resumed" },
    }),
  ).toBe(1);
  const after = await snapshotTables(h.prisma, tables);
  await expect(
    h.svc.extensions.approve(reviewer, r.termExtensionRequestId, extensionConfirm(r)),
  ).rejects.toMatchObject({ error: "APPROVAL_NOT_PENDING" });
  expect(await snapshotTables(h.prisma, tables)).toEqual(after);
}, 60000);

it("复活写入故障回滚整个审批，原未退款资格、原清零和账本缓存均不被部分提交", async () => {
  const who = await h.subscribed(),
    author = await h.actor(),
    reviewer = await h.actor();
  const r = await h.svc.extensions.create(author, h.extensionInput(who.term));
  h.clock.set(new Date(who.term.endsAt.getTime() + 1000));
  await h.tx.run((tx) => h.ledger.advance(tx, who.entityId));
  const before = await snapshotTables(h.prisma, tables),
    fault = h.faulty((step) => {
      if (step === "subscription_event.insert") throw new Error("w408-revive-fault");
    });
  try {
    await expect(
      fault.svc.extensions.approve(reviewer, r.termExtensionRequestId, extensionConfirm(r)),
    ).rejects.toThrow("w408-revive-fault");
  } finally {
    fault.close();
  }
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  expect(
    await h.svc.extensions.approve(reviewer, r.termExtensionRequestId, extensionConfirm(r)),
  ).toMatchObject({ approval: { status: "approved" }, applied: { appliedMode: "revive" } });
}, 60000);

it("points驳回不要求再验证；普通通过和已停用作者的代撤仍严格要求真实新鲜验证", async () => {
  const who = await h.subscribed(),
    author = await h.actor(),
    finance = await h.actor("finance");
  const r = await h.svc.points.create(author, await h.adjustmentInput(who.entityId));
  const stale = await h.reload(finance.staff.staff.id, false);
  await expect(
    h.svc.points.approve(stale, r.pointAdjustmentRequestId, pointConfirm(r)),
  ).rejects.toMatchObject({ error: "STEP_UP_REQUIRED" });
  expect(
    await h.svc.points.reject(stale, r.pointAdjustmentRequestId, { note: "核实依据不足" }),
  ).toMatchObject({ approval: { status: "rejected" } });
  const next = await h.svc.points.create(author, await h.adjustmentInput(who.entityId));
  await h.prisma.staff.update({
    where: { id: author.staff.staff.id },
    data: { status: "disabled", disabledAt: h.clock.now(), disabledReason: "other" },
  });
  await expect(
    h.svc.points.withdraw(stale, next.pointAdjustmentRequestId, {}),
  ).rejects.toMatchObject({ error: "STEP_UP_REQUIRED" });
  expect(await h.svc.points.withdraw(finance, next.pointAdjustmentRequestId, {})).toMatchObject({
    approval: { status: "withdrawn" },
  });
}, 60000);

it("billing.I18识别未执行approved/错误账本引用/时间/延长公式，后续再次延长不误报历史", async () => {
  const { adjustmentInvariants } = await import("./invariants.js");
  const rule = adjustmentInvariants[0]!;
  const who = await h.subscribed(),
    author = await h.actor(),
    reviewer = await h.actor();
  const p = await h.svc.points.create(author, await h.adjustmentInput(who.entityId));
  await h.svc.points.approve(reviewer, p.pointAdjustmentRequestId, pointConfirm(p));
  const e = await h.svc.extensions.create(author, h.extensionInput(who.term));
  await h.svc.extensions.approve(reviewer, e.termExtensionRequestId, extensionConfirm(e));
  const check = () =>
    h.tx.run((tx) => rule.run!(tx, { entityIds: [who.entityId] }, { now: h.clock.now() }));
  expect(await check()).toEqual([]);
  const term = await h.prisma.subscriptionTerm.findUniqueOrThrow({ where: { id: who.term.id } });
  const later = await h.svc.extensions.create(author, h.extensionInput(term, 3));
  await h.svc.extensions.approve(reviewer, later.termExtensionRequestId, extensionConfirm(later));
  expect(await check()).toEqual([]);
  const original = await h.prisma.pointAdjustmentRequest.findUniqueOrThrow({
    where: { id: p.pointAdjustmentRequestId },
  });
  await h.prisma.pointAdjustmentRequest.update({
    where: { id: original.id },
    data: { appliedAt: null, ledgerOperationId: null },
  });
  expect(await check()).toMatchObject([
    { subject: { type: "point_adjustment_request", id: original.id }, entityId: who.entityId },
  ]);
  await h.prisma.pointAdjustmentRequest.update({
    where: { id: original.id },
    data: { appliedAt: original.appliedAt, ledgerOperationId: original.ledgerOperationId },
  });
  const otherOp = await h.prisma.ledgerOperation.findFirstOrThrow({
    where: { entityId: who.entityId, opType: "grant" },
  });
  await h.prisma.pointAdjustmentRequest.update({
    where: { id: original.id },
    data: { ledgerOperationId: otherOp.id },
  });
  expect(await check()).toHaveLength(1);
  await h.prisma.pointAdjustmentRequest.update({
    where: { id: original.id },
    data: {
      ledgerOperationId: original.ledgerOperationId,
      appliedAt: new Date(original.appliedAt!.getTime() + 1),
    },
  });
  expect(await check()).toHaveLength(1);
  await h.prisma.pointAdjustmentRequest.update({
    where: { id: original.id },
    data: { appliedAt: original.appliedAt },
  });
  const ext = await h.prisma.termExtensionRequest.findUniqueOrThrow({
    where: { id: e.termExtensionRequestId },
  });
  await h.prisma.termExtensionRequest.update({
    where: { id: ext.id },
    data: { newEndDate: new Date(ext.newEndDate!.getTime() + 86400000) },
  });
  expect(await check()).toMatchObject([
    { subject: { type: "term_extension_request", id: ext.id } },
  ]);
  await h.prisma.termExtensionRequest.update({
    where: { id: ext.id },
    data: { newEndDate: ext.newEndDate },
  });
  expect(await check()).toEqual([]);
}, 60000);

it("完整清零复活冲回600000分真实成本，历史日投影与I1-I18适用检查保持守恒", async () => {
  const { computeEntityValuation, createBillingDailyProjection } = await import("../index.js"),
    { billingInvariants } = await import("../invariants.js"),
    { subscriptionInvariants } = await import("../subscription/invariants.js"),
    { adjustmentInvariants } = await import("./invariants.js");
  const who = await h.subscribed(),
    author = await h.actor(),
    reviewer = await h.actor();
  const r = await h.svc.extensions.create(author, h.extensionInput(who.term, 7));
  h.clock.set(new Date(who.term.endsAt.getTime() + 1000));
  expect(await h.svc.extensionQuote(author, who.term.id, 7)).toMatchObject({
    mode: "not_applicable",
  });
  expect(await h.svc.extensions.get(reviewer.staff, r.termExtensionRequestId)).toMatchObject({
    preview: { mode: "revive", restorePoints: 6600 },
  });
  await h.svc.extensions.approve(reviewer, r.termExtensionRequestId, extensionConfirm(r));
  const values = await computeEntityValuation(h.prisma, who.entityId, h.clock.now());
  expect(values.map((v) => [v.effect, v.valueFen, v.remainingValueFen])).toEqual([
    ["inflow", 600000, 600000],
    ["recognize_breakage", 600000, 0],
    ["reverse_breakage", 600000, 600000],
  ]);
  const revivedOn = calendarDate(h.clock.now());
  h.clock.advance(86400000);
  await h.tx.run((tx) =>
    createBillingDailyProjection({ ledger: h.ledger }).snapshot(tx, who.entityId, revivedOn),
  );
  expect(
    await h.prisma.billingEntityDaily.findUniqueOrThrow({
      where: {
        bizDate_entityId: {
          bizDate: new Date(`${revivedOn}T00:00:00.000Z`),
          entityId: who.entityId,
        },
      },
    }),
  ).toMatchObject({
    subStatus: "active",
    subscriptionTermId: who.term.id,
    planAvailablePoints: 6600,
    liabilityValueFen: 600000,
    deferredPlanFeeFen: 0,
  });
  for (const rule of [...billingInvariants, ...subscriptionInvariants, ...adjustmentInvariants])
    expect(
      await h.tx.run((tx) => rule.run!(tx, { entityIds: [who.entityId] }, { now: h.clock.now() })),
      rule.code,
    ).toEqual([]);
  expect(adjustmentInvariants.map((r) => [r.code, r.severity, r.modes, r.heal])).toEqual([
    ["billing.I18", "P1", ["full"], "none"],
  ]);
  const { assembleForTest } = await import("../../testing/index.js");
  expect(
    assembleForTest({ entry: "api" })
      .invariants.filter((r) => r.module === "billing")
      .map((r) => r.code)
      .sort(),
  ).toEqual([
    "billing.I1",
    "billing.I10",
    "billing.I11",
    "billing.I12",
    "billing.I13",
    "billing.I15",
    "billing.I16",
    "billing.I18",
    "billing.I2",
    "billing.I3",
    "billing.I4",
    "billing.I5",
    "billing.I6",
    "billing.I7",
    "billing.I8",
    "billing.I9",
  ]);
}, 60000);

it("客服工单引用只收同主体真实票据，提交预锁与追加引用不碰账，详情来自support窄公口", async () => {
  const who = await h.subscribed(),
    other = await h.subscribed(),
    author = await h.actor(),
    now = h.clock.now();
  const ticket = await h.prisma.serviceTicket.create({
    data: {
      id: uuidv7(),
      ticketNo: "KF20260105001",
      entityId: who.entityId,
      storeId: who.storeId,
      source: "weapp",
      submitterUserId: who.user.id,
      typeCode: "K01",
      priority: "mid",
      description: "制作延迟需要补偿",
      status: "pending",
      solutionDueAt: new Date(now.getTime() + 86400000),
      slaSnapshot: {},
      createdAt: now,
      updatedAt: now,
    },
  });
  const bad = await h.adjustmentInput(other.entityId, { serviceTicketId: ticket.id }),
    before = await snapshotTables(h.prisma, tables);
  await expect(h.svc.points.create(author, bad)).rejects.toMatchObject({
    error: "VALIDATION_FAILED",
    details: { fieldErrors: [{ path: "serviceTicketId" }] },
  });
  expect(await snapshotTables(h.prisma, tables)).toEqual(before);
  const ledger = await snapshotTables(h.prisma, ledgerTables),
    r = await h.svc.points.create(
      author,
      await h.adjustmentInput(who.entityId, { serviceTicketId: ticket.id }),
    );
  expect(r).toMatchObject({
    relatedServiceTickets: [{ serviceTicketId: ticket.id, ticketNo: ticket.ticketNo }],
  });
  expect(await snapshotTables(h.prisma, ledgerTables)).toEqual(ledger);
  expect(await h.svc.points.get(author.staff, r.pointAdjustmentRequestId)).toMatchObject({
    relatedServiceTickets: [{ serviceTicketId: ticket.id }],
  });
}, 60000);
