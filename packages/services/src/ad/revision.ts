import { AdRequestChangeBodySchema } from "@liyoxi/contract";
import type { AdRequestChangeBody } from "@liyoxi/contract";
import type { Ad } from "@liyoxi/db";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { getEntitlements, quoteHold } from "../billing/index.js";
import { paramsAt } from "../config/index.js";
import { readMaterialFileFacts } from "../media/index.js";
import type {
  AdActor,
  AdFreeReopenInput,
  AdReopenChange,
  AdStaffActor,
  AdWriteDeps,
} from "./context.js";
import { adDue, armAdDue, member, merchantAd, moveAd, noCancel } from "./lifecycle.js";
import { readAdCancelFacts } from "./cancel-read-facts.js";
import { assertAdStaff } from "./admin-read.js";

export async function requestChangeAdTx(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdActor,
  adId: string,
  input: AdRequestChangeBody,
): Promise<AdReopenChange> {
  const body = AdRequestChangeBodySchema.parse(input);
  await member(tx, actor, true);
  await lockRows(tx, "ad", [adId]);
  const ad = await merchantAd(tx, actor, adId);
  return writeRevision(tx, deps, actor.ctx, ad, body, "ad_page", false);
}

/** Staff entry is free-only. Ops owns the full low-to-high impact graph before calling this core. */
export async function reopenAdFreeTx(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdStaffActor,
  input: AdFreeReopenInput,
): Promise<AdReopenChange> {
  if (actor.ctx.actor.type !== "staff" || actor.ctx.actor.id !== actor.staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  const visible = await readAdCancelFacts(tx, input.adId, actor.staff.scope);
  if (!visible) throw new AppError("NOT_FOUND");
  await lockRows(tx, "ad", [input.adId]);
  const ad = await tx.ad.findUniqueOrThrow({ where: { id: input.adId } });
  noCancel(ad);
  if (!(await readAdCancelFacts(tx, input.adId, actor.staff.scope)))
    throw new AppError("NOT_FOUND");
  if (ad.revisionCount >= ad.freeRevisionQuota) throw new AppError("AD_FREE_REVISION_EXHAUSTED");
  return writeRevision(
    tx,
    deps,
    actor.ctx,
    ad,
    AdRequestChangeBodySchema.parse({
      versionNo: input.onVersionNo,
      note: input.note,
      screenshotFileIds: [...input.screenshotFileIds],
    }),
    "sample_feedback",
    true,
  );
}

/** The dedicated staff-on-behalf entry shares the merchant's exact round validation, free-only. */
export async function requestAdminAdChangeTx(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdStaffActor,
  adId: string,
  body: Omit<AdRequestChangeBody, "acceptChargePoints">,
): Promise<AdReopenChange> {
  assertAdStaff(actor, "delivery.sample.feedback_on_behalf", true);
  if (actor.ctx.actor.type !== "staff" || actor.ctx.actor.id !== actor.staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  if (!(await readAdCancelFacts(tx, adId, actor.staff.scope))) throw new AppError("NOT_FOUND");
  await lockRows(tx, "ad", [adId]);
  if (!(await readAdCancelFacts(tx, adId, actor.staff.scope))) throw new AppError("NOT_FOUND");
  const ad = await tx.ad.findUniqueOrThrow({ where: { id: adId } });
  return writeRevision(
    tx,
    deps,
    actor.ctx,
    ad,
    AdRequestChangeBodySchema.parse(body),
    "staff_on_behalf",
    true,
  );
}

async function writeRevision(
  tx: Tx,
  deps: AdWriteDeps,
  ctx: IdentityContext,
  ad: Ad,
  body: AdRequestChangeBody,
  source: "ad_page" | "sample_feedback" | "staff_on_behalf",
  freeOnly: boolean,
): Promise<AdReopenChange> {
  noCancel(ad);
  const version = await tx.adVersion.findFirst({
    where: { adId: ad.id, pushedAt: { not: null } },
    orderBy: { versionNo: "desc" },
  });
  if (!version || version.versionNo !== body.versionNo)
    throw new AppError("AD_VERSION_STALE", {
      details: { currentVersionNo: version?.versionNo ?? null },
    });
  if (
    !["pending_confirm", "confirmed"].includes(ad.status) ||
    ![null, "confirmed"].includes(version.decision)
  )
    throw new AppError("STATE_NOT_ALLOWED");
  if (await tx.adRevision.findFirst({ where: { adId: ad.id, fulfilledByVersionNo: null } }))
    throw new AppError("STATE_NOT_ALLOWED");
  let start = body.timeStartMs ?? null,
    end = body.timeEndMs ?? null;
  if (body.segmentIndex != null) {
    const segments = Array.isArray(version.segments) ? version.segments : [];
    const segment = segments.find(
      (s) => s && typeof s === "object" && !Array.isArray(s) && s.index === body.segmentIndex,
    );
    if (
      !segment ||
      typeof segment !== "object" ||
      Array.isArray(segment) ||
      typeof segment.fromMs !== "number" ||
      typeof segment.toMs !== "number"
    )
      throw new AppError("VALIDATION_FAILED");
    start = segment.fromMs;
    end = segment.toMs;
  }
  if (start !== null && (start < 0 || end === null || start >= end || end > version.durationMs))
    throw new AppError("VALIDATION_FAILED");
  let now = deps.clock.now();
  const params = await paramsAt(tx, ["ad.revision_screenshot_max"], now),
    files = body.screenshotFileIds ?? [];
  if (files.length > params["ad.revision_screenshot_max"]) throw new AppError("VALIDATION_FAILED");
  await lockRows(tx, "file_object", files);
  const facts = await readMaterialFileFacts(tx, files);
  for (const id of files) {
    const f = facts.find((f) => f.id === id);
    if (
      !f ||
      f.entityId !== ad.entityId ||
      f.storeId !== ad.storeId ||
      f.scopeType !== "store" ||
      f.category !== "ticket_attachment" ||
      f.status !== "stored" ||
      f.moderationState === "block" ||
      f.deletedAt ||
      f.erasedAt ||
      (ctx.actor.type === "merchant" &&
        (f.uploadActorType !== "merchant" || f.uploadActorId !== ctx.actor.id))
    )
      throw new AppError("FILE_NOT_USABLE", {
        details: { fileIds: [id], reason: "scope_mismatch" },
      });
  }
  const revisionNo = ad.revisionCount + 1,
    chargeable = revisionNo > ad.freeRevisionQuota;
  let chargePoints = 0,
    holdId: string | null = null;
  const id = uuidv7();
  if (freeOnly && chargeable) throw new AppError("AD_FREE_REVISION_EXHAUSTED");
  if (chargeable) {
    // Every lower-ranked member/ad/delivery/file target is already held by the caller.
    // Quote the advanced account at the actual ledger clock, then charge by reentry only.
    now = new Date((await deps.ledger.lockAccount(tx, ad.entityId)).now);
    const ent = await getEntitlements(tx, ad.entityId, now);
    if (!ent.term || ent.subStatus !== "active") throw new AppError("SUBSCRIPTION_INACTIVE");
    if (ent.refundPending) throw new AppError("PLAN_REFUND_IN_PROGRESS");
    const quote = await quoteHold(
      tx,
      { ...ent.term, id: ent.term.termId },
      { kind: "ad_revision" },
      now,
    );
    chargePoints = quote.S;
    const changed = () =>
      new AppError("CHARGE_CHANGED", {
        details: { isChargeable: true, chargePoints, freeRevisionsRemaining: 0 },
      });
    if (body.acceptChargePoints !== chargePoints) throw changed();
    try {
      const held = await deps.ledger.charge(tx, {
        entityId: ad.entityId,
        storeId: ad.storeId,
        refType: "ad_revision",
        refId: id,
        groupRef: ad.adNo,
        pricing: { kind: "ad_revision" },
        expectS: body.acceptChargePoints,
        title: {
          code: "ad_revision_charge",
          args: {
            adNo: ad.adNo,
            unitPoints: quote.kind === "ad_revision" ? quote.unitPoints : ad.unitPricePoints,
            discountBp: ent.term.discountBp,
          },
        },
        captureTitle: { refType: "ad_revision", refNo: ad.adNo, count: 1 },
        ctx,
      });
      holdId = held.pointHoldId;
      chargePoints = held.points;
      if (
        held.snapshot.kind !== "ad_revision" ||
        quote.kind !== "ad_revision" ||
        held.snapshot.unitPoints !== quote.unitPoints ||
        held.snapshot.discountBp !== quote.discountBp
      )
        throw changed();
      now = new Date(held.now);
    } catch (error) {
      if (error instanceof AppError && error.error === "QUOTE_CHANGED") {
        if (
          error.details &&
          typeof error.details === "object" &&
          "totalChargePoints" in error.details &&
          typeof error.details.totalChargePoints === "number"
        )
          chargePoints = error.details.totalChargePoints;
        throw changed();
      }
      throw error;
    }
  }
  const due = await adDue(tx, deps, "revision", now);
  await tx.adRevision.create({
    data: {
      id,
      adId: ad.id,
      entityId: ad.entityId,
      storeId: ad.storeId,
      revisionNo,
      onVersionNo: version.versionNo,
      source,
      isChargeable: chargeable,
      chargePoints,
      chargePointHoldId: holdId,
      timeStartMs: start,
      timeEndMs: end,
      segmentIndex: body.segmentIndex ?? null,
      note: body.note,
      screenshotFileIds: files,
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      client: ctx.actor.client,
      dueAt: due.dueAt,
      createdAt: now,
      updatedAt: now,
    },
  });
  for (const fileId of files)
    await deps.media.link(tx, {
      fileId,
      entityId: ad.entityId,
      storeId: ad.storeId,
      refType: "ad_revision",
      refId: id,
      role: "screenshot",
    });
  // A previously confirmed version remains immutable and remains the order selection anchor.
  if (version.decision === null)
    await tx.adVersion.update({
      where: { id: version.id },
      data: { decision: "revision_requested", decidedAt: now, updatedAt: now },
    });
  await moveAd(
    tx,
    deps,
    ctx,
    ad,
    "ad.request_revision",
    "09:807",
    { revision_count: revisionNo, due_at: due.dueAt, sla_snapshot: due.snapshot },
    {
      type: "ad.revision_requested",
      payload: {
        v: 1,
        adId: ad.id,
        onVersionNo: version.versionNo,
        revisionNo,
        isCharged: chargeable,
      },
    },
    { versionNo: version.versionNo, revisionNo },
  );
  await armAdDue(tx, deps, ad, "rev", revisionNo, due);
  return {
    adId: ad.id,
    revisionId: id,
    revisionNo,
    onVersionNo: version.versionNo,
    previousConfirmedVersionNo: ad.confirmedVersionNo,
    latestVersionNo: ad.latestVersionNo,
    dueAt: due.dueAt,
  };
}
