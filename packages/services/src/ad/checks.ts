import type { Tx } from "../kernel/index.js";
import { AppError, merchantFactsOf, lockRows } from "../kernel/index.js";
import { paramsAt } from "../config/index.js";
import { storeGate, assertProfileComplete, industryOpen } from "../profile/index.js";
import { assertWithinQuota } from "../tenant/index.js";
import { getEntitlements } from "../billing/index.js";
import {
  assertAssetReferences,
  readMaterialAssetFacts,
  readMaterialFileFacts,
} from "../media/index.js";
import type { AdActor, AdWriteDeps } from "./context.js";
export async function creationChecks(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdActor,
  input: { type: string; durationSec: number },
  at: Date,
) {
  const { entityId, storeId } = actor.membership;
  await assertProfileComplete(tx, storeId);
  const gate = await storeGate(tx, storeId);
  if (gate === "blocked")
    throw new AppError("STORE_NOT_QUALIFIED", { details: { storeId, reason: "not_submitted" } });
  if (!(await industryOpen(tx, storeId))) throw new AppError("INDUSTRY_NOT_OPEN");
  await assertWithinQuota(tx, { facts: merchantFactsOf(deps.assembly) }, at, entityId);
  const ent = await getEntitlements(tx, entityId, at);
  if (!ent.term || ent.subStatus !== "active") throw new AppError("SUBSCRIPTION_INACTIVE");
  if (ent.refundPending) throw new AppError("PLAN_REFUND_IN_PROGRESS");
  const p = await paramsAt(tx, ["content.placement.open_slots", "ad.duration_options"], at);
  if (!p["content.placement.open_slots"].some((type) => type === input.type))
    throw new AppError("VALIDATION_FAILED");
  const options = p["ad.duration_options"] as Record<string, number[]>;
  if (!options[input.type]?.includes(input.durationSec)) throw new AppError("VALIDATION_FAILED");
  return { gate, term: ent.term };
}
export async function currentAgreement(tx: Tx, deps: AdWriteDeps, versionId?: string) {
  const current = (await deps.docs.currentVersions(tx)).get("ad_service");
  if (!current || (versionId !== undefined && current.id !== versionId))
    throw new AppError("AGREEMENT_VERSION_STALE", {
      details: { agreementKey: "ad_service", currentAgreementVersionId: current?.id ?? null },
    });
  return current;
}
export async function referenceChecks(
  tx: Tx,
  actor: AdActor,
  assets: readonly string[],
  files: readonly string[],
  lock = false,
) {
  const scope = { entityId: actor.membership.entityId, storeId: actor.membership.storeId };
  await assertAssetReferences(tx, { ...scope, ids: assets });
  if (lock) {
    await lockRows(tx, "store_asset", [...assets]);
    const assetRows = await readMaterialAssetFacts(tx, { ...scope, ids: assets });
    await lockRows(tx, "file_object", [
      ...files,
      ...assetRows.flatMap((a) => a.storeAssetFiles.map((f) => f.fileId)),
    ]);
    await assertAssetReferences(tx, { ...scope, ids: assets });
  }
  const facts = await readMaterialFileFacts(tx, files);
  for (const id of files) {
    const f = facts.find((f) => f.id === id);
    if (
      !f ||
      f.entityId !== scope.entityId ||
      f.storeId !== scope.storeId ||
      f.scopeType !== "store" ||
      !["profile_image", "profile_video", "profile_promo"].includes(f.category) ||
      f.status !== "stored" ||
      f.moderationState === "block" ||
      f.deletedAt ||
      f.erasedAt
    )
      throw new AppError("FILE_NOT_USABLE", {
        details: { fileIds: [id], reason: "scope_mismatch" },
      });
  }
}
