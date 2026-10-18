import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { expect, vi } from "vitest";
import type { Redis } from "ioredis";
import type { PrismaClient, MediaJob, Prisma, FileObject } from "@liyoxi/db";
import { assertNotInTransaction, lockRows, uuidv7 } from "../../../kernel/index.js";
import { createMediaAssetsHarness } from "../../../testing/index.js";
import { ok } from "../../../providers/types.js";
import { createModelBudgetLedger } from "../../index.js";
import type { ModelBudgetAdmission, ModelBudgetContext } from "../../index.js";
import type { AssetDeps } from "../context.js";
import { advanceAsset, AssetJobInputSchema, AssetJobOutputSchema } from "../pipeline.js";
import { createAssetAsrStrategy } from "../asr.js";
import { createAssetDigestStrategy } from "../digest.js";
import { createAssetVisionStrategy } from "../vision.js";
import { saveTechnical } from "../../handlers/probe.js";
import { TechnicalSchema } from "../../production-report.js";

export const SLOW = 120_000;
export const signal = () => new AbortController().signal;
export const json = (value: unknown) => value as Prisma.InputJsonValue;
export const png = () =>
  Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(uuidv7())]);
export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
export const structuredOutput = (
  outcome: Awaited<ReturnType<ReturnType<typeof createAssetDigestStrategy>["execute"]>>,
) => {
  expect(outcome.state).toBe("succeeded");
  if (outcome.state !== "succeeded") throw new Error("缺少结构化结果");
  return AssetJobOutputSchema.parse(outcome.output);
};

