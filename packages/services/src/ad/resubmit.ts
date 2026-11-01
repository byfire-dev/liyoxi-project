import type { AdSubmitBody } from "@liyoxi/contract";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { linkAdAssetReferences, readAdReferenceFacts } from "../media/index.js";
import { lockCalendarImport } from "../sla/index.js";
import type { AdActor, AdWriteDeps } from "./context.js";
import { adDue, armAdDue, member, merchantAd, moveAd, noCancel } from "./lifecycle.js";
import { referenceChecks } from "./checks.js";
export async function resubmitAdTx(
  tx: Tx,
  deps: AdWriteDeps,
  actor: AdActor,
  adId: string,
  body: AdSubmitBody,
) {
  await lockCalendarImport(tx);
  await lockRows(tx, "entity", [actor.membership.entityId]);
  await member(tx, actor, true);
  await lockRows(tx, "store", [actor.membership.storeId]);
  await lockRows(tx, "ad", [adId]);
  const ad = await merchantAd(tx, actor, adId);
  noCancel(ad);
  if (ad.status !== "returned" || !["pending_assign", "producing"].includes(ad.returnedFrom ?? ""))
    throw new AppError("STATE_NOT_ALLOWED");
  const old = await readAdReferenceFacts(tx, { entityId: ad.entityId, storeId: ad.storeId, adId });
  const assets = [
      ...new Set([...old.assets.map((a) => a.id), ...(body.addReferenceStoreAssetIds ?? [])]),
    ],
    files = [...new Set([...old.profileFileIds, ...(body.addReferenceFileIds ?? [])])];
  if (assets.length > 9 || files.length > 9) throw new AppError("VALIDATION_FAILED");
  await referenceChecks(
    tx,
    actor,
    body.addReferenceStoreAssetIds ?? [],
    body.addReferenceFileIds ?? [],
    true,
  );
  const now = deps.clock.now(),
    due = await adDue(tx, deps, "first_version", now),
    round = ad.resubmitCount + 1;
  await tx.ad.update({
    where: { id: adId },
    data: {
      ...(body.copy !== undefined ? { copy: body.copy } : {}),
      ...(body.remark !== undefined ? { remark: body.remark } : {}),
    },
  });
  await linkAdAssetReferences(
    tx,
    {
      entityId: ad.entityId,
      storeId: ad.storeId,
      adId,
      ids: body.addReferenceStoreAssetIds ?? [],
      now,
    },
    deps.media.link,
  );
  for (const fileId of body.addReferenceFileIds ?? [])
    await deps.media.link(tx, {
      fileId,
      entityId: ad.entityId,
      storeId: ad.storeId,
      refType: "ad",
      refId: ad.id,
      role: "reference",
    });
  await deps.timers.cancel(tx, {
    subject: { type: "ad", id: ad.id },
    kinds: ["ad.returned_stale", "sla.breach"],
  });
  await moveAd(
    tx,
    deps,
    actor.ctx,
    ad,
    "ad.resubmit",
    "09:804",
    {
      resubmit_count: round,
      first_due_at: due.dueAt,
      due_at: due.dueAt,
      sla_snapshot: due.snapshot,
    },
    { type: "ad.resubmitted", payload: { v: 1, adId, resubmitCount: round } },
    {},
    ad.returnedFrom!,
  );
  await armAdDue(tx, deps, ad, "first", round, due);
  return adId;
}
