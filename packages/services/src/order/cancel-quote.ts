import {
  AdCancelQuoteBodySchema,
  AdPricingSnapshotSchema,
  CancelQuoteLineSchema,
  CancelQuoteSchema,
  DramaPricingSnapshotSchema,
  FinalRejectImpactSchema,
  OrderCancelQuoteBodySchema,
  PricingSnapshotSchema,
} from "@liyoxi/contract";
import type {
  CancelQuote,
  CancelQuoteLine,
  CancelReason,
  OrderCancelQuoteBody,
} from "@liyoxi/contract";
import type { OrderItem } from "@liyoxi/db";
import { readAdCancelFacts, readQualificationCancelAds } from "../ad/index.js";
import type { AdCancelFacts } from "../ad/index.js";
import { managedStore } from "../authz/index.js";
import type { DataScope } from "../authz/index.js";
import { previewReturn, readCancelHoldFacts } from "../billing/index.js";
import { getTicketBriefByOrderItem } from "../delivery/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { calculateCancelLine } from "./cancel-calculation.js";

const date = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
export const CLOSED_CANCEL_ITEMS = ["cancelled", "refunded", "terminated", "ended"];
export async function boundCancelAdItems(tx: Tx, adId: string) {
  const rows = await tx.orderItemPlacement.findMany({
    where: { adId, orderItem: { phase: { notIn: CLOSED_CANCEL_ITEMS } } },
    select: { orderItemId: true },
    orderBy: { orderItemId: "asc" },
  });
  return [...new Set(rows.map((r) => r.orderItemId))];
}
export async function orderCancelFacts(tx: Tx, item: OrderItem) {
  const ticket = await getTicketBriefByOrderItem(tx, item.id);
  const accounts = await tx.orderItemAccount.findMany({
    where: { orderItemId: item.id },
    orderBy: { platform: "asc" },
    select: { platform: true },
  });
  return {
    targetType: "order_item" as const,
    row: item,
    ticket,
    platforms: accounts.map((a) => a.platform),
  };
}
export function adCancelFacts(row: AdCancelFacts) {
  return { targetType: "ad" as const, row, ticket: null, platforms: [] as string[] };
}
type Facts = Awaited<ReturnType<typeof orderCancelFacts>> | ReturnType<typeof adCancelFacts>;
/** Shared by quote and revalidation; caller passes the fixed submit date when validating a saved line. */
export async function calculateCancelFacts(
  tx: Tx,
  facts: Facts,
  reasonCode: CancelReason,
  at: Date,
  options: {
    terminationDate?: string;
    manualDeduct?: { deductPoints: number; deductNote: string };
    submittedAt?: Date;
  } = {},
) {
  const r = facts.row;
  const item = facts.targetType === "order_item" ? facts.row : null;
  const ad = facts.targetType === "ad" ? facts.row : null;
  const pricing = item
    ? DramaPricingSnapshotSchema.parse(item.pricingSnapshot)
    : AdPricingSnapshotSchema.parse(ad!.pricingSnapshot);
  const calculation = calculateCancelLine({
    targetType: facts.targetType,
    state: item?.phase ?? ad!.status,
    step: facts.ticket?.step ?? null,
    returnedFrom: ad?.returnedFrom,
    chargePoints: r.chargePoints,
    priorRequestedPoints: r.refundRequestedPoints,
    reasonCode,
    ratios: pricing.cancelDeductionBp,
    usageStartDate: item ? date(item.usageStartDate) : null,
    usageEndDate: item ? date(item.usageEndDate)! : undefined,
    usageEndSource: item?.usageEndSource,
    ...options,
    at: options.submittedAt ?? at,
  });
  if ("blocker" in calculation) return calculation;
  const hold = await readCancelHoldFacts(tx, r.pointHoldId);
  if (
    !hold ||
    hold.entityId !== r.entityId ||
    hold.storeId !== r.storeId ||
    hold.refType !== facts.targetType ||
    hold.purpose !== facts.targetType ||
    hold.refId !== r.id ||
    hold.qty !== r.chargePoints ||
    hold.returnedQty + hold.forfeitedQty !== r.refundRequestedPoints ||
    JSON.stringify(PricingSnapshotSchema.parse(hold.pricingSnapshot)) !== JSON.stringify(pricing) ||
    (calculation.mode === "release"
      ? hold.status !== "held" || r.capturedAt !== null
      : !["captured", "refunded_partial", "refunded_full"].includes(hold.status) ||
        r.capturedAt === null ||
        hold.capturedAt?.getTime() !== r.capturedAt.getTime())
  ) {
    throw new AppError("PRECONDITION_CHANGED", { message: "对象与冻结单事实不一致" });
  }
  const { arbitrageHint: _hint, ...preview } = await previewReturn(
    tx,
    { holdId: r.pointHoldId, qty: calculation.refundPoints, reasonClass: calculation.reasonClass },
    at,
  );
  const title = item
    ? (item.dramaSnapshot as { title?: string }).title
    : `${ad!.type} ${ad!.durationSec} 秒 · ${ad!.adNo}`;
  if (typeof title !== "string") throw new AppError("PRECONDITION_CHANGED");
  return CancelQuoteLineSchema.parse({
    targetType: facts.targetType,
    targetId: r.id,
    label: title,
    episodeCount: item?.episodeCount ?? null,
    productionModel: item?.productionModel ?? null,
    platforms: facts.platforms,
    ...calculation,
    stepAtSubmit: item ? (facts.ticket?.step ?? null) : ad!.status,
    chargePoints: r.chargePoints,
    priorRequestedPoints: r.refundRequestedPoints,
    capturedAt: r.capturedAt?.toISOString() ?? null,
    preview,
  });
}
function summarize(
  reasonCode: CancelReason,
  at: Date,
  lines: CancelQuoteLine[],
  blockers: CancelQuote["blockers"],
): CancelQuote {
  const sum = (key: "deductPoints" | "refundPoints") => lines.reduce((n, l) => n + l[key], 0);
  const totalRefundPoints = sum("refundPoints");
  return CancelQuoteSchema.parse({
    quotedAt: at.toISOString(),
    reasonCode,
    lines,
    totalBasePoints: lines.reduce((n, l) => n + l.chargePoints - l.priorRequestedPoints, 0),
    totalDeductPoints: sum("deductPoints"),
    totalRefundPoints,
    destination: {
      qty: totalRefundPoints,
      backToOriginal: lines.reduce((n, l) => n + l.preview.backToOriginal, 0),
      convertedToAddon: lines.reduce((n, l) => n + l.preview.convertedToAddon, 0),
      forfeited: lines.reduce((n, l) => n + l.preview.forfeited, 0),
      lots: lines.flatMap((l) => l.preview.lots),
    },
    needsManualDeduct: lines.some((l) => l.isManualDeduct),
    blockers,
    expect: { totalRefundPoints },
  });
}
/** Pure read: no row/account locks, advance, timer, audit or cache writes. */
export async function quoteOrderCancel(
  tx: Tx,
  input: { scope: DataScope; orderId: string; body: OrderCancelQuoteBody },
  at: Date,
) {
  const body = OrderCancelQuoteBodySchema.parse(input.body);
  const order = await tx.dramaOrder.findFirst({
    where: { id: input.orderId, store: managedStore(input.scope) },
    include: { orderItems: { orderBy: { itemNo: "asc" } } },
  });
  if (!order) throw new AppError("NOT_FOUND");
  if (order.openCancelRequestId)
    throw new AppError("ORDER_IN_AFTER_SALE", { details: { orderId: order.id } });
  const selected = body.orderItemIds
    ? order.orderItems.filter((i) => body.orderItemIds!.includes(i.id))
    : order.orderItems.filter((i) => !CLOSED_CANCEL_ITEMS.includes(i.phase));
  if (body.orderItemIds && selected.length !== body.orderItemIds.length)
    throw new AppError("VALIDATION_FAILED");
  if (
    body.manualDeducts?.some(
      (d) =>
        !selected.some(
          (i) =>
            i.id === d.orderItemId && d.deductPoints <= i.chargePoints - i.refundRequestedPoints,
        ),
    )
  )
    throw new AppError("VALIDATION_FAILED");
  const lines: CancelQuoteLine[] = [],
    blockers: CancelQuote["blockers"] = [];
  for (const item of selected) {
    if (item.entityId !== order.entityId || item.storeId !== order.storeId)
      throw new AppError("PRECONDITION_CHANGED");
    const result = await calculateCancelFacts(
      tx,
      await orderCancelFacts(tx, item),
      body.reasonCode,
      at,
      {
        terminationDate: body.terminationDate,
        manualDeduct: body.manualDeducts?.find((d) => d.orderItemId === item.id),
      },
    );
    if ("blocker" in result) blockers.push({ orderItemId: item.id, reason: result.blocker });
    else lines.push(result);
  }
  return summarize(body.reasonCode, at, lines, blockers);
}
export async function quoteAdCancel(
  tx: Tx,
  input: {
    scope: DataScope;
    adId: string;
    body: { reasonCode: "merchant_request" | "store_closed" | "platform_fault" };
  },
  at: Date,
) {
  const body = AdCancelQuoteBodySchema.parse(input.body),
    ad = await readAdCancelFacts(tx, input.adId, input.scope);
  if (!ad) throw new AppError("NOT_FOUND");
  if (ad.openCancelRequestId) throw new AppError("AD_CANCEL_IN_PROGRESS");
  const result = await calculateCancelFacts(tx, adCancelFacts(ad), body.reasonCode, at);
  const reason =
    "blocker" in result
      ? result.blocker
      : (await boundCancelAdItems(tx, ad.id)).length
        ? ("ad_in_use" as const)
        : null;
  return summarize(
    body.reasonCode,
    at,
    "blocker" in result || reason ? [] : [result],
    reason ? [{ orderItemId: null, reason }] : [],
  );
}
/** Same candidate algorithm as the future qualification_cancel producer; empty impact is valid. */
export async function previewFinalReject(
  tx: Tx,
  input: { entityId: string; storeId: string },
  at: Date,
) {
  if (
    !(await tx.store.findFirst({
      where: { id: input.storeId, entityId: input.entityId },
      select: { id: true },
    }))
  )
    throw new AppError("NOT_FOUND");
  const candidates = await tx.dramaOrder.findMany({
    where: { ...input, status: "pending_start", openCancelRequestId: null },
    include: { orderItems: { orderBy: { id: "asc" } } },
    orderBy: { id: "asc" },
  });
  const orders = [],
    ads = [];
  for (const order of candidates) {
    if (
      !order.orderItems.length ||
      order.orderItems.length !== order.itemCount ||
      order.orderItems.some(
        (i) =>
          i.phase !== "pending_start" ||
          i.entityId !== input.entityId ||
          i.storeId !== input.storeId,
      )
    )
      throw new AppError("PRECONDITION_CHANGED");
    let heldPoints = 0;
    for (const item of order.orderItems) {
      const line = await calculateCancelFacts(
        tx,
        await orderCancelFacts(tx, item),
        "qualification_final",
        at,
      );
      if ("blocker" in line) throw new AppError("PRECONDITION_CHANGED");
      heldPoints += line.refundPoints;
    }
    orders.push({ orderId: order.id, orderNo: order.orderNo, heldPoints });
  }
  for (const ad of await readQualificationCancelAds(tx, input)) {
    const line = await calculateCancelFacts(tx, adCancelFacts(ad), "qualification_final", at);
    if ("blocker" in line) throw new AppError("PRECONDITION_CHANGED");
    ads.push({ adId: ad.id, adNo: ad.adNo, heldPoints: line.refundPoints });
  }
  return FinalRejectImpactSchema.parse({
    pendingStartOrderCount: orders.length,
    pendingAssignAdCount: ads.length,
    heldPoints: [...orders, ...ads].reduce((n, r) => n + r.heldPoints, 0),
    orders,
    ads,
    computedAt: at.toISOString(),
  });
}
