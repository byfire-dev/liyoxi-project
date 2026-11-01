import { afterEach, expect, it } from "vitest";
import {
  createFactories,
  createW508OrderAdFixture,
  prepareAdminAdVideoForTest,
  sampleStaffContext,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { createIdentityContext } from "../kernel/index.js";
const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let f: Awaited<ReturnType<typeof createW508OrderAdFixture>> | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

it(
  "真实后台版本登记/派生来源与未推替换、发送证据与渠道快照、免费代提同TX回退浮动活样片并保已确认决定",
  { timeout: 120_000 },
  async () => {
    const p = await db.prisma();
    f = await createW508OrderAdFixture(p, {
      databaseUrl: await db.url(),
      redisUrl: process.env.REDIS_URL!,
      redisKeyPrefix: redis.prefix,
    });
    const h = f,
      r = h.runtime,
      created = await h.createAd();
    await r.adminAds.assign(h.admin, created.adId, { staffId: h.editor.staff.staff.id });
    const firstFile = await prepareAdminAdVideoForTest(h, p, created.adId, h.editor);
    const first = await r.adminAds.registerVersion(h.editor, created.adId, {
      fileId: firstFile.fileId,
      segments: [{ index: 0, fromMs: 0, toMs: firstFile.durationMs, label: "整条" }],
    });
    expect(first.versions[0]?.preview).not.toBeNull();
    expect((await r.ads.get(h.actor, created.adId)).versions).toHaveLength(0);
    const other = await createFactories({ db: p, clock: h.clock }).staff({
      staffRoleKey: "editor",
    });
    const otherActor = {
      ctx: createIdentityContext({ actor: { type: "staff", id: other.id, client: "admin" } }),
      staff: await sampleStaffContext(p, other.id, { stepUpAt: h.clock.now() }),
    };
    await r.staffManagement.handover(h.admin.staff, h.admin.ctx, h.editor.staff.staff.id, {
      handoverToStaffId: other.id,
      reason: "reassigned",
    });
    expect((await p.ad.findUniqueOrThrow({ where: { id: created.adId } })).editorId).toBe(other.id);
    await expect(
      r.adminAds.registerVersion(otherActor, created.adId, { fileId: firstFile.fileId }),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE", details: { reason: "context_mismatch" } });
    expect(await p.adVersion.count({ where: { adId: created.adId } })).toBe(1);
    await r.staffManagement.handover(h.admin.staff, h.admin.ctx, other.id, {
      handoverToStaffId: h.editor.staff.staff.id,
      reason: "reassigned",
    });
    const normalized = await r.media.productionActions.normalize(
      { identity: h.admin.ctx, staff: h.admin.staff },
      firstFile.fileId,
      {},
    );
    await r.media.jobs.run({ jobId: normalized.mediaJobId });
    h.clock.advance(5000);
    await r.media.jobs.run({ jobId: normalized.mediaJobId });
    const codec = h.adCodec;
    if (!codec) throw new Error("真实广告生产工具未安装");
    const original = codec.tool.probe;
    codec.tool.probe = async (input) => {
      const result = await original(input);
      if (!result.ok) return result;
      const durationMs = firstFile.durationMs;
      return {
        ...result,
        value: {
          ...result.value,
          format: { ...result.value.format, durationMs },
          streams: result.value.streams.map((stream) => ({
            ...stream,
            durationMs,
            nbFrames: stream.codecType === "video" ? (durationMs * 30) / 1000 : stream.nbFrames,
          })),
        },
      };
    };
    try {
      const jobId = await r.tx.run((tx) => r.media.enqueueProbe(tx, normalized.productionRecordId));
      await r.media.jobs.run({ jobId });
    } finally {
      codec.tool.probe = original;
    }
    const proof = await r.tx.run((tx) =>
      r.media.adProductionFacts(tx, normalized.productionRecordId),
    );
    expect(proof).toMatchObject({
      ready: true,
      uploadedByStaffId: h.editor.staff.staff.id,
      production: { source: "normalized", uploadedByStaffId: null },
    });
    expect(
      (await p.fileObject.findUniqueOrThrow({ where: { id: normalized.productionRecordId } }))
        .uploadActorType,
    ).toBe("system");
    const next = await r.adminAds.registerVersion(h.editor, created.adId, {
      fileId: normalized.productionRecordId,
    });
    expect(next.versions.find((row) => row.versionNo === 1)?.decision).toBe("superseded");
    const version = next.versions[0]!;
    await expect(
      r.adminAds.push(h.editor, version.adVersionId, { includeWecom: true }),
    ).rejects.toMatchObject({ error: "PREVIEW_OFFLINE_NOT_SENT" });
    const marked = await r.adminAds.markSent(h.admin, version.adVersionId, {});
    const again = await r.adminAds.markSent(h.admin, version.adVersionId, {});
    expect(again.offlineSentAt).toBe(marked.offlineSentAt);
    expect(again.offlineSentBy?.staffId).toBe(h.admin.staff.staff.id);
    const pushed = await r.adminAds.push(h.editor, version.adVersionId, { includeWecom: true });
    expect(pushed.versions[0]?.previewChannels).toEqual(["album", "portal", "wecom"]);
    await h.confirmAd(created.adId, version.versionNo);
    const floating = await h.createBoundOrder(created.adId),
      sample = await h.pushSample(floating);
    const changed = await r.adminAds.requestChange(h.admin, created.adId, {
      versionNo: version.versionNo,
      segmentIndex: undefined,
      timeStartMs: 0,
      timeEndMs: 1000,
      note: "电话代录修改",
    });
    expect(changed.status).toBe("revising");
    expect(changed.revisions[0]).toMatchObject({
      source: "staff_on_behalf",
      actorType: "staff",
      chargePoints: 0,
      timeStartMs: 0,
      timeEndMs: 1000,
    });
    expect(
      (await p.deliveryTicket.findUniqueOrThrow({ where: { id: floating.ticketId } })).step,
    ).toBe("ad_prep");
    expect((await p.sample.findUniqueOrThrow({ where: { id: sample.sampleId } })).status).toBe(
      "superseded",
    );
    expect(await p.adRevision.count({ where: { adId: created.adId, isChargeable: true } })).toBe(0);
    await expect(
      r.adminAds.requestChange(h.admin, created.adId, {
        versionNo: version.versionNo,
        note: "不能叠加轮次",
      }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(
      (await p.adVersion.findUniqueOrThrow({ where: { id: version.adVersionId } })).decision,
    ).toBe("confirmed");
  },
);
