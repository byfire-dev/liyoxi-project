import { PlanContentSchema } from "@liyoxi/contract";
import type {
  PlanContent,
  PlanContentInput,
  PlanDraftReplaceBody,
  PlanPushBody,
  PlanChangeRequestBody,
} from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { record } from "../audit/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { workHoursAt } from "../sla/index.js";
import type { DeliveryDeps, DeliveryViewer } from "./context.js";
import { checked } from "./machines.js";
import { orderSidePort } from "./ports.js";
import { assertOwner, dateOf, lockTickets, planOf } from "./repo.js";
import type { PlanRow } from "./repo.js";
import { assertPlanApplied, reevaluate } from "./reevaluate.js";
const invalid = (path: string, message: string) =>
  new AppError("VALIDATION_FAILED", { details: { fieldErrors: [{ path, message }] } });
function afterSale(p: PlanRow) {
  if (p.dramaOrder.openCancelRequestId)
    throw new AppError("ORDER_IN_AFTER_SALE", {
      details: { cancelRequestId: p.dramaOrder.openCancelRequestId },
    });
}
function version(p: PlanRow, v: number) {
  if (p.draftLockVersion !== v)
    throw new AppError("VERSION_CONFLICT", { details: { draftLockVersion: p.draftLockVersion } });
}
/** 所有父行与工单先锁，选定账号 190 在方案 200 前；新方案内容与旧账号的并集覆盖 order 写侧的增删。 */
async function lockPlan(
  tx: Tx,
  id: string,
  subject: StaffContext | DeliveryViewer,
  extraAccounts: readonly string[] = [],
) {
  const first = await planOf(tx, id, subject);
  await lockRows(tx, "drama_order", [first.dramaOrderId]);
  await lockRows(
    tx,
    "order_item",
    first.dramaOrder.orderItems.map((r) => r.id),
  );
  await lockTickets(
    tx,
    first.dramaOrder.deliveryTickets.map((r) => r.id),
  );
  // 等父锁时别的写入可能已提交；在父锁保护下刷新草稿与版本，再取得全部选定账号锁。
  const current = await planOf(tx, id, subject),
    content = PlanContentSchema.parse(current.draft);
  const snapshots = current.deliveryPlanVersions
    .filter(
      (v) => v.versionNo === current.currentVersionNo || v.versionNo === current.confirmedVersionNo,
    )
    .map((v) => PlanContentSchema.parse(v.contentSnapshot));
  const ids = [
    ...extraAccounts,
    ...[content, ...snapshots].flatMap((c) =>
      c.items.flatMap((r) => r.accounts.map((a) => a.channelAccountId)),
    ),
    ...current.dramaOrder.orderItems.flatMap((r) =>
      r.orderItemAccounts.map((a) => a.channelAccountId),
    ),
  ];
  await lockRows(tx, "channel_account", ids);
  await lockRows(tx, "delivery_plan", [id]);
  return planOf(tx, id, subject);
}
async function normalizeDraft(tx: Tx, p: PlanRow, input: PlanContentInput): Promise<PlanContent> {
  const items = p.dramaOrder.orderItems.filter(
    (r) => !["cancelled", "refunded", "terminated"].includes(r.phase),
  );
  if (
    input.items.length !== items.length ||
    input.items.some((r) => !items.some((i) => i.id === r.orderItemId))
  )
    throw invalid("content.items", "必须包含本订购单每个未取消的订单项");
  const focus = await tx.dictItem.findMany({
    where: { dictTypeKey: "custom_focus", code: { in: input.focusCodes }, isEnabled: true },
  });
  if (focus.length !== input.focusCodes.length)
    throw invalid("content.focusCodes", "定制重点编码不存在或未启用");
  // 归属是读取边界；账号状态、素材可用性等业务条件仍由推送校验。
  const references = await tx.storeAsset.findMany({
    where: { id: { in: input.referenceAssetIds }, entityId: p.entityId, storeId: p.storeId },
    select: { id: true },
  });
  if (references.length !== new Set(input.referenceAssetIds).size) throw new AppError("NOT_FOUND");
  const result: PlanContent = {
    focusTags: input.focusCodes,
    referenceAssetIds: input.referenceAssetIds,
    note: input.note ?? null,
    launchMode: input.launchMode,
    items: [],
  };
  for (const row of input.items) {
    const accounts = await tx.channelAccount.findMany({
      where: { id: { in: row.channelAccountIds }, entityId: p.entityId, storeId: p.storeId },
    });
    if (accounts.length !== row.channelAccountIds.length) throw new AppError("NOT_FOUND");
    if (new Set(accounts.map((a) => a.platform)).size !== accounts.length)
      throw invalid("content.items.channelAccountIds", "同平台至多一个账号");
    const ads = await tx.ad.findMany({
      where: {
        id: { in: row.placements.map((a) => a.adId) },
        entityId: p.entityId,
        storeId: p.storeId,
      },
    });
    if (ads.length !== new Set(row.placements.map((a) => a.adId)).size)
      throw new AppError("NOT_FOUND");
    result.items.push({
      orderItemId: row.orderItemId,
      accounts: row.channelAccountIds.map((id) => ({
        channelAccountId: id,
        platform: accounts.find((a) => a.id === id)!.platform as "douyin" | "wechat_channels",
      })),
      placements: row.placements.map((r) => ({
        ...r,
        durationSec: ads.find((a) => a.id === r.adId)!.durationSec,
      })),
      agreedLaunchDate: row.agreedLaunchDate ?? null,
      expectedDeliveryDate: row.expectedDeliveryDate ?? null,
    });
  }
  return PlanContentSchema.parse(result);
}
export async function replaceDraft(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  body: PlanDraftReplaceBody,
) {
  const p = await lockPlan(
    tx,
    id,
    staff,
    body.content.items.flatMap((r) => r.channelAccountIds),
  );
  version(p, body.draftLockVersion);
  if (p.status === "confirmed") throw new AppError("STATE_NOT_ALLOWED");
  const content = await normalizeDraft(tx, p, body.content),
    now = deps.clock.now();
  const changed = await tx.deliveryPlan.updateMany({
    where: { id, draftLockVersion: body.draftLockVersion },
    data: { draft: content, draftLockVersion: { increment: 1 }, updatedAt: now },
  });
  if (changed.count !== 1) throw new AppError("VERSION_CONFLICT");
  await record(
    tx,
    ctx.actor,
    {
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      authMethod: null,
      sessionId: null,
    },
    {
      stream: "activity",
      category: "delivery",
      action: "delivery.plan.draft_replace",
      summary: "保存交付方案草稿：定制重点、参考素材、说明、上线方式、订单项配置",
      target: { type: "delivery_plan", id },
      entityId: p.entityId,
      storeId: p.storeId,
    },
  );
}
export async function pushPlan(
  tx: Tx,
  deps: DeliveryDeps,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  body: PlanPushBody,
) {
  const p = await lockPlan(tx, id, staff);
  afterSale(p);
  version(p, body.draftLockVersion);
  if (p.status === "confirmed") throw new AppError("STATE_NOT_ALLOWED");
  const content = PlanContentSchema.parse(p.draft),
    issues: Array<{ orderItemId: string | null; field: string; reason: string }> = [];
  const items = p.dramaOrder.orderItems.filter(
    (r) => !["cancelled", "refunded", "terminated"].includes(r.phase),
  );
  if (
    content.items.length !== items.length ||
    content.items.some((r) => !items.some((i) => i.id === r.orderItemId))
  )
    issues.push({ orderItemId: null, field: "items", reason: "item_missing" });
  if (p.dramaOrder.deliveryTickets.some((t) => t.step === "assigning"))
    issues.push({ orderItemId: null, field: "tickets", reason: "ticket_unassigned" });
  const min = calendarDate(
    (
      await deps.sla.dueAt(tx, {
        policy: "plan.launch_min",
        amount: 7,
        unit: "work_days",
        from: p.dramaOrder.submittedAt,
        workHours: await workHoursAt(tx, deps.clock.now()),
      })
    ).dueAt,
  );
  for (const row of content.items) {
    const item = items.find((r) => r.id === row.orderItemId);
    if (!item) continue;
    const accounts = await tx.channelAccount.findMany({
      where: { id: { in: row.accounts.map((a) => a.channelAccountId) } },
    });
    if (!row.accounts.length)
      issues.push({ orderItemId: item.id, field: "accounts", reason: "account_missing" });
    if (
      accounts.length !== row.accounts.length ||
      accounts.some(
        (a) =>
          a.storeId !== p.storeId ||
          a.entityId !== p.entityId ||
          a.status !== "available" ||
          row.accounts.find((r) => r.channelAccountId === a.id)?.platform !== a.platform,
      )
    )
      issues.push({ orderItemId: item.id, field: "accounts", reason: "account_invalid" });
    if (new Set(row.accounts.map((a) => a.platform)).size !== row.accounts.length)
      issues.push({ orderItemId: item.id, field: "accounts", reason: "account_invalid" });
    if (!row.agreedLaunchDate)
      issues.push({
        orderItemId: item.id,
        field: "agreedLaunchDate",
        reason: "launch_date_missing",
      });
    else if (row.agreedLaunchDate < min || row.agreedLaunchDate > dateOf(item.usageEndDate)!)
      throw new AppError("LAUNCH_DATE_OUT_OF_RANGE", {
        details: { orderItemId: item.id, minDate: min, maxDate: dateOf(item.usageEndDate) },
      });
  }
  const refs = await tx.storeAsset.findMany({ where: { id: { in: content.referenceAssetIds } } });
  if (
    refs.length !== content.referenceAssetIds.length ||
    refs.some(
      (r) =>
        r.storeId !== p.storeId ||
        r.entityId !== p.entityId ||
        r.deletedAt ||
        r.moderationState === "block" ||
        r.usability === "need_reshoot",
    )
  )
    issues.push({ orderItemId: null, field: "referenceAssets", reason: "reference_unusable" });
  if (issues.length) throw new AppError("PLAN_CONTENT_INVALID", { details: { issues } });
  const no = p.currentVersionNo + 1,
    now = deps.clock.now();
  await tx.deliveryPlanVersion.updateMany({
    where: { deliveryPlanId: id, decision: null },
    data: {
      decision: "superseded",
      decidedAt: now,
      decideActorType: "system",
      decideActorId: null,
      decideClient: null,
    },
  });
  await tx.deliveryPlanVersion.create({
    data: {
      id: uuidv7(),
      entityId: p.entityId,
      storeId: p.storeId,
      deliveryPlanId: id,
      versionNo: no,
      contentSnapshot: content,
      changeSummary: body.changeSummary ?? null,
      pushedByStaffId: staff.staff.id,
      pushedAt: now,
      createdAt: now,
    },
  });
  await tx.deliveryPlanChangeRequest.updateMany({
    where: { deliveryPlanId: id, resolvedByVersionNo: null },
    data: { resolvedByVersionNo: no, updatedAt: now },
  });
  await deps.flow.transition(tx, ctx, {
    machine: "delivery_plan",
    stateField: "status",
    id,
    event: "plan.push",
    entityId: p.entityId,
    storeId: p.storeId,
    args: checked(),
    set: { current_version_no: no, pushed_at: now, staff_due_at: null },
    payload: { versionNo: no },
    emit: {
      type: "plan.pushed",
      payload: { v: 1, deliveryPlanId: id, dramaOrderId: p.dramaOrderId, versionNo: no },
    },
  });
  await tx.deliveryTicket.updateMany({
    where: { dramaOrderId: p.dramaOrderId, step: "plan_confirm", pauseCount: 0 },
    data: { waitingOn: "merchant", updatedAt: now },
  });
}
export async function confirmPlan(
  tx: Tx,
  deps: DeliveryDeps,
  viewer: DeliveryViewer,
  id: string,
  versionNo: number,
) {
  assertOwner(viewer);
  const p = await lockPlan(tx, id, viewer);
  afterSale(p);
  if (versionNo !== p.currentVersionNo)
    throw new AppError("PLAN_VERSION_STALE", { details: { currentVersionNo: p.currentVersionNo } });
  if (p.status !== "pending_confirm") throw new AppError("STATE_NOT_ALLOWED");
  const v = p.deliveryPlanVersions.find((r) => r.versionNo === versionNo);
  if (!v || v.decision !== null) throw new AppError("STATE_NOT_ALLOWED");
  const content = PlanContentSchema.parse(v.contentSnapshot),
    now = deps.clock.now();
  await deps.assembly.port(orderSidePort).applyConfirmedPlan(tx, {
    ctx: viewer.ctx,
    dramaOrderId: p.dramaOrderId,
    deliveryPlanId: id,
    versionNo,
    content,
  });
  await assertPlanApplied(tx, p.dramaOrderId, content);
  await deps.flow.transition(tx, viewer.ctx, {
    machine: "delivery_plan",
    stateField: "status",
    id,
    event: "plan.confirm",
    entityId: p.entityId,
    storeId: p.storeId,
    args: checked(),
    set: { confirmed_version_no: versionNo, confirmed_at: now, staff_due_at: null },
    payload: { versionNo },
    emit: {
      type: "plan.confirmed",
      payload: { v: 1, deliveryPlanId: id, dramaOrderId: p.dramaOrderId, versionNo },
    },
  });
  await tx.deliveryPlanVersion.update({
    where: { id: v.id },
    data: {
      decision: "confirmed",
      decidedAt: now,
      decideActorType: "merchant",
      decideActorId: viewer.ctx.actor.id,
      decideClient: viewer.ctx.actor.client,
    },
  });
  const unchanged: string[] = [];
  for (const t of [...p.dramaOrder.deliveryTickets].sort((a, b) => a.id.localeCompare(b.id))) {
    const result = await reevaluate(tx, deps, viewer.ctx, t.id);
    if (!result.moved) unchanged.push(t.orderItemId);
  }
  if (unchanged.length)
    await deps.assembly.port(orderSidePort).rederive(tx, { orderItemIds: unchanged });
}
export async function requestPlanChange(
  tx: Tx,
  deps: DeliveryDeps,
  viewer: DeliveryViewer,
  id: string,
  body: PlanChangeRequestBody,
) {
  assertOwner(viewer);
  const p = await lockPlan(tx, id, viewer);
  afterSale(p);
  if (!["pending_confirm", "revising"].includes(p.status)) throw new AppError("STATE_NOT_ALLOWED");
  const now = deps.clock.now();
  await tx.deliveryPlanChangeRequest.create({
    data: {
      id: uuidv7(),
      entityId: p.entityId,
      storeId: p.storeId,
      deliveryPlanId: id,
      onVersionNo: p.currentVersionNo,
      kinds: body.kinds,
      note: body.note.trim(),
      createdByUserId: viewer.ctx.actor.id!,
      createdAt: now,
      updatedAt: now,
    },
  });
  if (p.status === "pending_confirm") {
    const v = p.deliveryPlanVersions.find((r) => r.versionNo === p.currentVersionNo);
    if (!v || v.decision !== null) throw new AppError("STATE_NOT_ALLOWED");
    await tx.deliveryPlanVersion.update({
      where: { id: v.id },
      data: {
        decision: "change_requested",
        decidedAt: now,
        decideActorType: "merchant",
        decideActorId: viewer.ctx.actor.id,
        decideClient: viewer.ctx.actor.client,
      },
    });
  }
  await deps.flow.transition(tx, viewer.ctx, {
    machine: "delivery_plan",
    stateField: "status",
    id,
    event: "plan.request_change",
    entityId: p.entityId,
    storeId: p.storeId,
    args: checked(),
    set: { staff_due_at: null },
    payload: { versionNo: p.currentVersionNo },
    emit: {
      type: "plan.change_requested",
      payload: {
        v: 1,
        deliveryPlanId: id,
        dramaOrderId: p.dramaOrderId,
        versionNo: p.currentVersionNo,
      },
    },
  });
  await tx.deliveryTicket.updateMany({
    where: { dramaOrderId: p.dramaOrderId, step: "plan_confirm", pauseCount: 0 },
    data: { waitingOn: "staff", updatedAt: now },
  });
}