/** 真实PG/任务/ledger；只替换云IO，seed仅合法历史、不代表生产初始化。 */
export async function modelWorld(prisma: PrismaClient, client: Redis, ownPrefix: string) {
  const caps = { dailyFileCap: 200, dailyCallCap: 10000 };
  const permits: ModelBudgetContext[] = [];
  const readPermit = vi.fn<ModelBudgetAdmission["readPermit"]>(async (_tx, facts) => {
    const permit = { ...facts, ...caps };
    permits.push(permit);
    return permit;
  });
  const reserve = vi.fn<ModelBudgetAdmission["reserve"]>(async (context, abort) => {
    assertNotInTransaction("真实预算Redis预留");
    return ledger.reserve(context, abort);
  });
  const budget = { readPermit, reserve };
  const h = await createMediaAssetsHarness(prisma, { modelBudget: budget });
  const frozenNow = h.clock.now,
    set = h.clock.set,
    advance = h.clock.advance;
  let elapsedFrom: number | null = null;
  // 真实 Redis TIME 消费窗口，SQL/调度耗时也必须反映在业务钟里。
  // 同一对象供 ledger、策略和 runtime 使用；显式拨钟仍冻结，refresh 才恢复走时。
  h.clock.now = () =>
    new Date(
      frozenNow().getTime() +
        (elapsedFrom === null ? 0 : Math.floor(performance.now() - elapsedFrom)),
    );
  h.clock.set = (at) => {
    set(at);
    elapsedFrom = null;
  };
  h.clock.advance = (ms) => {
    advance(ms);
    set(h.clock.now());
    elapsedFrom = null;
  };
  const head = h.fake.storage.head;
  vi.spyOn(h.fake.storage, "head").mockImplementation(async (input) => {
    const result = await head(input),
      bytes = h.fake.storage.objects.get(`${input.bucket}/${input.key}`)?.body;
    let crc = 0n;
    for (const byte of bytes ?? []) {
      crc ^= BigInt(byte) << 56n;
      for (let n = 0; n < 8; n++)
        crc =
          (crc & (1n << 63n) ? (crc << 1n) ^ 0x42f0e1eba9ea3693n : crc << 1n) & ((1n << 64n) - 1n);
    }
    return result.ok && result.value.exists && bytes
      ? ok({ ...result.value, crc64: crc.toString() })
      : result;
  });
  const prefix = `${ownPrefix}owner:${uuidv7()}:`,
    key = `${prefix}model_budget:v1`;
  const evalCall = vi.fn(
    async (script: string, keys: readonly string[], argv: readonly string[]) => {
      assertNotInTransaction("真实预算Lua");
      return client.eval(script, keys.length, ...keys, ...argv);
    },
  );
  const ledger = createModelBudgetLedger({ clock: h.clock, prefix, transport: { eval: evalCall } });
  async function refresh() {
    const [seconds, micros] = await client.time();
    h.clock.set(new Date(Number(seconds) * 1000 + Math.floor(Number(micros) / 1000)));
    elapsedFrom = performance.now();
  }
  await refresh();
  const at = h.clock.now().getTime();
  await client.hset(key, {
    marker: "model_budget_v1",
    business: String(at - 1),
    redis: String(at - 1),
    day: String(Math.floor((at + 28800000) / 86400000)),
    closed: "0",
    head: "1",
    next: "1",
    cursor: "1",
  });
  const signing = vi.spyOn(h.fake.storage, "presignVisionGet").mockImplementation(async () => {
    assertNotInTransaction("视觉签发");
    return ok({
      url: `https://public.invalid/${uuidv7()}.jpg`,
      expiresAt: new Date(h.clock.now().getTime() + 900000),
    });
  });
  const vision = vi.spyOn(h.fake.llm, "analyzeVision").mockImplementation(async () => {
    assertNotInTransaction("视觉模型");
    return ok({
      description: "公开虚构厨房",
      quality: "画面清晰",
      textInImage: "菜单",
      hasPeople: false,
      identifiableCustomerFace: false,
    });
  });
  const digest = vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async () => {
    assertNotInTransaction("摘要模型");
    return ok({
      title: "",
      keypoints: ["公开虚构菜品"],
      contentTags: [],
      suggestedUsage: [],
      faceHint: "none",
      qualityNotes: [],
    });
  });
  function deps(overrides: Partial<AssetDeps> = {}): AssetDeps {
    return {
      tx: h.tx,
      clock: h.clock,
      assembly: h.assembly,
      events: h.events,
      storage: h.fake.storage,
      moderation: h.fake.media,
      refTypes: new Map(),
      guards: new Map(),
      assets: { ...h.assets, modelBudget: budget },
      ...overrides,
    };
  }
  async function claim(job: MediaJob) {
    await refresh();
    return prisma.mediaJob.update({
      where: { id: job.id },
      data: {
        state: job.kind === "asr" && job.mode === "remote" ? "submitting" : "running",
        attemptNo: 1,
        leaseOwner: `budget:${uuidv7()}`,
        startedAt: h.clock.now(),
        nextRunAt: new Date(h.clock.now().getTime() + 120000),
      },
    });
  }
  const current = (kind: "asr" | "vision" | "digest") => {
    const handler = h.media.jobs.handlers.get(kind);
    if (!handler) throw new Error(`缺少真实处理器:${kind}`);
    return handler.current;
  };
  async function readyText(textBody = "公开虚构门店菜品") {
    const asset = await h.media.assets.create(h.owner, { type: "text", textBody });
    const audit = await prisma.mediaJob.findFirstOrThrow({
      where: { parentId: asset.storeAssetId, kind: "audit_text" },
    });
    await h.media.jobs.run({ jobId: audit.id });
    const job = await prisma.mediaJob.findFirstOrThrow({
      where: { parentId: asset.storeAssetId, kind: "digest" },
    });
    return { assetId: asset.storeAssetId, job: await claim(job), files: [] };
  }
  async function storedImage(body: Buffer) {
    const file = await h.stored(h.owner, "store_asset", new Uint8Array(body));
    const audit = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `audit_image:${file.id}:v1` },
    });
    expect(audit).toMatchObject({
      parentId: null,
      subjectType: "file_object",
      subjectId: file.id,
      kind: "audit_image",
    });
    await h.media.jobs.run({ jobId: audit.id });
    const finished = await prisma.mediaJob.findUniqueOrThrow({ where: { id: audit.id } });
    expect(finished.state).toBe("succeeded");
    expect(finished.output).toEqual({ verdict: "pass", labels: [] });
    const fresh = await prisma.fileObject.findUniqueOrThrow({ where: { id: file.id } });
    expect(fresh.moderationState).toBe("pass");
    return fresh;
  }
  async function readyImage(sameBody?: Uint8Array, claimNow = true) {
    const file = await storedImage(sameBody ? Buffer.from(sameBody) : png());
    const asset = await h.media.assets.create(h.owner, { type: "image", fileIds: [file.id] });
    const audit = await prisma.mediaJob.findFirstOrThrow({
      where: { parentId: asset.storeAssetId, kind: "audit_image_wx" },
    });
    await h.media.jobs.run({ jobId: audit.id });
    const job = await prisma.mediaJob.findFirstOrThrow({
      where: { parentId: asset.storeAssetId, kind: "vision" },
    });
    return { assetId: asset.storeAssetId, job: claimNow ? await claim(job) : job, files: [file] };
  }
  async function readyAudio(claimNow = true) {
    const bytes = Buffer.alloc(48);
    bytes.write("RIFF");
    bytes.writeUInt32LE(40, 4);
    bytes.write("WAVEfmt ", 8);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20);
    bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(8000, 24);
    bytes.writeUInt32LE(16000, 28);
    bytes.writeUInt16LE(2, 32);
    bytes.writeUInt16LE(16, 34);
    bytes.write("data", 36);
    bytes.writeUInt32LE(4, 40);
    bytes.writeUInt16LE(1, 44);
    bytes.writeUInt16LE(2, 46);
    const item = (
      await h.media.register(h.owner, {
        category: "store_asset",
        files: [{ fileName: "menu.wav", sizeBytes: "48", clientToken: uuidv7() }],
      })
    ).items[0]!;
    h.fake.storage.put({ bucket: "asset", key: item.key }, bytes, "audio/wav");
    await h.media.complete(h.owner, item.fileId);
    const promote = await prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${item.fileId}` },
    });
    await h.media.jobs.run({ jobId: promote.id });
    const file = await prisma.fileObject.findUniqueOrThrow({ where: { id: item.fileId } });
    const asset = await h.media.assets.create(h.owner, { type: "audio", fileIds: [file.id] });
    const probe = await prisma.mediaJob.findFirstOrThrow({
      where: { parentId: asset.storeAssetId, kind: "probe" },
    });
    await h.media.jobs.run({ jobId: probe.id });
    const job = await prisma.mediaJob.findFirstOrThrow({
      where: { parentId: asset.storeAssetId, kind: "asr" },
    });
    return { assetId: asset.storeAssetId, job: claimNow ? await claim(job) : job, files: [file] };
  }
  async function readyVideo() {
    const bytes = Buffer.from(`合法历史视频元数据${uuidv7()}`),
      key = `test/${uuidv7()}.mp4`;
    const etag = h.fake.storage.put({ bucket: "asset", key }, bytes, "video/mp4");
    const file = await h.make.fileObject({
      bucket: "asset",
      category: "store_asset",
      scopeType: "store",
      entityId: h.merchant.entity.id,
      storeId: h.merchant.store.id,
      uploadActorType: "merchant",
      uploadActorId: h.merchant.user.id,
      uploadClient: "weapp",
      objectKey: key,
      ext: "mp4",
      mime: "video/mp4",
      declaredMime: "video/mp4",
      declaredSize: BigInt(bytes.length),
      sizeBytes: BigInt(bytes.length),
      etag,
      crc64: "12345",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      moderationState: "pass",
    });
    const asset = await h.media.assets.create(h.owner, { type: "video", fileIds: [file.id] });
    const initial = await prisma.mediaJob.findFirstOrThrow({
      where: { parentId: asset.storeAssetId },
    });
    const base = AssetJobInputSchema.parse(initial.input);
    const technical = TechnicalSchema.parse({
      kind: "video",
      container: "mp4",
      durationMs: 60000,
      width: 1920,
      height: 1080,
      rotation: 0,
      displayWidth: 1920,
      displayHeight: 1080,
      fpsNum: 25,
      fpsDen: 1,
      vcodec: "h264",
      vprofile: "High",
      pixFmt: "yuv420p",
      bitDepth: 8,
      acodec: "aac",
      audioSampleRate: 48000,
      audioChannels: 2,
      audioStreamCount: 1,
      bitrateKbps: 1000,
      isFaststart: true,
      avDriftMs: 0,
      sizeBytes: bytes.length,
      aigcMeta: null,
      invalidAigc: false,
      vfr: false,
      raw: {
        demuxer: "mov",
        formatName: "mov,mp4",
        majorBrand: "isom",
        boxes: ["ftyp", "moov", "mdat"],
      },
    });
    // 明示合法历史前驱，不冒称真实视频像素、云审核或原生probe执行。
    for (const kind of ["probe", "audit_video", "asr"] as const) {
      const content =
        kind === "asr"
          ? {
              text: "虚构语音",
              durationSec: 1,
              segments: [{ text: "虚构语音", fromMs: 0, toMs: 1000 }],
            }
          : {};
      const dedupeKey = `asset:${asset.storeAssetId}:${base.runId}:${kind}:${file.id}:v${base.promptVersion}`;
      const old = await prisma.mediaJob.findUnique({ where: { dedupeKey } });
      const data = {
        kind,
        provider: kind === "probe" ? "mediatool" : "fake",
        mode: kind === "probe" ? "local" : "remote",
        parentType: "store_asset",
        parentId: asset.storeAssetId,
        subjectType: "file_object",
        subjectId: file.id,
        input: json({
          ...base,
          fileId: file.id,
          etag,
          crc64: file.crc64,
          sizeBytes: file.sizeBytes!.toString(),
        }),
        output: json({
          status: "ok",
          reason: null,
          content,
          verdict: kind === "audit_video" ? "pass" : null,
          ...(kind === "probe"
            ? { probe: { technical, cover: null, sourceSha256: file.sha256! } }
            : {}),
        }),
        state: "succeeded",
        attemptNo: 1,
        leaseOwner: null,
        finishedAt: h.clock.now(),
        updatedAt: h.clock.now(),
      };
      const origin = old
        ? await prisma.mediaJob.update({ where: { id: old.id }, data })
        : await prisma.mediaJob.create({
            data: {
              ...data,
              id: uuidv7(),
              dedupeKey,
              maxAttempts: 3,
              nextRunAt: h.clock.now(),
              deadlineAt: new Date(h.clock.now().getTime() + 900000),
              createdAt: h.clock.now(),
            },
          });
      if (kind !== "audit_video")
        await prisma.storeAssetInsight.create({
          data: {
            id: uuidv7(),
            storeAssetId: asset.storeAssetId,
            fileId: file.id,
            kind: kind === "probe" ? "tech_spec" : "transcript",
            promptVersion: base.promptVersion,
            provider: origin.provider,
            mediaJobId: origin.id,
            status: "ok",
            content: json(content),
            createdAt: h.clock.now(),
            updatedAt: h.clock.now(),
          },
        });
      if (kind === "probe")
        // 技术事实与其来源 probe 共用完成时刻，不依赖异步写入之间的冻结钟。
        await h.tx.run((tx) => saveTechnical(tx, file.id, technical, null, data.finishedAt));
    }
    await h.tx.run(async (tx) => {
      await lockRows(tx, "store_asset", [asset.storeAssetId]);
      await advanceAsset(tx, deps(), asset.storeAssetId);
    });
    const job = await prisma.mediaJob.findFirstOrThrow({
      where: { parentId: asset.storeAssetId, kind: "vision" },
    });
    return { assetId: asset.storeAssetId, job: await claim(job), files: [file] };
  }
  /** 已成功历史洞察有真实run/任务/指纹，不宣称执行过对应云producer。 */
  async function readyDigestSources(
    note: string,
    bodies = ["公开虚构画面"],
    auditedFiles?: readonly FileObject[],
  ) {
    // 同一测试世界的已真实根审核文件可复用；新素材及其来源图仍走下面完整流程。
    const files = auditedFiles ? [...auditedFiles] : [];
    if (!auditedFiles) for (const _body of bodies) files.push(await storedImage(png()));
    expect(files).toHaveLength(bodies.length);
    expect(new Set(files.map((file) => file.id)).size).toBe(files.length);
    const asset = await h.media.assets.create(h.owner, {
      type: "image",
      fileIds: files.map((f) => f.id),
      note,
    });
    const first = await prisma.mediaJob.findFirstOrThrow({
      where: { parentId: asset.storeAssetId },
    });
    const base = AssetJobInputSchema.parse(first.input);
    const sources = [];
    for (const [index, file] of files.entries()) {
      const content = { description: bodies[index]!, tags: [] };
      const input = {
        ...base,
        fileId: file.id,
        etag: file.etag,
        crc64: file.crc64,
        sizeBytes: file.sizeBytes!.toString(),
      };
      const origin = await prisma.mediaJob.create({
        data: {
          id: uuidv7(),
          kind: "vision",
          provider: "fake",
          mode: "local",
          parentType: "store_asset",
          parentId: asset.storeAssetId,
          subjectType: "file_object",
          subjectId: file.id,
          dedupeKey: `asset:${asset.storeAssetId}:${base.runId}:vision:${file.id}:v${base.promptVersion}`,
          input: json(input),
          output: json({ status: "ok", reason: null, content, verdict: null }),
          state: "succeeded",
          attemptNo: 1,
          maxAttempts: 3,
          finishedAt: h.clock.now(),
          nextRunAt: h.clock.now(),
          deadlineAt: new Date(h.clock.now().getTime() + 900000),
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
      const insight = await prisma.storeAssetInsight.create({
        data: {
          id: uuidv7(),
          storeAssetId: asset.storeAssetId,
          fileId: file.id,
          kind: "vision",
          provider: "fake",
          promptVersion: base.promptVersion,
          mediaJobId: origin.id,
          status: "ok",
          content: json(content),
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
      sources.push({ origin, insight });
    }
    const audits = await prisma.mediaJob.findMany({
      where: { parentId: asset.storeAssetId, kind: "audit_image_wx" },
    });
    for (const audit of audits) await h.media.jobs.run({ jobId: audit.id });
    await h.tx.run(async (tx) => {
      await lockRows(tx, "store_asset", [asset.storeAssetId]);
      await advanceAsset(tx, deps(), asset.storeAssetId);
    });
    const job = await prisma.mediaJob.findFirstOrThrow({
      where: { parentId: asset.storeAssetId, kind: "digest" },
    });
    return { assetId: asset.storeAssetId, job: await claim(job), files, sources };
  }
  return {
    ...h,
    budget,
    caps,
    permits,
    ledger,
    key,
    client,
    refresh,
    deps,
    claim,
    current,
    readyText,
    readyImage,
    readyAudio,
    readyVideo,
    readyDigestSources,
    signing,
    vision,
    digest,
    evalCall,
    snapshot: () => client.hgetall(key),
    digestStrategy: (d = deps()) => createAssetDigestStrategy(d, current("digest")),
    visionStrategy: (d = deps()) => createAssetVisionStrategy(d, current("vision")),
    asrStrategy: (d = deps()) => createAssetAsrStrategy(d, current("asr")),
    sourceHash: (text: string) => createHash("sha256").update(text).digest("hex"),
  };
}
export type ModelWorld = Awaited<ReturnType<typeof modelWorld>>;
