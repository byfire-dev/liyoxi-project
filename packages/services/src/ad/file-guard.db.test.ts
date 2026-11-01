import { afterEach, beforeEach, expect, it } from "vitest";
import {
  createFactories,
  sampleStaffContext,
  snapshotTables,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import { createMedia, fileCategoryGuardPort } from "../media/index.js";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import { ok } from "../providers/types.js";
import { adFixture } from "./__fixtures__/lifecycle.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let active: Awaited<ReturnType<typeof adFixture>> | undefined;
beforeEach(() => db.reset(), 120_000);
afterEach(async () => {
  await active?.close();
  active = undefined;
});

it(
  "广告上传沿实例guard核本人/归属并写AI声明，真实complete/promote/probe后才ready",
  { timeout: 120_000 },
  async () => {
    const prisma = await db.prisma(),
      f = (active = await adFixture(prisma, {
        databaseUrl: await db.url(),
        redisUrl: process.env.REDIS_URL!,
        redisKeyPrefix: redis.prefix,
      })),
      r = f.runtime,
      actor = { identity: f.staffActor.ctx, staff: f.staffActor.staff },
      input = {
        category: "ad_video" as const,
        storeId: f.actor.membership.storeId,
        files: [{ fileName: "ad.mp4", sizeBytes: "1234", clientToken: uuidv7() }],
        production: { kind: "ad", adId: f.created.adId, aiUsage: { used: false, tools: [] } },
      };
    const before = await snapshotTables(prisma, ["file_object", "production_record", "media_job"]);
    for (const bad of [
      { ...input, production: undefined },
      { ...input, production: { ...input.production, kind: "sample" } },
      { ...input, production: { ...input.production, episodeNo: 1 } },
      { ...input, production: { ...input.production, adId: uuidv7() } },
      { ...input, storeId: uuidv7() },
      { ...input, entityId: uuidv7() },
    ])
      await expect(r.media.register(actor, bad)).rejects.toBeDefined();
    await expect(
      r.media.register({ identity: f.adminActor.ctx, staff: f.adminActor.staff }, input),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    const make = createFactories({ db: prisma, clock: f.clock }),
      otherEditor = await make.staff({ staffRoleKey: "editor" }),
      otherStaff = await sampleStaffContext(prisma, otherEditor.id, { stepUpAt: f.clock.now() });
    await expect(
      r.media.register(
        {
          identity: createIdentityContext({
            actor: { type: "staff", id: otherEditor.id, client: "admin" },
          }),
          staff: otherStaff,
        },
        input,
      ),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(
      r.media.register(
        { identity: f.actor.ctx, merchant: { ...f.actor.membership, standing: "owner" } },
        input,
      ),
    ).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
    const noGuard = createMedia({
      tx: r.tx,
      clock: f.clock,
      events: r.events,
      storage: f.providers.storage,
      assembly: {
        ...r.assembly,
        portEntries(port) {
          const entries = new Map(r.assembly.portEntries(port));
          if (port.name === fileCategoryGuardPort.name) entries.delete("ad_video");
          return entries;
        },
      },
    });
    await expect(noGuard.register(actor, input)).rejects.toMatchObject({
      error: "FILE_CATEGORY_NOT_ALLOWED",
    });
    expect(await snapshotTables(prisma, ["file_object", "production_record", "media_job"])).toEqual(
      before,
    );
    const registered = await r.media.register(actor, input),
      fileId = registered.items[0]!.fileId,
      pending = await prisma.fileObject.findUniqueOrThrow({ where: { id: fileId } });
    expect(pending).toMatchObject({
      status: "pending",
      uploadActorType: "staff",
      uploadActorId: f.editorId,
    });
    expect(await prisma.productionRecord.findUniqueOrThrow({ where: { fileId } })).toMatchObject({
      kind: "ad",
      adId: f.created.adId,
      uploadedByStaffId: f.editorId,
      pipelineState: "uploading",
      aiUsage: {
        used: false,
        declaredBy: f.editorId,
        declaredAt: f.clock.now().toISOString(),
        forcedByDrama: false,
      },
    });
    expect(await prisma.mediaJob.count({ where: { subjectId: fileId, kind: "probe" } })).toBe(0);
    await expect(
      r.tx.run((tx) =>
        r.media.prepareAdProduction(tx, {
          fileId,
          adId: f.created.adId,
          entityId: f.actor.membership.entityId,
          storeId: f.actor.membership.storeId,
          uploadedByStaffId: f.editorId,
        }),
      ),
    ).rejects.toMatchObject({ error: "FILE_NOT_USABLE", details: { reason: "not_stored" } });
    const bytes = new Uint8Array(1234);
    bytes.set([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
    f.providers.storage.put({ bucket: "media", key: pending.incomingKey! }, bytes, "video/mp4");
    await r.media.completeAdmin(actor, fileId);
    const promote = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${fileId}` },
    });
    await r.media.jobs.run({ jobId: promote.id });
    expect(await r.tx.run((tx) => r.media.adProductionFacts(tx, fileId))).toMatchObject({
      ready: false,
    });
    const probe = await prisma.mediaJob.findFirstOrThrow({
        where: { kind: "probe", subjectId: fileId },
      }),
      original = f.adCodec!.tool.probe;
    f.adCodec!.tool.probe = async (work) => {
      const result = await original(work);
      if (!result.ok) return result;
      return ok({
        ...result.value,
        format: { ...result.value.format, durationMs: 3000 },
        streams: result.value.streams.map((s) => ({
          ...s,
          durationMs: 3000,
          nbFrames: s.codecType === "video" ? 90 : s.nbFrames,
        })),
      });
    };
    try {
      await r.media.jobs.run({ jobId: probe.id });
    } finally {
      f.adCodec!.tool.probe = original;
    }
    expect(await r.tx.run((tx) => r.media.adProductionFacts(tx, fileId))).toMatchObject({
      ready: true,
      durationMs: 3000,
    });
    const ai = await r.media.register(actor, {
      ...input,
      files: [{ ...input.files[0]!, clientToken: uuidv7() }],
      production: {
        ...input.production,
        aiUsage: { used: true, tools: [{ name: "测试工具", version: "1", usedFor: "广告画面" }] },
      },
    });
    expect(
      await prisma.productionRecord.findUniqueOrThrow({ where: { fileId: ai.items[0]!.fileId } }),
    ).toMatchObject({
      aigcState: "pending",
      pipelineState: "uploading",
      aiUsage: { used: true, declaredBy: f.editorId },
    });
    const quote = await r.adCancelRequests.quote(f.adminActor, f.created.adId, {
      reasonCode: "merchant_request",
    });
    await r.adCancelRequests.create(f.adminActor, f.created.adId, {
      reasonCode: "merchant_request",
      note: "上传取消守卫",
      expect: quote.expect,
    });
    const cancelled = await snapshotTables(prisma, [
      "file_object",
      "production_record",
      "media_job",
    ]);
    await expect(
      r.media.register(actor, { ...input, files: [{ ...input.files[0]!, clientToken: uuidv7() }] }),
    ).rejects.toMatchObject({ error: "AD_CANCEL_IN_PROGRESS" });
    expect(await snapshotTables(prisma, ["file_object", "production_record", "media_job"])).toEqual(
      cancelled,
    );
  },
);
