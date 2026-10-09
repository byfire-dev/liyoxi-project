import { beforeAll, expect, it } from "vitest";
import type { CancelQuote } from "@liyoxi/contract";
import { AdPricingSnapshotSchema } from "@liyoxi/contract";
import {
  assertSnapshotsEqual,
  assembleForTest,
  captureHold,
  joinLedger,
  refundHold,
  releaseHold,
  snapshotTables,
  useSeededDatabase,
} from "../testing/index.js";
import { createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import { SYSTEM_SCOPE, scopeOf } from "../authz/index.js";
import { readCancelHoldFacts } from "../billing/index.js";
import { paramsAt } from "../billing/index.js";
import { readAdCancelFacts } from "../ad/index.js";
import { QualificationImpactPort } from "../profile/index.js";
import { harness, buyer, drama, body, version } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { previewFinalReject, quoteAdCancel, quoteOrderCancel, revalidateCancel } from "./index.js";
const db = useSeededDatabase("services", { max: 1 });
let h: Harness;
let seq = 88000;
const tables = [
  "billing_account",
  "subscription_term",
  "point_lot",
  "point_hold",
  "point_hold_alloc",
  "ledger_operation",
  "point_ledger_entry",
  "outbox_event",
  "timer",
  "status_transition",
  "audit_log",
  "cancel_request",
  "cancel_request_line",
  "drama_order",
  "order_item",
  "ad",
  "delivery_ticket",
  "delivery_ticket_pause",
];
beforeAll(async () => {
  h = harness(await db.prisma());
  await version(h);
}, 120000);
async function order(count = 1, at = new Date("2026-01-05T04:00:00Z")) {
  h.clock.set(at);
  const b = await buyer(h),
    ds = [];
  for (let i = 0; i < count; i++) ds.push(await drama(h, 105 + i));
  const out = await h.order.create(
    b.actor,
    await body(
      h,
      b,
      ds.map((d) => d.id),
    ),
  );
  const items = await h.prisma.orderItem.findMany({
    where: { dramaOrderId: out.orderId },
    orderBy: { itemNo: "asc" },
  });
  return { b, out, items };
}
type Order = Awaited<ReturnType<typeof order>>;
const quote = (o: Order, reasonCode: "merchant_request" | "platform_fault" = "merchant_request") =>
  h.tx.run((tx) =>
    quoteOrderCancel(
      tx,
      { scope: SYSTEM_SCOPE, orderId: o.out.orderId, body: { reasonCode } },
      h.clock.now(),
    ),
  );
async function produce(o: Order, step = "sample_making", live = false) {
  const item = o.items[0]!;
  await captureHold(h, item.pointHoldId);
  const captured = await h.prisma.pointHold.findUniqueOrThrow({ where: { id: item.pointHoldId } });
  await h.prisma.orderItem.update({
    where: { id: item.id },
    data: {
      phase: live ? "live" : "producing",
      capturedAt: captured.capturedAt,
      ...(live
        ? {
            usageStartDate: new Date("2026-01-01T00:00:00Z"),
            usageEndDate: new Date("2026-01-10T00:00:00Z"),
          }
        : {}),
    },
  });
  return h.make.deliveryTicket({ orderItemId: item.id, step });
}
async function ad(o: Order, status = "pending_assign", returnedFrom?: string) {
  const id = uuidv7(),
    now = h.clock.now(),
    ctx = createIdentityContext({
      actor: { type: "system", job: "lyxtest.cancel_quote" },
      entityId: o.b.entity.id,
    });
  const held = await h.tx.run((tx) =>
    h.ledger.hold(tx, {
      entityId: o.b.entity.id,
      storeId: o.b.store.id,
      refType: "ad",
      refId: id,
      pricing: { kind: "ad" },
      title: {
        code: "ad_hold",
        args: { adNo: `GG${seq}`, unitPoints: 50, discountBp: o.b.term!.discountBp },
      },
      ctx,
    }),
  );
  const pricing = AdPricingSnapshotSchema.parse(held.snapshot);
  const consent = await h.make.agreementConsent({
    scene: "ad_request",
    merchantUserId: o.b.user.id,
    entityId: o.b.entity.id,
    storeId: o.b.store.id,
    bizId: id,
  });
  if (status !== "pending_assign" && !(status === "returned" && returnedFrom === "pending_assign"))
    await h.tx.run((tx) =>
      h.ledger.capture(tx, {
        pointHoldId: held.pointHoldId,
        title: { refType: "ad", refNo: `GG${seq}`, count: 1 },
        ctx,
      }),
    );
  const facts = await h.prisma.pointHold.findUniqueOrThrow({ where: { id: held.pointHoldId } }),
    editor = facts.capturedAt ? await h.make.staff({ staffRoleKey: "editor" }) : null;
  return h.prisma.ad.create({
    data: {
      id,
      adNo: `GG20260105${seq++}`,
      entityId: o.b.entity.id,
      storeId: o.b.store.id,
      requestedByUserId: o.b.user.id,
      type: "opening",
      durationSec: 3,
      promoPointCodes: ["TEST"],
      status,
      returnedFrom: returnedFrom ?? null,
      ...(status === "returned" ? { returnedAt: now, returnReason: "补充文案" } : {}),
      ...(status === "confirmed"
        ? { confirmedAt: now, confirmedVersionNo: 1, latestVersionNo: 1 }
        : {}),
      unitPricePoints: pricing.unitPoints,
      discountBp: pricing.discountBp,
      chargePoints: held.points,
      pricingSnapshot: held.snapshot,
      pointHoldId: held.pointHoldId,
      capturedAt: facts.capturedAt,
      editorId: editor?.id ?? null,
      ...(status === "pending_confirm" ? { latestVersionNo: 1 } : {}),
      freeRevisionQuota: pricing.freeRevisions,
      agreementConsentId: consent.id,
      submittedAt: now,
      firstDueAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
}
async function save(
  o: Order,
  q: CancelQuote,
  kind: "order_cancel" | "ad_cancel" | "qualification_cancel" = "order_cancel",
) {
  const id = uuidv7(),
    approvalId = uuidv7(),
    now = h.clock.now(),
    staff = await h.make.staff({ staffRoleKey: "cs" });
  await h.prisma.approvalRequest.create({
    data: {
      id: approvalId,
      requestNo: `TK20260105${seq++}`,
      kind,
      category: "approval",
      subjectType: kind === "order_cancel" ? "drama_order" : kind === "ad_cancel" ? "ad" : "store",
      subjectId:
        kind === "order_cancel"
          ? o.out.orderId
          : kind === "ad_cancel"
            ? q.lines[0]!.targetId
            : o.b.store.id,
      entityId: o.b.entity.id,
      storeId: o.b.store.id,
      status: "pending",
      summarySnapshot: {
        title: "只读取消事实",
        points: q.totalRefundPoints,
        domain: { type: "cancel_request", id },
      },
      requesterStaffId: staff.id,
      submitActorType: kind === "qualification_cancel" ? "system" : "staff",
      submitActorId: kind === "qualification_cancel" ? null : staff.id,
      submitClient: kind === "qualification_cancel" ? null : "admin",
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  const r = await h.prisma.cancelRequest.create({
    data: {
      id,
      approvalRequestId: approvalId,
      kind,
      entityId: o.b.entity.id,
      storeId: o.b.store.id,
      dramaOrderId: kind === "order_cancel" ? o.out.orderId : null,
      adId: kind === "ad_cancel" ? q.lines[0]!.targetId : null,
      reasonCode: q.reasonCode,
      note: "真实账本只读复核事实",
      lineCount: q.lines.length,
      totalBasePoints: q.totalBasePoints,
      totalDeductPoints: q.totalDeductPoints,
      totalRefundPoints: q.totalRefundPoints,
      status: "pending_approval",
      createdAt: now,
      updatedAt: now,
    },
  });
  for (const l of q.lines) {
    const target =
      l.targetType === "order_item"
        ? await h.prisma.orderItem.findUniqueOrThrow({ where: { id: l.targetId } })
        : await h.prisma.ad.findUniqueOrThrow({ where: { id: l.targetId } });
    await h.prisma.cancelRequestLine.create({
      data: {
        id: uuidv7(),
        cancelRequestId: id,
        entityId: r.entityId,
        storeId: r.storeId,
        targetType: l.targetType,
        targetId: l.targetId,
        pointHoldId: target.pointHoldId,
        mode: l.mode,
        stage: l.stage,
        stepAtSubmit: l.stepAtSubmit,
        reasonClass: l.reasonClass,
        chargePoints: l.chargePoints,
        priorRequestedPoints: l.priorRequestedPoints,
        ratioBp: l.ratioBp,
        deductPoints: l.deductPoints,
        deductNote: l.deductNote,
        refundPoints: l.refundPoints,
        terminationDate: l.terminationDate ? new Date(l.terminationDate) : null,
        usageStartDate: l.usageStartDate ? new Date(l.usageStartDate) : null,
        usageEndDate: l.usageEndDate ? new Date(l.usageEndDate) : null,
        usageEndSource: l.usageEndSource,
        previewSnapshot: l.preview,
        createdAt: now,
      },
    });
    if (l.targetType === "ad")
      await h.prisma.ad.update({ where: { id: l.targetId }, data: { openCancelRequestId: id } });
    else
      await h.prisma.dramaOrder.update({
        where: { id: o.out.orderId },
        data: { status: "after_sale", subStatus: "cancel_reviewing", openCancelRequestId: id },
      });
  }
  return r;
}
const check = (r: { id: string }, phase: "approve" | "execute" = "approve") =>
  h.tx.run((tx) =>
    revalidateCancel(tx, { scope: SYSTEM_SCOPE, requestId: r.id, phase }, h.clock.now()),
  );
async function pause(ticketId: string, approvalId: string, reason = "cancel_review") {
  const now = h.clock.now();
  await h.prisma.deliveryTicket.update({
    where: { id: ticketId },
    data: { pauseCount: { increment: 1 }, pausedAt: now },
  });
  return h.prisma.deliveryTicketPause.create({
    data: {
      id: uuidv7(),
      deliveryTicketId: ticketId,
      reason,
      refType: reason === "cancel_review" ? "approval_request" : "delivery_plan_version",
      refId: approvalId,
      actorType: "system",
      createdAt: now,
      updatedAt: now,
    },
  });
}
it("real grant/hold quotes aggregate and repeat with zero writes; hold owner DTO is exact", async () => {
  const o = await order(2),
    before = await snapshotTables(h.prisma, tables),
    q = await quote(o);
  expect(q.lines).toHaveLength(2);
  expect(q.totalRefundPoints).toBe(o.out.totalChargePoints);
  expect(q.destination).toMatchObject({
    backToOriginal: q.totalRefundPoints,
    convertedToAddon: 0,
    forfeited: 0,
  });
  expect(await quote(o)).toEqual(q);
  expect(await h.tx.run((tx) => readCancelHoldFacts(tx, o.items[0]!.pointHoldId))).toMatchObject({
    entityId: o.b.entity.id,
    storeId: o.b.store.id,
    refType: "order_item",
    refId: o.items[0]!.id,
    status: "held",
    qty: o.items[0]!.chargePoints,
    returnedQty: 0,
    forfeitedQty: 0,
  });
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
});
it("scope hides order/ad and bad item selection/qualification reason rejects", async () => {
  const o = await order(),
    a = await ad(o),
    scope = scopeOf({ id: uuidv7(), isLead: false }, { dataScope: "own" }, [], new Set());
  await expect(
    h.tx.run((tx) =>
      quoteOrderCancel(
        tx,
        { scope, orderId: o.out.orderId, body: { reasonCode: "merchant_request" } },
        h.clock.now(),
      ),
    ),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  await expect(
    h.tx.run((tx) =>
      quoteAdCancel(
        tx,
        { scope, adId: a.id, body: { reasonCode: "merchant_request" } },
        h.clock.now(),
      ),
    ),
  ).rejects.toMatchObject({ error: "NOT_FOUND" });
  await expect(
    h.tx.run((tx) =>
      quoteOrderCancel(
        tx,
        {
          scope: SYSTEM_SCOPE,
          orderId: o.out.orderId,
          body: { reasonCode: "merchant_request", orderItemIds: [uuidv7()] },
        },
        h.clock.now(),
      ),
    ),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  await expect(
    h.tx.run((tx) =>
      quoteOrderCancel(
        tx,
        {
          scope: SYSTEM_SCOPE,
          orderId: o.out.orderId,
          body: { reasonCode: "qualification_final" as never },
        },
        h.clock.now(),
      ),
    ),
  ).rejects.toThrow();
});
it.each(["pending_assign", "producing", "revising", "pending_confirm"])(
  "real ad %s holds/captures use original return route",
  async (status) => {
    const o = await order(),
      a = await ad(o, status),
      before = await snapshotTables(h.prisma, tables);
    const q = await h.tx.run((tx) =>
      quoteAdCancel(
        tx,
        { scope: SYSTEM_SCOPE, adId: a.id, body: { reasonCode: "platform_fault" } },
        h.clock.now(),
      ),
    );
    expect(q.lines[0]).toMatchObject({
      targetType: "ad",
      mode: status === "pending_assign" ? "release" : "refund",
      refundPoints: a.chargePoints,
    });
    expect(await h.tx.run((tx) => readAdCancelFacts(tx, a.id))).toMatchObject({
      id: a.id,
      pointHoldId: a.pointHoldId,
    });
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  },
);
it.each(["pending_assign", "producing"])(
  "returned ad from %s keeps correct stage",
  async (from) => {
    const o = await order(),
      a = await ad(o, "returned", from),
      q = await h.tx.run((tx) =>
        quoteAdCancel(
          tx,
          { scope: SYSTEM_SCOPE, adId: a.id, body: { reasonCode: "merchant_request" } },
          h.clock.now(),
        ),
      );
    expect(q.lines[0]).toMatchObject(
      from === "pending_assign"
        ? { mode: "release", stage: "ad_unassigned" }
        : { mode: "terminate_only", stage: "ad_in_production", refundPoints: 0 },
    );
  },
);
it("confirmed ad is blocked", async () => {
  const o = await order(),
    a = await ad(o, "confirmed"),
    q = await h.tx.run((tx) =>
      quoteAdCancel(
        tx,
        { scope: SYSTEM_SCOPE, adId: a.id, body: { reasonCode: "platform_fault" } },
        h.clock.now(),
      ),
    );
  expect(q.lines).toEqual([]);
  expect(q.blockers).toEqual([{ orderItemId: null, reason: "ad_confirmed" }]);
});
it("ad scope also includes its own assigned editor", async () => {
  const o = await order(),
    a = await ad(o, "producing"),
    scope = scopeOf({ id: a.editorId!, isLead: false }, { dataScope: "own" }, [], new Set());
  const q = await h.tx.run((tx) =>
    quoteAdCancel(tx, { scope, adId: a.id, body: { reasonCode: "platform_fault" } }, h.clock.now()),
  );
  expect(q.lines.map((l) => l.targetId)).toEqual([a.id]);
});
it("paid revision is captured separately and never added to ad cancellation", async () => {
  const o = await order(),
    a = await ad(o, "producing"),
    ctx = createIdentityContext({
      actor: { type: "system", job: "lyxtest.revision" },
      entityId: o.b.entity.id,
    });
  const revision = await h.tx.run((tx) =>
    h.ledger.charge(tx, {
      entityId: o.b.entity.id,
      storeId: o.b.store.id,
      refType: "ad_revision",
      refId: uuidv7(),
      pricing: { kind: "ad_revision" },
      title: {
        code: "ad_revision_charge",
        args: { adNo: a.adNo, unitPoints: 50, discountBp: o.b.term!.discountBp },
      },
      captureTitle: { refType: "ad_revision", refNo: a.adNo, count: 1 },
      ctx,
    }),
  );
  const before = await snapshotTables(h.prisma, tables),
    q = await h.tx.run((tx) =>
      quoteAdCancel(
        tx,
        { scope: SYSTEM_SCOPE, adId: a.id, body: { reasonCode: "platform_fault" } },
        h.clock.now(),
      ),
    );
  expect(q.lines.map((l) => l.targetId)).toEqual([a.id]);
  expect(q.totalRefundPoints).toBe(a.chargePoints);
  expect(await h.tx.run((tx) => readCancelHoldFacts(tx, revision.pointHoldId))).toMatchObject({
    refType: "ad_revision",
    status: "captured",
    returnedQty: 0,
    forfeitedQty: 0,
  });
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
});
it("real prior refund is retained; released hold cannot masquerade as cancellable", async () => {
  const o = await order();
  await produce(o);
  const returned = await refundHold(h, { pointHoldId: o.items[0]!.pointHoldId, qty: 10 });
  await h.prisma.orderItem.update({
    where: { id: o.items[0]!.id },
    data: {
      refundRequestedPoints: 10,
      returnedPoints: returned.returnedPoints,
      convertedPoints: returned.convertedPoints,
      forfeitedPoints: returned.forfeitedPoints,
    },
  });
  const q = await quote(o);
  expect(q.lines[0]!.priorRequestedPoints).toBe(10);
  expect(q.totalBasePoints).toBe(o.items[0]!.chargePoints - 10);
  const other = await order();
  await releaseHold(h, other.items[0]!.pointHoldId);
  await expect(quote(other)).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
});
it("current rule changes cannot replace original ratio or original expired forfeiture route", async () => {
  const at = new Date("2035-01-01T00:00:00Z");
  h.clock.set(at);
  await h.prisma.billingParam.create({
    data: {
      id: uuidv7(),
      key: "expiredTermRefund",
      value: { merchant: "forfeit", platform: "addon", qualification: "addon" },
      effectiveAt: at,
      changeId: uuidv7(),
      createdAt: at,
    },
  });
  const o = await order(1, new Date("2035-01-05T04:00:00Z"));
  await produce(o);
  const original = await quote(o);
  const later = new Date("2035-03-05T04:00:00Z");
  await h.prisma.billingParam.create({
    data: {
      id: uuidv7(),
      key: "cancelDeductionBp",
      value: {
        planConfirm: 10000,
        adAndSample: 10000,
        samplePending: 10000,
        postSample: 10000,
        adInProduction: 10000,
      },
      effectiveAt: later,
      changeId: uuidv7(),
      createdAt: later,
    },
  });
  h.clock.set(later);
  expect((await paramsAt(h.prisma, later)).cancelDeductionBp.adAndSample).toBe(10000);
  const before = await snapshotTables(h.prisma, tables),
    expired = await quote(o);
  expect(expired.totalRefundPoints).toBe(original.totalRefundPoints);
  expect(expired.lines[0]!.ratioBp).toBe(3000);
  expect(expired.destination).toMatchObject({
    backToOriginal: 0,
    convertedToAddon: 0,
    forfeited: expired.totalRefundPoints,
  });
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
});
it("in-use binding blocks ad, closed item no longer blocks", async () => {
  const o = await order(),
    a = await ad(o);
  await h.prisma.orderItemPlacement.create({
    data: {
      id: uuidv7(),
      orderItemId: o.items[0]!.id,
      slot: "opening",
      adId: a.id,
      durationSec: 3,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
  const read = () =>
    h.tx.run((tx) =>
      quoteAdCancel(
        tx,
        { scope: SYSTEM_SCOPE, adId: a.id, body: { reasonCode: "merchant_request" } },
        h.clock.now(),
      ),
    );
  expect((await read()).blockers).toEqual([{ orderItemId: null, reason: "ad_in_use" }]);
  await h.prisma.orderItem.update({
    where: { id: o.items[0]!.id },
    data: { phase: "cancelled", cancelledAt: h.clock.now(), cancelReasonCode: "merchant_request" },
  });
  expect((await read()).lines).toHaveLength(1);
});
it("qualification port uses true same-source candidates and excludes open pointers", async () => {
  const o = await order(),
    a = await ad(o, "returned", "pending_assign"),
    q = await quote(o);
  const input = { entityId: o.b.entity.id, storeId: o.b.store.id },
    before = await snapshotTables(h.prisma, tables);
  for (const entry of ["api", "worker"] as const) {
    const impact = await h.tx.run((tx) =>
      assembleForTest({ entry })
        .port(QualificationImpactPort)
        .previewFinalReject(tx, input, h.clock.now()),
    );
    expect(impact).toMatchObject({
      pendingStartOrderCount: 1,
      pendingAssignAdCount: 1,
      heldPoints: q.totalRefundPoints + a.chargePoints,
    });
  }
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  await save(o, q);
  expect(await h.tx.run((tx) => previewFinalReject(tx, input, h.clock.now()))).toMatchObject({
    pendingStartOrderCount: 0,
    pendingAssignAdCount: 1,
    heldPoints: a.chargePoints,
  });
  expect(() =>
    assembleForTest({ entry: "api", withoutRealPorts: [QualificationImpactPort] }),
  ).toThrow(/profile.qualification_impact/);
});
it("release revalidation is zero write, correct pointer passes, period rollover differs", async () => {
  const o = await order(),
    r = await save(o, await quote(o)),
    before = await snapshotTables(h.prisma, tables);
  expect(await check(r)).toMatchObject({ ok: true, diffs: [] });
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  h.clock.set(o.b.term!.endsAt);
  const changed = await check(r);
  expect(changed.ok).toBe(false);
  expect(changed.diffs.some((d) => d.field === "preview.backToOriginal")).toBe(true);
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
});
it("execute phase requires pending_execution and remains pure read", async () => {
  const o = await order(),
    r = await save(o, await quote(o));
  expect((await check(r, "execute")).diffs.some((d) => d.field === "request.status")).toBe(true);
  const now = h.clock.now();
  await h.prisma.cancelRequest.update({
    where: { id: r.id },
    data: {
      status: "pending_execution",
      execDueAt: new Date(now.getTime() + 86400000),
      slaSnapshot: {
        policy: "review.refund_execute",
        amount: 1,
        unit: "work_days",
        calendarVersion: 1,
        computedAt: now.toISOString(),
      },
    },
  });
  const before = await snapshotTables(h.prisma, tables);
  expect(await check(r, "execute")).toMatchObject({ ok: true });
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
});
it("manual-null uses the original snapshot; explicit full deduction is real qty-zero recheck", async () => {
  const o = await order(),
    ticket = await produce(o, "delivering"),
    first = await quote(o);
  expect(first).toMatchObject({ needsManualDeduct: true });
  expect(first.lines[0]).toMatchObject({ ratioBp: null, isManualDeduct: true, deductPoints: 0 });
  const amount = o.items[0]!.chargePoints;
  const q = await h.tx.run((tx) =>
    quoteOrderCancel(
      tx,
      {
        scope: SYSTEM_SCOPE,
        orderId: o.out.orderId,
        body: {
          reasonCode: "merchant_request",
          manualDeducts: [
            {
              orderItemId: o.items[0]!.id.toUpperCase(),
              deductPoints: amount,
              deductNote: "制作成本依据",
            },
          ],
        },
      },
      h.clock.now(),
    ),
  );
  expect(q.lines[0]).toMatchObject({
    mode: "terminate_only",
    refundPoints: 0,
    preview: { qty: 0, backToOriginal: 0, convertedToAddon: 0, forfeited: 0, lots: [] },
  });
  const r = await save(o, q);
  await pause(ticket.id, r.approvalRequestId);
  expect(await check(r)).toMatchObject({ ok: true });
});
it("quote rejects out-of-range manual deduction and future live date before any write", async () => {
  const o = await order(),
    before = await snapshotTables(h.prisma, tables);
  await expect(
    h.tx.run((tx) =>
      quoteOrderCancel(
        tx,
        {
          scope: SYSTEM_SCOPE,
          orderId: o.out.orderId,
          body: {
            reasonCode: "merchant_request",
            manualDeducts: [
              {
                orderItemId: o.items[0]!.id,
                deductPoints: o.items[0]!.chargePoints + 1,
                deductNote: "依据",
              },
            ],
          },
        },
        h.clock.now(),
      ),
    ),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  await produce(o, "in_service", true);
  await expect(
    h.tx.run((tx) =>
      quoteOrderCancel(
        tx,
        {
          scope: SYSTEM_SCOPE,
          orderId: o.out.orderId,
          body: { reasonCode: "platform_fault", terminationDate: "2026-01-06" },
        },
        h.clock.now(),
      ),
    ),
  ).rejects.toMatchObject({ error: "VALIDATION_FAILED" });
});
it("ad revalidation passes only original state/no binding and detects later binding", async () => {
  const o = await order(),
    a = await ad(o),
    q = await h.tx.run((tx) =>
      quoteAdCancel(
        tx,
        { scope: SYSTEM_SCOPE, adId: a.id, body: { reasonCode: "merchant_request" } },
        h.clock.now(),
      ),
    ),
    r = await save(o, q, "ad_cancel");
  expect(await check(r)).toMatchObject({ ok: true });
  const now = h.clock.now();
  await h.prisma.orderItemPlacement.create({
    data: {
      id: uuidv7(),
      orderItemId: o.items[0]!.id,
      slot: "opening",
      adId: a.id,
      durationSec: 3,
      createdAt: now,
      updatedAt: now,
    },
  });
  expect((await check(r)).diffs.some((d) => d.field === "boundOrderItemIds")).toBe(true);
  await expect(
    h.tx.run((tx) =>
      quoteAdCancel(
        tx,
        { scope: SYSTEM_SCOPE, adId: a.id, body: { reasonCode: "merchant_request" } },
        h.clock.now(),
      ),
    ),
  ).rejects.toMatchObject({ error: "AD_CANCEL_IN_PROGRESS" });
});
it("qualification release revalidation and true empty impact; cross-type order pointer rejects", async () => {
  const o = await order(),
    q = await quote(o),
    r = await save(
      o,
      {
        ...q,
        reasonCode: "qualification_final",
        lines: q.lines.map((l) => ({ ...l, reasonClass: "qualification" })),
      },
      "qualification_cancel",
    );
  expect(await check(r)).toMatchObject({ ok: true });
  await expect(quote(o)).rejects.toMatchObject({ error: "ORDER_IN_AFTER_SALE" });
  const empty = await h.make.merchant({ verified: true });
  expect(
    await h.tx.run((tx) =>
      previewFinalReject(tx, { entityId: empty.entity.id, storeId: empty.store.id }, h.clock.now()),
    ),
  ).toMatchObject({
    pendingStartOrderCount: 0,
    pendingAssignAdCount: 0,
    heldPoints: 0,
    orders: [],
    ads: [],
  });
});
it("read-only recomputation participates in an outer rollback without persisting any result", async () => {
  const o = await order(),
    r = await save(o, await quote(o)),
    before = await snapshotTables(h.prisma, tables);
  await expect(
    h.tx.run(async (tx) => {
      expect(
        await revalidateCancel(
          tx,
          { scope: SYSTEM_SCOPE, requestId: r.id, phase: "approve" },
          h.clock.now(),
        ),
      ).toMatchObject({ ok: true });
      throw new Error("caller abort");
    }),
  ).rejects.toThrow("caller abort");
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
});
it("steps1-9 require own active cause, not another request or plan_amendment", async () => {
  const o = await order(),
    ticket = await produce(o),
    r = await save(o, await quote(o));
  await pause(ticket.id, uuidv7());
  await pause(ticket.id, uuidv7(), "plan_amendment");
  expect((await check(r)).diffs.some((d) => d.field === "cancelReviewPause")).toBe(true);
  const own = await pause(ticket.id, r.approvalRequestId);
  expect(await check(r)).toMatchObject({ ok: true });
  await h.prisma.deliveryTicketPause.update({
    where: { id: own.id },
    data: { releasedAt: h.clock.now(), releaseEvent: "withdrawn" },
  });
  expect((await check(r)).diffs.some((d) => d.field === "cancelReviewPause")).toBe(true);
});
it("state advancement and pointer removal fail visibly", async () => {
  const o = await order(),
    ticket = await produce(o),
    r = await save(o, await quote(o));
  await pause(ticket.id, r.approvalRequestId);
  await h.prisma.deliveryTicket.update({
    where: { id: ticket.id },
    data: { step: "sample_confirm" },
  });
  expect((await check(r)).diffs.some((d) => d.field === "stepAtSubmit")).toBe(true);
  await h.prisma.dramaOrder.update({
    where: { id: o.out.orderId },
    data: { status: "producing", subStatus: "sample_making", openCancelRequestId: null },
  });
  expect((await check(r)).diffs.some((d) => d.field === "openCancelRequestId")).toBe(true);
});
it("live fixed date survives next day and takedown; usage source change rejects", async () => {
  const o = await order(),
    ticket = await produce(o, "in_service", true),
    q = await quote(o, "platform_fault"),
    r = await save(o, q);
  h.clock.set(new Date("2026-01-06T04:00:00Z"));
  await h.prisma.deliveryTicket.update({ where: { id: ticket.id }, data: { step: "takedown" } });
  expect(await check(r)).toMatchObject({ ok: true });
  await h.prisma.orderItem.update({
    where: { id: o.items[0]!.id },
    data: { usageEndSource: "early_end" },
  });
  expect((await check(r)).diffs.some((d) => d.field === "usageEndSource")).toBe(true);
});
it("whole caller lock graph re-entry never writes; changed state from second connection rejects", async () => {
  const o = await order(),
    r = await save(o, await quote(o)),
    peer = await joinLedger(h, await db.url());
  try {
    await peer.prisma.dramaOrder.update({
      where: { id: o.out.orderId },
      data: { status: "pending_start", subStatus: "starting", openCancelRequestId: null },
    });
    const before = await snapshotTables(h.prisma, tables);
    const result = await h.tx.run(async (tx) => {
      await lockRows(tx, "approval_request", [r.approvalRequestId]);
      await lockRows(tx, "cancel_request", [r.id]);
      const lines = await tx.cancelRequestLine.findMany({
        where: { cancelRequestId: r.id },
        select: { id: true },
      });
      await lockRows(
        tx,
        "cancel_request_line",
        lines.map((l) => l.id),
      );
      await lockRows(tx, "drama_order", [o.out.orderId]);
      await lockRows(
        tx,
        "order_item",
        o.items.map((i) => i.id),
      );
      return revalidateCancel(
        tx,
        { scope: SYSTEM_SCOPE, requestId: r.id, phase: "approve" },
        h.clock.now(),
      );
    });
    expect(result.ok).toBe(false);
    assertSnapshotsEqual(before, await snapshotTables(h.prisma, tables));
  } finally {
    await peer.close();
  }
});
it("quote does not wait for another transaction's object/account write locks", async () => {
  const o = await order(),
    peer = await joinLedger(h, await db.url());
  let signal!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => {
      signal = r;
    }),
    done = new Promise<void>((r) => {
      release = r;
    });
  const locked = peer.tx.run(async (tx) => {
    await lockRows(tx, "drama_order", [o.out.orderId]);
    await lockRows(tx, "billing_account", [o.b.entity.id]);
    signal();
    await done;
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([ready, locked]);
    const q = await Promise.race([
      quote(o),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("readonly quote waited for write locks")),
          3000,
        );
      }),
    ]);
    expect(q.totalRefundPoints).toBe(o.out.totalChargePoints);
  } finally {
    if (timeout) clearTimeout(timeout);
    release();
    await locked;
    await peer.close();
  }
});
