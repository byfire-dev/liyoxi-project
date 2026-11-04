import type { PrismaClient } from "@liyoxi/db";
import type { AdActor, AdStaffActor } from "../../ad/index.js";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import type { Clock } from "../../kernel/index.js";
import type { Runtime } from "../../runtime.js";
import { sampleStaffContext } from "../approval.js";
import type { Factories } from "../data/factories/index.js";
import type { FakeStorage } from "../providers/index.js";
import type { loadM5AdMedia } from "../m5-media.js";
import type { createPortalPreviewMedia } from "./preview-media.js";

export async function preparePortalPreviewAd(input: {
  db: PrismaClient;
  runtime: Runtime;
  clock: Clock;
  make: Factories;
  actor: AdActor;
  storage: FakeStorage;
  media: Awaited<ReturnType<typeof loadM5AdMedia>>;
  transport: ReturnType<typeof createPortalPreviewMedia>;
}) {
  const { db, runtime: r, clock, make, actor } = input;
  const staff = await make.staff({ staffRoleKey: "super_admin" });
  const editor = await make.staff({ staffRoleKey: "editor" });
  const staffActor = async (id: string): Promise<AdStaffActor> => ({
    ctx: createIdentityContext({ actor: { type: "staff", id, client: "admin" } }),
    staff: await sampleStaffContext(db, id, { stepUpAt: clock.now() }),
  });
  const admin = await staffActor(staff.id),
    editorActor = await staffActor(editor.id);
  if (!(await r.tx.run((tx) => r.docs.currentVersions(tx))).has("ad_service"))
    await make.agreementVersion({ agreementKey: "ad_service", createdByStaffId: staff.id });
  const promo = await db.dictItem.findFirstOrThrow({
    where: { dictTypeKey: "ad_promo_point", isEnabled: true },
  });
  const quote = await r.ads.quote(actor, { type: "opening", durationSec: 3 });
  if (quote.chargePoints === null) throw new Error("PREVIEW_AD_QUOTE_UNAVAILABLE");
  const { adId } = await r.ads.create(actor, {
    type: "opening",
    durationSec: 3,
    promoPointCodes: [promo.code],
    expectChargePoints: quote.chargePoints,
    agreementVersionId: quote.agreement.agreementVersionId,
    isAgreementChecked: true,
  });
  await r.tx.run((tx) => r.ads.production.assignTx(tx, admin, adId, editor.id));
  const channel = async (available: boolean) => {
    const flag = (await r.configAdmin.flags()).items.find(
      (item) => item.flagKey === "weapp.video.ad.enabled",
    );
    if (!flag) throw new Error("PREVIEW_AD_FLAG_MISSING");
    await r.configAdmin.updateFlag({ identity: admin.ctx, staff: admin.staff }, flag.flagKey, {
      lockVersion: flag.lockVersion,
      defaultValue: !available,
    });
  };
  // Push through the real weapp channel, then exercise its documented Portal fallback.
  // An explicit portal channel would remain allowed when the live flag changes.
  await channel(false);
  let versionNo = 0;
  const push = async () => {
    if (versionNo >= 2) throw new Error("PREVIEW_AD_VERSION_LIMIT");
    if (versionNo)
      await r.ads.requestChange(actor, adId, {
        versionNo,
        note: "电脑预览验收新版",
        screenshotFileIds: [],
      });
    await channel(false);
    const id = uuidv7(),
      key = `incoming/${id}/portal-ad.mp4`,
      bytes = input.media.video.bytes;
    await make.fileObject({
      id,
      category: "ad_video",
      bucket: "media",
      scopeType: "store",
      entityId: actor.membership.entityId,
      storeId: actor.membership.storeId,
      uploadActorType: "staff",
      uploadActorId: editor.id,
      uploadClient: "admin",
      status: "pending",
      uploadMode: "post",
      incomingBucket: "media",
      incomingKey: key,
      declaredSize: bytes.length,
      declaredMime: "video/mp4",
      ext: "mp4",
      originalName: "portal-ad.mp4",
      sizeBytes: null,
      mime: null,
      etag: null,
      sha256: null,
      storedAt: null,
      uploadExpiresAt: new Date(clock.now().getTime() + 600_000),
    });
    input.storage.put({ bucket: "media", key }, bytes, "video/mp4");
    await r.media.completeAdmin({ identity: editorActor.ctx, staff: editorActor.staff }, id);
    const promote = await db.mediaJob.findUniqueOrThrow({ where: { dedupeKey: `promote:${id}` } });
    await r.media.jobs.run({ jobId: promote.id });
    await r.tx.run((tx) =>
      r.media.prepareAdProduction(tx, {
        fileId: id,
        adId,
        entityId: actor.membership.entityId,
        storeId: actor.membership.storeId,
        uploadedByStaffId: editor.id,
        aiUsage: { used: false, tools: [] },
      }),
    );
    const probe = await r.tx.run((tx) => r.media.enqueueProbe(tx, id));
    await r.media.jobs.run({ jobId: probe });
    const facts = await r.tx.run((tx) => r.media.adProductionFacts(tx, id));
    if (!facts.ready) throw new Error("PREVIEW_AD_MEDIA_NOT_READY");
    const version = await r.tx.run((tx) =>
      r.ads.production.registerVersionTx(tx, editorActor, adId, {
        fileId: id,
        durationMs: 3000,
        width: 1080,
        height: 1920,
        segments: [],
      }),
    );
    await r.tx.run((tx) => r.ads.production.pushVersionTx(tx, editorActor, version.adVersionId));
    const file = await db.fileObject.findUniqueOrThrow({ where: { id } });
    if (
      file.entityId !== actor.membership.entityId ||
      file.storeId !== actor.membership.storeId ||
      file.status !== "stored" ||
      !file.objectKey
    )
      throw new Error("PREVIEW_AD_MEDIA_SCOPE");
    if (file.bucket !== "media") throw new Error("PREVIEW_AD_MEDIA_SCOPE");
    input.transport.own({ bucket: file.bucket, key: file.objectKey });
    const info = await db.mediaInfo.findUniqueOrThrow({ where: { fileId: id } });
    if (info.coverFileId) {
      const cover = await db.fileObject.findUniqueOrThrow({ where: { id: info.coverFileId } });
      if (
        cover.entityId !== actor.membership.entityId ||
        cover.storeId !== actor.membership.storeId ||
        cover.status !== "stored" ||
        cover.bucket !== "asset" ||
        cover.objectKey !== `covers/${info.coverFileId}.jpg`
      )
        throw new Error("PREVIEW_AD_MEDIA_SCOPE");
      input.transport.own({ bucket: cover.bucket, key: cover.objectKey });
    }
    versionNo = version.versionNo;
    await channel(true);
  };
  await push();
  return { push, channel, facts: () => ({ adId, versionNo }) };
}
