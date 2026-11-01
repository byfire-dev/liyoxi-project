import type { AdCreateBody } from "@liyoxi/contract";
import { maskName } from "@liyoxi/shared/mask";
import { uuidv7, lockRows, AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { readAdAgreementFacts } from "../docs/index.js";
import { quoteHold } from "../billing/index.js";
import { createFlow } from "../flow/index.js";
import { lockCalendarImport } from "../sla/index.js";
import { linkAdAssetReferences } from "../media/index.js";
import type { AdActor, AdWriteDeps } from "./context.js";
import { creationChecks, currentAgreement, referenceChecks } from "./checks.js";
import { adDue, armAdDue, member, moveAd } from "./lifecycle.js";

export async function createAdTx(tx: Tx, deps: AdWriteDeps, actor: AdActor, body: AdCreateBody) {
  await lockCalendarImport(tx);
  const { entityId, storeId } = actor.membership;
  await lockRows(tx, "entity", [entityId]);
  await lockRows(tx, "entity_member", [actor.membership.memberId]);
  await lockRows(tx, "store", [storeId]);
  const membership = await member(tx, actor),
    before = deps.clock.now();
  const selected = await tx.dictItem.findMany({
    where: { dictTypeKey: "ad_promo_point", code: { in: body.promoPointCodes }, isEnabled: true },
    select: { code: true },
  });
  for (const code of body.promoPointCodes)
    if (!selected.some((d) => d.code === code))
      throw new AppError("DICT_ITEM_DISABLED", {
        details: { dictTypeKey: "ad_promo_point", code },
      });
  const checks = await creationChecks(tx, deps, actor, body, before);
  const pricing = await quoteHold(
    tx,
    { ...checks.term, id: checks.term.termId },
    { kind: "ad" },
    before,
  );
  if (pricing.kind !== "ad") throw new TypeError("广告计价必须为ad");
  await currentAgreement(tx, deps, body.agreementVersionId);
  const id = uuidv7(),
    adNo = await deps.bizNo.next(tx, "GG");
  const store = await tx.store.findUniqueOrThrow({
    where: { id: storeId },
    include: { entity: true },
  });
  const user = await tx.merchantUser.findUniqueOrThrow({ where: { id: actor.ctx.actor.id! } });
  const { hasPriorConsent: prior } = await readAdAgreementFacts(tx, {
    merchantUserId: user.id,
    entityId,
    agreementVersionId: body.agreementVersionId,
  });
  if (!prior && !body.isAgreementChecked) throw new AppError("VALIDATION_FAILED");
  const consent = await deps.docs.assertConsents(tx, actor.ctx, {
    scene: "ad_request",
    method: body.isAgreementChecked ? "checkbox" : "prior_consent",
    consents: [{ agreementVersionId: body.agreementVersionId }],
    signer: {
      merchantUserId: user.id,
      phoneEnc: user.phoneEnc!,
      phoneMask: user.phoneMask!,
      operatorNameMask:
        membership.displayName || user.displayName
          ? maskName(membership.displayName || user.displayName!)
          : null,
      role: "owner",
      appid: null,
      openidHmac: null,
    },
    entity: {
      entityId,
      storeId,
      entityName: store.entity.name,
      usccEnc: store.entity.usccEnc,
      usccMask: store.entity.usccMask,
    },
    biz: { type: "ad", id, no: adNo },
  });
  await referenceChecks(
    tx,
    actor,
    body.referenceStoreAssetIds ?? [],
    body.referenceFileIds ?? [],
    true,
  );
  const held = await deps.ledger.hold(tx, {
    entityId,
    storeId,
    refType: "ad",
    refId: id,
    groupRef: adNo,
    pricing: { kind: "ad" },
    expectS: body.expectChargePoints,
    title: {
      code: "ad_hold",
      args: { adNo, unitPoints: pricing.unitPoints, discountBp: pricing.discountBp },
    },
    ctx: actor.ctx,
  });
  const now = new Date(held.now),
    actual = held.snapshot;
  if (actual.kind !== "ad") throw new TypeError("广告冻结必须为ad");
  if (
    actual.unitPoints !== pricing.unitPoints ||
    actual.discountBp !== pricing.discountBp ||
    actual.freeRevisions !== pricing.freeRevisions
  )
    throw new AppError("QUOTE_CHANGED", {
      details: {
        kind: "points",
        totalChargePoints: actual.S,
        items: [{ dramaId: null, chargePoints: actual.S }],
      },
    });
  await creationChecks(tx, deps, actor, body, now);
  await currentAgreement(tx, deps, body.agreementVersionId);
  const due = await adDue(tx, deps, "first_version", now);
  await tx.ad.create({
    data: {
      id,
      adNo,
      entityId,
      storeId,
      requestedByUserId: user.id,
      type: body.type,
      durationSec: body.durationSec,
      promoPointCodes: body.promoPointCodes,
      copy: body.copy ?? null,
      remark: body.remark ?? null,
      status: "pending_assign",
      unitPricePoints: actual.unitPoints,
      discountBp: actual.discountBp,
      chargePoints: held.points,
      pricingSnapshot: actual,
      pointHoldId: held.pointHoldId,
      freeRevisionQuota: actual.freeRevisions,
      agreementConsentId: consent.consents[0]!.agreementConsentId,
      submittedAt: now,
      firstDueAt: due.dueAt,
      dueAt: due.dueAt,
      slaSnapshot: { ...due.snapshot },
      createdAt: now,
      updatedAt: now,
    },
  });
  await linkAdAssetReferences(
    tx,
    { entityId, storeId, ids: body.referenceStoreAssetIds ?? [], adId: id, now },
    deps.media.link,
  );
  for (const fileId of body.referenceFileIds ?? [])
    await deps.media.link(tx, {
      fileId,
      entityId,
      storeId,
      refType: "ad",
      refId: id,
      role: "reference",
    });
  const flow = createFlow({
    assembly: deps.assembly,
    events: deps.events,
    clock: { now: () => new Date(now) },
  });
  await moveAd(
    tx,
    { flow },
    actor.ctx,
    { id, entityId, storeId },
    "ad.submit",
    "09:801",
    {},
    {
      type: "ad.requested",
      payload: { v: 1, adId: id, entityId, storeId, adType: body.type, points: held.points },
    },
    {},
    undefined,
    true,
  );
  await armAdDue(tx, deps, { id, entityId, storeId }, "first", 0, due);
  return id;
}
