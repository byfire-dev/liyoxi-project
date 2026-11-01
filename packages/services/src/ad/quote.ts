import { AdQuoteSchema } from "@liyoxi/contract";
import type { AdQuoteBody } from "@liyoxi/contract";
import {
  getEntitlements,
  getWalletView,
  paramsAt as billingParams,
  quoteHold,
} from "../billing/index.js";
import { paramsAt } from "../config/index.js";
import { storeGate } from "../profile/index.js";
import { readAdAgreementFacts } from "../docs/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { AdActor, AdWriteDeps } from "./context.js";
import { member } from "./lifecycle.js";
import { creationChecks, currentAgreement } from "./checks.js";
export async function quoteAd(tx: Tx, deps: AdWriteDeps, actor: AdActor, body: AdQuoteBody) {
  await member(tx, actor);
  const at = deps.clock.now(),
    { entityId, storeId } = actor.membership;
  const ent = await getEntitlements(tx, entityId, at),
    wallet = await getWalletView(tx, entityId, at),
    billing = await billingParams(tx, at);
  const p = await paramsAt(tx, ["content.placement.open_slots", "ad.duration_options"], at),
    durations = p["ad.duration_options"];
  const typeOptions = (["opening", "ending"] as const)
    .filter((type) => p["content.placement.open_slots"].includes(type) && durations[type]?.length)
    .map((type) => ({ type, durationOptions: durations[type] }));
  const blockers: { code: string; message: string }[] = [];
  const type = body.type ?? typeOptions[0]?.type,
    durationSec =
      body.durationSec ?? typeOptions.find((o) => o.type === type)?.durationOptions?.[0];
  try {
    if (!type || !durationSec) throw new AppError("VALIDATION_FAILED");
    await creationChecks(tx, deps, actor, { type, durationSec }, at);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    blockers.push({ code: error.error, message: error.message });
  }
  const pricing =
    ent.term && ent.subStatus === "active"
      ? await quoteHold(tx, { ...ent.term, id: ent.term.termId }, { kind: "ad" }, at)
      : null;
  const chargePoints = pricing?.S ?? null,
    availablePoints = wallet.points.spendablePoints;
  if (chargePoints !== null && chargePoints > availablePoints)
    blockers.push({
      code: "POINTS_INSUFFICIENT",
      message: new AppError("POINTS_INSUFFICIENT").message,
    });
  const current = await currentAgreement(tx, deps),
    agreement = await readAdAgreementFacts(tx, {
      merchantUserId: actor.ctx.actor.id!,
      entityId,
      agreementVersionId: current.id,
    });
  return AdQuoteSchema.parse({
    unitPoints: billing.adUnitPoints,
    discountBp: pricing?.discountBp ?? null,
    chargePoints,
    freeRevisions: billing.adFreeRevisions,
    planName:
      ent.term && ent.subStatus === "active" ? (wallet.subscription.plan?.name ?? null) : null,
    availablePoints,
    availableAfterPoints: chargePoints === null ? null : availablePoints - chargePoints,
    typeOptions,
    storeGate: await storeGate(tx, storeId),
    blockers,
    agreement: {
      agreementKey: "ad_service",
      name: agreement.name,
      agreementVersionId: current.id,
      versionLabel: `v${current.major}.${current.minor}`,
      needsCheck: !agreement.hasPriorConsent,
    },
    quotedAt: at.toISOString(),
  });
}
