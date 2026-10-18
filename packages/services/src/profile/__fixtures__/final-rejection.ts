import {
  AdPricingSnapshotSchema,
  DramaPricingSnapshotSchema,
  DramaSnapshotSchema,
  ReturnBreakdownSchema,
} from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import {
  createLedgerHarness,
  openTerm,
  prepareOrderDrama,
  previewReturnForTest,
} from "../../testing/index.js";
import type { Harness } from "./harness.js";
import type { ProfileViewer } from "../context.js";
let sequence = 70000;

/** 真实账本冻结及快照，供profile真实影响端口消费；不换order端口、不造退款结果。 */
export async function impactFixture(h: Harness, viewer: ProfileViewer) {
  const ledger = createLedgerHarness(h.prisma, { clock: h.clock });
  const { entityId, storeId } = viewer.membership;
  if (!(await h.prisma.billingAccount.findUnique({ where: { entityId } })))
    await h.make.billingAccount({ entityId });
  const { term } = await openTerm(ledger, { entityId });
  const ctx = createIdentityContext({ actor: { type: "system", job: "lyxtest.final_impact" } });
  async function order() {
    const id = uuidv7(),
      drama = await prepareOrderDrama(ledger, 120);
    const copyright = await h.prisma.dramaCopyright.findUniqueOrThrow({
      where: { dramaId: drama.id },
    });
    if (!copyright.licenseEndDate)
      throw new Error("Order drama fixture requires a license end date");
    const permits = await h.prisma.dramaPermit.findMany({
      where: { dramaId: drama.id, status: "active" },
      orderBy: { id: "asc" },
    });
    const snapshot = DramaSnapshotSchema.parse({
      dramaId: drama.id,
      title: drama.title,
      totalEpisodes: drama.totalEpisodes,
      dramaClass: drama.dramaClass,
      genreCodes: drama.genreCodes,
      permits: permits.map((permit) => ({
        platform: permit.platform,
        kind: permit.permitKind,
        number: permit.permitNo,
      })),
      licenseEndDate: copyright.licenseEndDate.toISOString().slice(0, 10),
      posterFileId: drama.posterFileId,
      allowedPlacements: drama.allowedPlacements,
      isAiGenerated: drama.isAiGenerated,
    });
    const held = await h.tx.run((tx) =>
      ledger.ledger.hold(tx, {
        entityId,
        storeId,
        refType: "order_item",
        refId: id,
        pricing: { kind: "drama", dramaId: drama.id, topModel: false },
        title: {
          code: "order_hold",
          args: {
            dramaTitles: [drama.title],
            count: 1,
            pricePoints: [120],
            discountBp: term.discountBp,
            surchargeBp: 0,
          },
        },
        ctx,
      }),
    );
    const pricing = DramaPricingSnapshotSchema.parse(held.snapshot);
    const row = await h.make.dramaOrder({
      entityId,
      storeId,
      placedByUserId: viewer.principal.merchantUserId,
      subscriptionTermId: term.id,
      totalChargePoints: held.points,
    });
    const item = await h.make.orderItem({
      id,
      dramaOrderId: row.id,
      dramaId: drama.id,
      pointHoldId: held.pointHoldId,
      chargePoints: held.points,
      listPricePoints: pricing.P,
      pricingSnapshot: held.snapshot,
      dramaSnapshot: snapshot,
    });
    return { row, item, points: held.points };
  }
  async function ad(status = "pending_assign", returnedFrom?: string) {
    const id = uuidv7(),
      now = h.clock.now(),
      adNo = `GG20260105${sequence++}`;
    const held = await h.tx.run((tx) =>
      ledger.ledger.hold(tx, {
        entityId,
        storeId,
        refType: "ad",
        refId: id,
        pricing: { kind: "ad" },
        title: { code: "ad_hold", args: { adNo, unitPoints: 50, discountBp: term.discountBp } },
        ctx,
      }),
    );
    const pricing = AdPricingSnapshotSchema.parse(held.snapshot);
    const captured =
      status !== "pending_assign" && !(status === "returned" && returnedFrom === "pending_assign");
    if (captured)
      await h.tx.run((tx) =>
        ledger.ledger.capture(tx, {
          pointHoldId: held.pointHoldId,
          title: { refType: "ad", refNo: adNo, count: 1 },
          ctx,
        }),
      );
    const editor = captured ? await h.make.staff({ staffRoleKey: "editor" }) : null;
    const consent = await h.make.agreementConsent({
      scene: "ad_request",
      merchantUserId: viewer.principal.merchantUserId,
      entityId,
      storeId,
      bizId: id,
    });
    return h.prisma.ad.create({
      data: {
        id,
        adNo,
        entityId,
        storeId,
        requestedByUserId: viewer.principal.merchantUserId,
        type: "opening",
        durationSec: 3,
        promoPointCodes: ["TEST"],
        status,
        returnedFrom: returnedFrom ?? null,
        ...(status === "returned" ? { returnedAt: now, returnReason: "补充说明" } : {}),
        unitPricePoints: pricing.unitPoints,
        discountBp: pricing.discountBp,
        chargePoints: held.points,
        pricingSnapshot: held.snapshot,
        pointHoldId: held.pointHoldId,
        capturedAt: captured ? now : null,
        editorId: editor?.id ?? null,
        freeRevisionQuota: pricing.freeRevisions,
        agreementConsentId: consent.id,
        submittedAt: now,
        firstDueAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  async function inflight(
    target: { id: string; points: number },
    kind: "order_cancel" | "ad_cancel",
  ) {
    const id = uuidv7(),
      now = h.clock.now(),
      staff = await h.make.staff({ staffRoleKey: "cs" });
    const approval = await h.prisma.approvalRequest.create({
      data: {
        id: uuidv7(),
        requestNo: `TK20260105${sequence++}`,
        kind,
        category: "approval",
        subjectType: kind === "order_cancel" ? "drama_order" : "ad",
        subjectId: target.id,
        entityId,
        storeId,
        status: "pending",
        summarySnapshot: { title: "已有取消申请" },
        requesterStaffId: staff.id,
        submitActorType: "staff",
        submitActorId: staff.id,
        submitClient: "admin",
        submittedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
    await h.prisma.cancelRequest.create({
      data: {
        id,
        approvalRequestId: approval.id,
        kind,
        entityId,
        storeId,
        dramaOrderId: kind === "order_cancel" ? target.id : null,
        adId: kind === "ad_cancel" ? target.id : null,
        reasonCode: "merchant_request",
        note: "已有在途取消",
        lineCount: 1,
        totalBasePoints: target.points,
        totalDeductPoints: 0,
        totalRefundPoints: target.points,
        status: "pending_approval",
        createdAt: now,
        updatedAt: now,
      },
    });
    const line =
      kind === "order_cancel"
        ? await h.prisma.orderItem.findFirstOrThrow({ where: { dramaOrderId: target.id } })
        : await h.prisma.ad.findUniqueOrThrow({ where: { id: target.id } });
    const { arbitrageHint: _hint, ...preview } = await h.tx.run((tx) =>
      previewReturnForTest(
        tx,
        { holdId: line.pointHoldId, qty: target.points, reasonClass: "merchant" },
        now,
      ),
    );
    await h.prisma.cancelRequestLine.create({
      data: {
        id: uuidv7(),
        cancelRequestId: id,
        entityId,
        storeId,
        targetType: kind === "order_cancel" ? "order_item" : "ad",
        targetId: line.id,
        pointHoldId: line.pointHoldId,
        mode: "release",
        stage: kind === "order_cancel" ? "pending_start" : "ad_unassigned",
        stepAtSubmit: kind === "order_cancel" ? null : "pending_assign",
        reasonClass: "merchant",
        chargePoints: target.points,
        priorRequestedPoints: 0,
        deductPoints: 0,
        refundPoints: target.points,
        previewSnapshot: ReturnBreakdownSchema.parse(preview),
        createdAt: now,
      },
    });
    if (kind === "order_cancel")
      await h.prisma.dramaOrder.update({
        where: { id: target.id },
        data: { status: "after_sale", subStatus: "cancel_reviewing", openCancelRequestId: id },
      });
    else await h.prisma.ad.update({ where: { id: target.id }, data: { openCancelRequestId: id } });
    return id;
  }
  return { order, ad, inflight };
}
