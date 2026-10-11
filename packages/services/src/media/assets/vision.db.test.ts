import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import type { FileObject, MediaJob, Prisma } from "@liyoxi/db";
import {
  assertNotInTransaction,
  createIdentityContext,
  lockRows,
  uuidv7,
} from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";
import { standingOf } from "../../authz/index.js";
import {
  connectTestDatabase,
  createMediaAssetsHarness,
  useSeededDatabase,
} from "../../testing/index.js";
import { failed, ok } from "../../providers/types.js";
import type { LlmDigest, LlmProvider, LlmVision, StorageProvider } from "../../providers/types.js";
import { createMediaJobs } from "../index.js";
import type { MediaActor } from "../index.js";
import type { JobOutcome } from "../jobs/types.js";
import { saveTechnical } from "../handlers/probe.js";
import { TechnicalSchema } from "../production-report.js";
import type { AssetDeps } from "./context.js";
import {
  advanceAsset,
  AssetJobInputSchema,
  AssetJobOutputSchema,
  assetJobOwned,
} from "./pipeline.js";
import { createAssetVisionStrategy, visionContent, visionFrameTimes } from "./vision.js";
import { createAssetDigestStrategy } from "./digest.js";

// 真实DB/父/任务/文件锁和公开任务入口；URL与模型事实是本叶明确的协议替身。
// 合法历史probe行不冒称原生媒体、真实像素/帧PTS或云侧验真。
const database = useSeededDatabase("services");
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
const NOW = new Date("2026-10-10T04:00:00.000Z");
const json = (v: unknown) => v as Prisma.InputJsonValue;
const visible = (overrides: Partial<LlmVision> = {}): LlmVision => ({
  description: "公开虚构开放式厨房",
  quality: "公开虚构清晰画面",
  hasPeople: true,
  identifiableCustomerFace: false,
  textInImage: "公开虚构菜单",
  ...overrides,
});
const summary = (): LlmDigest => ({
  title: "",
  keypoints: ["公开虚构视觉要点"],
  contentTags: [],
  suggestedUsage: [],
  faceHint: "none",
  qualityNotes: [],
});
let signing: MockInstance<StorageProvider["presignVisionGet"]>;
let model: MockInstance<LlmProvider["analyzeVision"]>;
beforeAll(async () => {
  h = await createMediaAssetsHarness(await database.prisma());
}, 120_000);
beforeEach(() => {
  h.clock.set(NOW);
  h.permitControlledModel(true);
  h.fake.llm.resetCalls();
  h.fake.llm.visionReplies.length = 0;
  h.fake.llm.digestReplies.length = 0;
  signing = vi.spyOn(h.fake.storage, "presignVisionGet").mockImplementation(async () => {
    assertNotInTransaction("local typed vision signing");
    return ok({
      url: `https://public.invalid/vision/${uuidv7()}.jpg`,
      expiresAt: new Date(h.clock.now().getTime() + 900_000),
    });
  });
  model = vi.spyOn(h.fake.llm, "analyzeVision").mockImplementation(async (input) => {
    assertNotInTransaction("local vision model IO");
    expect(input.signal).toBeInstanceOf(AbortSignal);
    return ok(visible());
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  h.clock.set(NOW);
});
afterAll(async () => h?.close());
const jobRow = (id: string) => h.prisma.mediaJob.findUniqueOrThrow({ where: { id } });
const assetRow = (id: string) => h.prisma.storeAsset.findUniqueOrThrow({ where: { id } });
const visions = (id: string) =>
  h.prisma.storeAssetInsight.findMany({
    where: { storeAssetId: id, kind: "vision" },
    orderBy: { id: "asc" },
  });
const allInsights = (id: string) =>
  h.prisma.storeAssetInsight.findMany({
    where: { storeAssetId: id },
    orderBy: { id: "asc" },
  });
const outbox = (id: string) =>
  h.prisma.outboxEvent.findMany({
    where: { aggregateId: id },
    orderBy: { id: "asc" },
  });
const tags = (id: string) =>
  h.prisma.storeAssetTag.findMany({
    where: { storeAssetId: id },
    orderBy: { id: "asc" },
  });
const handler = () => h.media.jobs.handlers.get("vision")!;
function dependencies(overrides: Partial<AssetDeps["assets"]> = {}): AssetDeps {
  return {
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    events: h.events,
    storage: h.fake.storage,
    moderation: h.fake.media,
    refTypes: new Map(),
    guards: new Map(),
    assets: { ...h.assets, allowModelCall: async () => true, ...overrides },
  };
}
const strategy = (overrides: Partial<AssetDeps["assets"]> = {}) =>
  createAssetVisionStrategy(dependencies(overrides), handler().current);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
type Merchant = typeof h.merchant;
function owner(merchant: Merchant): MediaActor {
  return {
    identity: createIdentityContext({
      actor: { type: "merchant", id: merchant.user.id, client: "weapp", role: "owner" },
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
    }),
    merchant: {
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      standing: standingOf("owner", "active"),
    },
  };
}
type Facts = { assetId: string; jobs: MediaJob[]; files: FileObject[]; actor: MediaActor };
const storedBodies = new Map<string, Buffer>();
function crc64(bytes: Uint8Array) {
  let crc = 0n;
  const mask = (1n << 64n) - 1n;
  for (const byte of bytes) {
    crc ^= BigInt(byte) << 56n;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc & (1n << 63n) ? (crc << 1n) ^ 0x42f0e1eba9ea3693n : crc << 1n) & mask;
  }
  return crc.toString();
}
async function stored(type: "image" | "video", merchant: Merchant, same?: FileObject) {
  const body = same ? storedBodies.get(same.id) : Buffer.from(`public synthetic ${uuidv7()}`),
    key = `test/${uuidv7()}.${type === "image" ? "png" : "mp4"}`;
  if (!body) throw new Error("缺少同字节缓存来源夹具");
  const etag = h.fake.storage.put(
    { bucket: "asset", key },
    body,
    type === "image" ? "image/png" : "video/mp4",
  );
  const file = await h.make.fileObject({
    bucket: "asset",
    category: "store_asset",
    scopeType: "store",
    entityId: merchant.entity.id,
    storeId: merchant.store.id,
    uploadActorType: "merchant",
    uploadActorId: merchant.user.id,
    uploadClient: "weapp",
    objectKey: key,
    ext: type === "image" ? "png" : "mp4",
    mime: type === "image" ? "image/png" : "video/mp4",
    declaredMime: type === "image" ? "image/png" : "video/mp4",
    declaredSize: BigInt(body.length),
    sizeBytes: BigInt(body.length),
    etag,
    crc64: crc64(body),
    sha256: createHash("sha256").update(body).digest("hex"),
    moderationState: "pass",
  });
  storedBodies.set(file.id, Buffer.from(body));
  if (same)
    expect([file.crc64, file.sha256, file.sizeBytes, etag]).toEqual([
      same.crc64,
      same.sha256,
      same.sizeBytes,
      same.etag,
    ]);
  return file;
}
function technical(file: FileObject, durationMs: number | null) {
  return TechnicalSchema.parse({
    kind: "video",
    container: "mp4",
    durationMs,
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
    sizeBytes: Number(file.sizeBytes),
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
}
async function ready(
  type: "image" | "video" = "image",
  options: {
    count?: number;
    duration?: number | null;
    merchant?: Merchant;
    same?: FileObject;
  } = {},
): Promise<Facts> {
  const merchant = options.merchant ?? h.merchant,
    actor = owner(merchant),
    files: FileObject[] = [];
  for (let i = 0; i < (options.count ?? 1); i++)
    files.push(await stored(type, merchant, options.same));
  const created = await h.media.assets.create(actor, {
    type,
    fileIds: files.map((f) => f.id),
    note: "",
  });
  if (type === "image") {
    const audits = await h.prisma.mediaJob.findMany({
      where: { parentId: created.storeAssetId, kind: "audit_image_wx" },
    });
    for (const audit of audits) await h.media.jobs.run({ jobId: audit.id });
  } else {
    // 合法历史前驱：真实当前run、外键、自然键与严格probe输出，不执行原生probe。
    const initial = await h.prisma.mediaJob.findFirstOrThrow({
      where: { parentId: created.storeAssetId },
    });
    const base = AssetJobInputSchema.parse(initial.input);
    for (const file of files) {
      for (const kind of ["probe", "audit_video", "asr"] as const) {
        const input = {
          ...base,
          fileId: file.id,
          etag: file.etag,
          crc64: file.crc64,
          sizeBytes: file.sizeBytes!.toString(),
        };
        const content =
          kind === "asr"
            ? {
                text: "公开虚构语音",
                durationSec: 1,
                segments: [{ text: "公开虚构语音", fromMs: 0, toMs: 1000 }],
              }
            : {};
        const probe =
          kind === "probe"
            ? {
                technical: technical(
                  file,
                  options.duration === undefined ? 60_000 : options.duration,
                ),
                cover: null,
                sourceSha256: file.sha256!,
              }
            : undefined;
        const output = {
          status: "ok",
          reason: null,
          content,
          verdict: kind === "audit_video" ? "pass" : null,
          ...(probe ? { probe } : {}),
        };
        const dedupeKey = `asset:${created.storeAssetId}:${base.runId}:${kind}:${file.id}:v${base.promptVersion}`;
        const existing = await h.prisma.mediaJob.findUnique({ where: { dedupeKey } });
        const data = {
          kind,
          provider: kind === "probe" ? "mediatool" : "fake",
          mode: kind === "probe" ? "local" : "remote",
          parentType: "store_asset",
          parentId: created.storeAssetId,
          subjectType: "file_object",
          subjectId: file.id,
          input: json(input),
          output: json(output),
          state: "succeeded",
          attemptNo: 1,
          leaseOwner: null,
          finishedAt: h.clock.now(),
          updatedAt: h.clock.now(),
        };
        const origin = existing
          ? await h.prisma.mediaJob.update({ where: { id: existing.id }, data })
          : await h.prisma.mediaJob.create({
              data: {
                ...data,
                id: uuidv7(),
                dedupeKey,
                maxAttempts: 3,
                nextRunAt: h.clock.now(),
                deadlineAt: new Date(h.clock.now().getTime() + 900_000),
                createdAt: h.clock.now(),
              },
            });
        expect(assetJobOwned(origin)).toBe(true);
        if (kind !== "audit_video")
          await h.prisma.storeAssetInsight.create({
            data: {
              id: uuidv7(),
              storeAssetId: created.storeAssetId,
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
        if (probe)
          await h.tx.run((tx) => saveTechnical(tx, file.id, probe.technical, null, h.clock.now()));
      }
    }
    await h.tx.run(async (tx) => {
      await lockRows(tx, "store_asset", [created.storeAssetId]);
      await advanceAsset(tx, dependencies(), created.storeAssetId);
    });
  }
  const jobs = await h.prisma.mediaJob.findMany({
    where: { parentId: created.storeAssetId, kind: "vision" },
    orderBy: { subjectId: "asc" },
  });
  expect(jobs).toHaveLength(files.length);
  expect(jobs.every((job) => assetJobOwned(job) && job.state === "queued")).toBe(true);
  return { assetId: created.storeAssetId, jobs, files, actor };
}
async function claim(facts: Facts) {
  return h.prisma.mediaJob.update({
    where: { id: facts.jobs[0]!.id },
    data: {
      state: "running",
      attemptNo: 1,
      leaseOwner: `vision-test:${uuidv7()}`,
      startedAt: h.clock.now(),
      nextRunAt: new Date(h.clock.now().getTime() + 120_000),
    },
  });
}
function output(outcome: JobOutcome) {
  expect(outcome.state).toBe("succeeded");
  if (outcome.state !== "succeeded") throw new Error("Expected structured vision outcome");
  return AssetJobOutputSchema.parse(outcome.output);
}
async function run(facts: Facts) {
  for (const job of facts.jobs) await h.media.jobs.run({ jobId: job.id });
  return AssetJobOutputSchema.parse((await jobRow(facts.jobs[0]!.id)).output);
}
async function digest(facts: Facts) {
  const job = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentId: facts.assetId, kind: "digest", state: "queued" },
  });
  h.fake.llm.digestReplies.push(summary());
  await h.media.jobs.run({ jobId: job.id });
  return AssetJobOutputSchema.parse((await jobRow(job.id)).output);
}
async function supersede(facts: Facts) {
  const input = AssetJobInputSchema.parse(facts.jobs[0]!.input),
    runId = uuidv7();
  h.clock.advance(1);
  return h.prisma.mediaJob.create({
    data: {
      id: uuidv7(),
      kind: "vision",
      provider: "fake",
      mode: "local",
      parentType: "store_asset",
      parentId: facts.assetId,
      subjectType: "file_object",
      subjectId: input.fileId!,
      dedupeKey: `asset:${facts.assetId}:${runId}:vision:${input.fileId}:v${input.promptVersion}`,
      input: json({ ...input, runId, selected: ["vision"] }),
      state: "queued",
      maxAttempts: 3,
      nextRunAt: h.clock.now(),
      deadlineAt: new Date(h.clock.now().getTime() + 900_000),
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
}
async function reprocess(facts: Facts, kinds: Array<"vision" | "digest" | "tech_spec">) {
  h.clock.advance(1);
  await h.media.assets.reprocess(h.admin, facts.assetId, { kinds });
  const latest = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentId: facts.assetId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const runId = AssetJobInputSchema.parse(latest.input).runId;
  return h.prisma.mediaJob
    .findMany({ where: { parentId: facts.assetId, kind: "vision" }, orderBy: { id: "asc" } })
    .then((jobs) => jobs.filter((j) => AssetJobInputSchema.parse(j.input).runId === runId));
}

describe("public image/video vision and real persistence", () => {
  it.each([
    ["image", 1, 0, 1],
    ["image", 2, 0, 1],
    ["video", 1, 60_000, 6],
    ["video", 1, 60_001, 8],
    ["video", 1, 300_000, 14],
  ] as const)(
    "%s %i files %i ms signs %i ordered requests per task",
    async (type, count, duration, frames) => {
      const facts = await ready(type, { count, duration });
      const result = await run(facts);
      expect(result).toMatchObject({
        status: "ok",
        reason: null,
        content: { ...visible(), cacheSourceId: null },
      });
      expect(signing).toHaveBeenCalledTimes(count * frames);
      expect(model).toHaveBeenCalledTimes(count);
      for (let index = 0; index < count; index++) {
        const job = await jobRow(facts.jobs[index]!.id),
          input = AssetJobInputSchema.parse(job.input);
        const file = facts.files.find((f) => f.id === input.fileId)!;
        const expected = type === "image" ? [null] : visionFrameTimes(duration)!;
        const calls = signing.mock.calls.slice(index * frames, (index + 1) * frames);
        expect(calls.map(([value]) => value)).toEqual(
          expected.map((atMs) => ({
            bucket: "asset",
            key: file.objectKey,
            expiresSec: 900,
            source: atMs === null ? { kind: "image" } : { kind: "video-frame", atMs },
          })),
        );
        const returned = signing.mock.results
          .slice(index * frames, (index + 1) * frames)
          .filter((entry) => entry.type === "return");
        expect(returned).toHaveLength(frames);
        expect(model.mock.calls[index]![0].imageUrls).toEqual(
          (await Promise.all(returned.map((entry) => entry.value))).map((reply) =>
            reply.ok ? reply.value.url : "unavailable",
          ),
        );
        expect(job).toMatchObject({ state: "succeeded", attemptNo: 1, leaseOwner: null });
        const content = AssetJobOutputSchema.parse(job.output).content;
        expect(content.frameAtMs).toEqual(type === "image" ? [] : expected);
        expect(content.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      }
      const saved = await visions(facts.assetId);
      expect(saved).toHaveLength(count);
      for (const row of saved) expect(row.content).toEqual(visible());
      const persisted = JSON.stringify(saved);
      for (const hidden of ["https://", "sourceHash", "frameAtMs", "cacheSourceId"])
        expect(persisted).not.toContain(hidden);
      expect(await tags(facts.assetId)).toEqual([]);
      expect(await assetRow(facts.assetId)).toMatchObject({
        title: null,
        portraitAuthorizedAt: null,
        reviewState: "unreviewed",
        usability: null,
      });
      await digest(facts);
      const events = await outbox(facts.assetId);
      expect(events.filter((e) => e.eventType === "asset.processed")).toHaveLength(1);
      expect(events.filter((e) => e.eventType === "asset.review_needed")).toHaveLength(1);
      for (const job of facts.jobs) await h.media.jobs.run({ jobId: job.id });
      expect(await visions(facts.assetId)).toEqual(saved);
      expect(model).toHaveBeenCalledTimes(count);
    },
  );
});

describe("current subject, file and complete provenance", () => {
  it.each([
    "foreign-entity",
    "foreign-store",
    "wrong-category",
    "missing-link",
    "asset-deleted",
    "asset-block",
    "file-deleted",
    "file-block",
    "etag-changed",
    "superseded-run",
    "attempt-or-owner-changed",
    "provider-or-input-changed",
  ] as const)("%s rejects the original claim before signing or model IO", async (change) => {
    const facts = await ready(),
      job = await claim(facts),
      file = facts.files[0]!;
    if (change === "foreign-entity") {
      const foreign = await h.make.merchant();
      await h.prisma.fileObject.update({
        where: { id: file.id },
        data: {
          entityId: foreign.entity.id,
          storeId: foreign.store.id,
        },
      });
    } else if (change === "foreign-store") {
      const other = await h.make.store({ entityId: h.merchant.entity.id });
      await h.prisma.fileObject.update({ where: { id: file.id }, data: { storeId: other.id } });
    } else if (change === "wrong-category") {
      await h.prisma.fileObject.update({
        where: { id: file.id },
        data: { category: "portrait_auth" },
      });
    } else if (change === "missing-link") {
      await h.prisma.storeAssetFile.deleteMany({ where: { storeAssetId: facts.assetId } });
    } else if (change === "asset-deleted" || change === "asset-block") {
      await h.prisma.storeAsset.update({
        where: { id: facts.assetId },
        data:
          change === "asset-deleted" ? { deletedAt: h.clock.now() } : { moderationState: "block" },
      });
    } else if (change === "file-deleted" || change === "file-block" || change === "etag-changed") {
      await h.prisma.fileObject.update({
        where: { id: file.id },
        data:
          change === "file-deleted"
            ? { status: "deleted", deletedAt: h.clock.now() }
            : change === "file-block"
              ? { moderationState: "block" }
              : { etag: "new-real-db-etag" },
      });
    } else if (change === "superseded-run") await supersede(facts);
    else
      await h.prisma.mediaJob.update({
        where: { id: job.id },
        data:
          change === "attempt-or-owner-changed"
            ? { attemptNo: 2, leaseOwner: "winner" }
            : {
                provider: "unconfigured",
                input: json({ ...AssetJobInputSchema.parse(job.input), etag: "winner" }),
              },
      });
    const result = await strategy().execute(job, new AbortController().signal);
    expect(result).toEqual({ state: "canceled" });
    expect(signing).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
    expect(await visions(facts.assetId)).toEqual([]);
  });

  it.each([
    "missing-tech-spec",
    "duration-null",
    "wrong-probe-job-parent",
    "wrong-probe-prompt",
    "selected-tech-spec-old-run",
    "unselected-tech-spec-old-run",
    "probe-provider-mismatch",
    "probe-output-tamper",
    "source-sha-mismatch",
    "media-info-duration-mismatch",
    "media-info-version-mismatch",
  ] as const)("video provenance %s is checked against real rows", async (change) => {
    const facts = await ready("video"),
      file = facts.files[0]!;
    const insight = await h.prisma.storeAssetInsight.findFirstOrThrow({
      where: { storeAssetId: facts.assetId, kind: "tech_spec" },
    });
    const origin = await jobRow(insight.mediaJobId!),
      original = AssetJobOutputSchema.parse(origin.output);
    const input = AssetJobInputSchema.parse(origin.input);
    if (change === "missing-tech-spec")
      await h.prisma.storeAssetInsight.delete({ where: { id: insight.id } });
    else if (change === "duration-null") {
      const probe = { technical: technical(file, null), cover: null, sourceSha256: file.sha256! };
      await h.prisma.mediaJob.update({
        where: { id: origin.id },
        data: { output: json({ ...original, probe }) },
      });
      await h.tx.run((tx) => saveTechnical(tx, file.id, probe.technical, null, origin.finishedAt!));
    } else if (change === "wrong-probe-job-parent") {
      const foreign = await ready();
      await h.prisma.mediaJob.update({
        where: { id: origin.id },
        data: { parentId: foreign.assetId },
      });
    } else if (change === "wrong-probe-prompt") {
      await h.prisma.mediaJob.update({
        where: { id: origin.id },
        data: {
          input: json({ ...input, promptVersion: 2 }),
          dedupeKey: `asset:${facts.assetId}:${input.runId}:probe:${file.id}:v2`,
        },
      });
    } else if (change.includes("tech-spec-old-run")) {
      const runId = uuidv7(),
        selected = change.startsWith("unselected") ? ["vision"] : ["tech_spec", "vision"];
      h.clock.advance(1);
      const job = facts.jobs[0]!;
      await h.prisma.mediaJob.update({
        where: { id: job.id },
        data: {
          input: json({ ...AssetJobInputSchema.parse(job.input), runId, selected }),
          dedupeKey: `asset:${facts.assetId}:${runId}:vision:${file.id}:v${input.promptVersion}`,
          createdAt: h.clock.now(),
        },
      });
      facts.jobs[0] = await jobRow(job.id);
    } else if (change === "probe-provider-mismatch") {
      await h.prisma.storeAssetInsight.update({
        where: { id: insight.id },
        data: { provider: "fake" },
      });
    } else if (change === "probe-output-tamper") {
      await h.prisma.mediaJob.update({
        where: { id: origin.id },
        data: { output: json({ ...original, content: { changed: true } }) },
      });
    } else if (change === "source-sha-mismatch") {
      await h.prisma.fileObject.update({
        where: { id: file.id },
        data: { sha256: "f".repeat(64) },
      });
    } else
      await h.prisma.mediaInfo.update({
        where: { fileId: file.id },
        data:
          change === "media-info-duration-mismatch" ? { durationMs: 60_001 } : { probeVersion: 2 },
      });
    const result = output(
      await strategy().execute(await claim(facts), new AbortController().signal),
    );
    if (change === "unselected-tech-spec-old-run") {
      expect(result.status).toBe("ok");
      expect(signing).toHaveBeenCalledTimes(6);
      expect(model).toHaveBeenCalledOnce();
    } else {
      expect(result).toMatchObject({ status: "skipped", reason: "vision_source_missing" });
      expect(signing).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
    }
    expect(await visions(facts.assetId)).toEqual([]);
  });
});

describe("fixed signing, model and budget boundaries", () => {
  it.each([
    "budget-absent",
    "budget-false",
    "budget-throw",
    "llm-unconfigured",
    "storage-unsupported",
    "sign-nth-fails",
    "signature-expired",
    "invalid-signed-url",
    "model-unavailable",
    "model-throw",
    "model-dto-invalid",
  ] as const)("%s cannot become an empty successful insight or generic retry", async (change) => {
    const facts = await ready("video");
    let job = await claim(facts);
    const allowed = vi.fn(async () => true);
    const overrides: Partial<AssetDeps["assets"]> = {
      allowModelCall: change === "budget-absent" ? undefined : allowed,
      ...(change === "llm-unconfigured"
        ? { llm: { ...h.fake.llm, status: "unconfigured", configured: false } }
        : {}),
    };
    if (change === "llm-unconfigured")
      job = await h.prisma.mediaJob.update({
        where: { id: job.id },
        data: { provider: "unconfigured" },
      });
    if (change === "budget-false") allowed.mockResolvedValue(false);
    if (change === "budget-throw")
      allowed.mockRejectedValue(new Error("public fixture budget failure"));
    if (change === "storage-unsupported")
      signing.mockResolvedValue(failed("unsupported", "public fixture"));
    if (change === "sign-nth-fails")
      signing.mockImplementation(async () =>
        signing.mock.calls.length === 3
          ? failed("unavailable", "public fixture")
          : ok({
              url: "https://public.invalid/image.jpg",
              expiresAt: new Date(NOW.getTime() + 900_000),
            }),
      );
    if (change === "signature-expired")
      signing.mockResolvedValue(
        ok({ url: "https://public.invalid/image.jpg", expiresAt: h.clock.now() }),
      );
    if (change === "invalid-signed-url")
      signing.mockResolvedValue(
        ok({
          url: "https://user:password@public.invalid/image.jpg",
          expiresAt: new Date(NOW.getTime() + 900_000),
        }),
      );
    if (change === "model-unavailable")
      model.mockResolvedValue(failed("unavailable", "public fixture"));
    if (change === "model-throw")
      model.mockRejectedValue(new Error("public fixture model failure"));
    if (change === "model-dto-invalid")
      model.mockResolvedValue(ok({ ...visible(), quality: undefined } as unknown as LlmVision));
    const result = output(await strategy(overrides).execute(job, new AbortController().signal));
    expect(result.status).toBe("skipped");
    expect(result.content).toEqual({});
    expect(result.reason).toMatch(
      /^(budget_unconfigured|llm_unconfigured|vision_signing_unavailable|vision_unavailable|vision_result_invalid)$/,
    );
    expect(await visions(facts.assetId)).toEqual([]);
    expect(await jobRow(job.id)).toMatchObject({
      state: "running",
      attemptNo: 1,
      leaseOwner: job.leaseOwner,
    });
    expect(allowed.mock.calls.length).toBeLessThanOrEqual(1);
    expect(model.mock.calls.length).toBeLessThanOrEqual(1);
    if (["budget-absent", "llm-unconfigured"].includes(change))
      expect(signing).not.toHaveBeenCalled();
    if (change === "sign-nth-fails") expect(signing).toHaveBeenCalledTimes(3);
    if (!["model-unavailable", "model-throw", "model-dto-invalid"].includes(change))
      expect(model).not.toHaveBeenCalled();
  });
});

describe("unlocked model IO and complete late-source fingerprints", () => {
  it.each([
    "already-aborted",
    "pending-abort",
    "late-after-abort",
    "file-block-during-io",
    "etag-or-key-during-io",
    "probe-duration-during-io",
    "current-run-during-io",
    "private-unprojected-source-during-io",
  ] as const)("%s never installs a late successful insight", async (change) => {
    const facts = await ready(
        change.includes("probe") || change.includes("private") ? "video" : "image",
      ),
      job = await claim(facts),
      controller = new AbortController(),
      entered = gate(),
      release = gate();
    model.mockImplementation(async ({ signal }) => {
      assertNotInTransaction("late controlled vision IO");
      expect(signal).toBe(controller.signal);
      entered.release();
      await release.promise;
      if (change === "pending-abort") throw new DOMException("Aborted", "AbortError");
      return ok(visible());
    });
    if (change === "already-aborted") controller.abort();
    const pending = strategy().execute(job, controller.signal);
    void pending.catch(() => undefined);
    try {
      if (change !== "already-aborted") {
        await entered.promise;
        if (change.includes("abort")) controller.abort();
        else if (change === "current-run-during-io") await supersede(facts);
        else if (change === "file-block-during-io")
          await h.prisma.fileObject.update({
            where: { id: facts.files[0]!.id },
            data: { moderationState: "block" },
          });
        else if (change === "etag-or-key-during-io")
          await h.prisma.fileObject.update({
            where: { id: facts.files[0]!.id },
            data: { objectKey: "test/winner.png" },
          });
        else {
          const origin = await h.prisma.mediaJob.findFirstOrThrow({
            where: { parentId: facts.assetId, kind: "probe" },
          });
          const before = AssetJobOutputSchema.parse(origin.output),
            file = facts.files[0]!;
          const value = technical(file, change === "probe-duration-during-io" ? 60_001 : 60_000);
          const probe = {
            technical:
              change === "private-unprojected-source-during-io"
                ? { ...value, raw: { ...value.raw, majorBrand: "mp42" } }
                : value,
            cover: null,
            sourceSha256: file.sha256!,
          };
          await h.tx.run(async (tx) => {
            await lockRows(tx, "store_asset", [facts.assetId]);
            await lockRows(tx, "media_job", [origin.id]);
            await lockRows(tx, "file_object", [file.id]);
            await tx.mediaJob.update({
              where: { id: origin.id },
              data: { output: json({ ...before, probe }) },
            });
            await saveTechnical(tx, file.id, probe.technical, null, origin.finishedAt!);
          });
        }
      }
      release.release();
      expect(await pending).toEqual({ state: "canceled" });
      expect(await visions(facts.assetId)).toEqual([]);
      expect(await tags(facts.assetId)).toEqual([]);
      expect((await assetRow(facts.assetId)).portraitAuthorizedAt).toBeNull();
      expect(model).toHaveBeenCalledTimes(change === "already-aborted" ? 0 : 1);
      if (change === "already-aborted") expect(signing).not.toHaveBeenCalled();
    } finally {
      release.release();
      await pending.catch(() => undefined);
    }
  });
});

type LockTable = "file_object" | "media_job" | "store_asset";
async function held(
  table: LockTable,
  id: string,
  body: (lock: {
    holder: Awaited<ReturnType<typeof connectTestDatabase>>;
    blocked: () => Promise<void>;
    commit: () => Promise<void>;
  }) => Promise<void>,
) {
  const holder = await connectTestDatabase(database.name),
    observer = await connectTestDatabase(database.name, { role: null });
  try {
    await holder.query("BEGIN");
    const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid");
    // 表名限定为本叶枚举；业务持锁者仍使用真实app角色。
    await holder.query(`SELECT id FROM ${table} WHERE id=$1::uuid FOR UPDATE`, [id]);
    await body({
      holder,
      commit: async () => {
        await holder.query("COMMIT");
      },
      blocked: async () => {
        await vi.waitFor(
          async () => {
            const result = await observer.query<{ count: string }>(
              "SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query ILIKE $2",
              [rows[0]!.pid, `%${table}%`],
            );
            expect(Number(result.rows[0]!.count)).toBe(1);
          },
          { timeout: 3000 },
        );
      },
    });
  } finally {
    await holder.query("ROLLBACK");
    await Promise.all([holder.end(), observer.end()]);
  }
}

describe("real lock waits recheck lease, deadline and current facts", () => {
  it.each([
    ["preflight", "lease"],
    ["preflight", "deadline"],
    ["finish", "lease"],
    ["finish", "deadline"],
  ] as const)(
    "%s file410 wait crosses exactly %s without accepting vision",
    async (phase, boundary) => {
      const facts = await ready("image", { count: 2 }),
        executed = gate(),
        release = gate();
      if (boundary === "deadline")
        await h.prisma.mediaJob.update({
          where: { id: facts.jobs[0]!.id },
          data: { deadlineAt: new Date(NOW.getTime() + 1000) },
        });
      let running: Promise<unknown> | undefined, claimed: MediaJob;
      try {
        if (phase === "finish") {
          const actual = handler().execute;
          vi.spyOn(handler(), "execute").mockImplementation(async (...args) => {
            const result = await actual(...args);
            expect(result).toMatchObject({ state: "succeeded", output: { status: "ok" } });
            executed.release();
            await release.promise;
            return result;
          });
          running = h.media.jobs.run({ jobId: facts.jobs[0]!.id });
          void running.catch(() => undefined);
          await executed.promise;
          claimed = await jobRow(facts.jobs[0]!.id);
        } else claimed = await claim(facts);
        await held("file_object", facts.files[1]!.id, async (lock) => {
          if (phase === "preflight") {
            running = strategy().execute(claimed, new AbortController().signal);
            void running.catch(() => undefined);
          }
          release.release();
          await lock.blocked();
          expect(await visions(facts.assetId)).toEqual([]);
          h.clock.set(boundary === "deadline" ? claimed.deadlineAt : claimed.nextRunAt);
          await lock.commit();
          const result = await running;
          if (phase === "preflight") expect(result).toEqual({ state: "canceled" });
        });
        expect(model).toHaveBeenCalledTimes(phase === "finish" ? 1 : 0);
        if (phase === "preflight") expect(signing).not.toHaveBeenCalled();
        const written = await jobRow(facts.jobs[0]!.id);
        expect(written).toMatchObject({
          attemptNo: 1,
          deadlineAt: claimed.deadlineAt,
          nextRunAt: claimed.nextRunAt,
        });
        if (phase === "finish")
          expect(written).toMatchObject({ state: "succeeded", leaseOwner: null });
        if (phase === "finish")
          expect(await assetRow(facts.assetId)).toMatchObject({
            isInsightPartial: true,
            reviewState: "unreviewed",
          });
        expect((await visions(facts.assetId)).filter((row) => row.status === "ok")).toEqual([]);
        expect(await tags(facts.assetId)).toEqual([]);
        expect(await assetRow(facts.assetId)).toMatchObject({
          title: null,
          portraitAuthorizedAt: null,
          usability: null,
        });
      } finally {
        release.release();
        await running?.catch(() => undefined);
        h.clock.set(NOW);
      }
    },
    120_000,
  );

  it.each(["sign-await-expiry", "admission-await-expiry"] as const)(
    "%s cannot reach model IO",
    async (stage) => {
      const facts = await ready(),
        job = await claim(facts),
        entered = gate(),
        release = gate();
      const allowed = vi.fn(async (tx: Tx) => {
        // 真实本事务标记只证明异常回滚，不冒称已实现费用预算。
        await tx.storeAsset.update({
          where: { id: facts.assetId },
          data: { note: "本事务回滚标记" },
        });
        entered.release();
        await release.promise;
        return true;
      });
      if (stage === "sign-await-expiry")
        signing.mockImplementation(async () => {
          assertNotInTransaction("held signing IO");
          entered.release();
          await release.promise;
          return ok({
            url: "https://public.invalid/held.jpg",
            expiresAt: new Date(NOW.getTime() + 900_000),
          });
        });
      const pending = strategy({ allowModelCall: allowed }).execute(
        job,
        new AbortController().signal,
      );
      void pending.catch(() => undefined);
      try {
        await entered.promise;
        h.clock.set(job.nextRunAt);
        release.release();
        expect(await pending).toEqual({ state: "canceled" });
        expect(model).not.toHaveBeenCalled();
        expect(allowed).toHaveBeenCalledTimes(stage === "admission-await-expiry" ? 1 : 0);
        expect(await visions(facts.assetId)).toEqual([]);
        expect((await assetRow(facts.assetId)).note).toBe("");
      } finally {
        release.release();
        await pending.catch(() => undefined);
        h.clock.set(NOW);
      }
    },
  );

  it.each(["370-wait-source-reread", "400-wait-attempt-reread"] as const)(
    "%s uses the committed winner",
    async (stage) => {
      const facts = await ready(),
        job = await claim(facts),
        file = facts.files[0]!;
      let pending: Promise<JobOutcome> | undefined;
      try {
        await held(
          stage.startsWith("370") ? "store_asset" : "media_job",
          stage.startsWith("370") ? facts.assetId : job.id,
          async (lock) => {
            pending = strategy().execute(job, new AbortController().signal);
            void pending.catch(() => undefined);
            await lock.blocked();
            if (stage.startsWith("370"))
              await lock.holder.query("UPDATE file_object SET object_key=$2 WHERE id=$1::uuid", [
                file.id,
                "test/committed-winner.png",
              ]);
            else
              await lock.holder.query(
                "UPDATE media_job SET attempt_no=2,lease_owner='actual-winner' WHERE id=$1::uuid",
                [job.id],
              );
            await lock.commit();
            const result = await pending;
            if (stage.startsWith("370")) {
              expect(output(result).status).toBe("ok");
              expect(signing.mock.calls[0]![0].key).toBe("test/committed-winner.png");
              expect(model).toHaveBeenCalledOnce();
            } else {
              expect(result).toEqual({ state: "canceled" });
              expect(signing).not.toHaveBeenCalled();
              expect(model).not.toHaveBeenCalled();
            }
          },
        );
        expect(await visions(facts.assetId)).toEqual([]);
      } finally {
        await pending?.catch(() => undefined);
      }
    },
  );
});

describe("real first-round cache origins and bounded parent-lock graph", () => {
  it.each([
    "same-entity-hit",
    "same-entity-cross-store-hit",
    "cross-entity-no-hit",
    "legacy-dto-no-hit",
    "origin-content-mismatch",
    "origin-provider-mismatch",
    "deleted-source-no-hit",
    "blocked-source-no-hit",
    "cache-source-changed-while-waiting",
    "candidate-graph-expanded",
    "cached-origin-old-run-valid-when-vision-unselected",
    "cached-origin-old-run-invalid-when-vision-selected",
  ] as const)(
    "%s never trusts a naked matching CRC or stale source run",
    async (change) => {
      const source = await ready("image", {
        count: change === "cache-source-changed-while-waiting" ? 2 : 1,
      });
      await run(source);
      await digest(source);
      const origin = await jobRow(source.jobs[0]!.id),
        saved = (await visions(source.assetId)).find((row) => row.fileId === source.files[0]!.id)!;
      const sourceBefore = await visions(source.assetId);
      let merchant = h.merchant;
      if (change === "same-entity-cross-store-hit") {
        const store = await h.make.store({ entityId: h.merchant.entity.id });
        await h.make.storeMember({
          entityId: h.merchant.entity.id,
          entityMemberId: h.merchant.owner.id,
          storeId: store.id,
        });
        merchant = { ...h.merchant, store };
      } else if (change === "cross-entity-no-hit")
        merchant = await h.make.merchant({ verified: true });
      if (change === "legacy-dto-no-hit") {
        const content = { description: "合法旧视觉洞察", tags: [] };
        await h.prisma.mediaJob.update({
          where: { id: origin.id },
          data: {
            output: json({ ...AssetJobOutputSchema.parse(origin.output), content }),
          },
        });
        await h.prisma.storeAssetInsight.update({
          where: { id: saved.id },
          data: { content: json(content) },
        });
      } else if (change === "origin-content-mismatch")
        await h.prisma.storeAssetInsight.update({
          where: { id: saved.id },
          data: { content: json(visible({ quality: "真实已改行" })) },
        });
      else if (change === "origin-provider-mismatch")
        await h.prisma.storeAssetInsight.update({
          where: { id: saved.id },
          data: { provider: "unconfigured" },
        });
      else if (change === "deleted-source-no-hit")
        await h.prisma.storeAsset.update({
          where: { id: source.assetId },
          data: { deletedAt: h.clock.now() },
        });
      else if (change === "blocked-source-no-hit" || change === "candidate-graph-expanded")
        await h.prisma.storeAsset.update({
          where: { id: source.assetId },
          data: { moderationState: "block" },
        });
      else if (change.includes("cached-origin-old-run"))
        await reprocess(source, change.includes("invalid") ? ["vision", "digest"] : ["digest"]);
      const target = await ready("image", { merchant, same: source.files[0] });
      signing.mockClear();
      model.mockClear();
      const hit = [
        "same-entity-hit",
        "same-entity-cross-store-hit",
        "cached-origin-old-run-valid-when-vision-unselected",
      ].includes(change);
      if (hit) h.permitControlledModel(false);
      if (change === "same-entity-hit") {
        const extra = await ready("image", { same: source.files[0] });
        const allow = vi.fn(async () => {
          throw new Error("缓存不应进入准入回调");
        });
        const result = output(
          await strategy({ allowModelCall: allow }).execute(
            await claim(extra),
            new AbortController().signal,
          ),
        );
        expect(result).toMatchObject({
          status: "ok",
          reusedFromId: saved.id,
          content: { cacheSourceId: saved.id },
        });
        expect(allow).not.toHaveBeenCalled();
        expect(signing).not.toHaveBeenCalled();
        expect(model).not.toHaveBeenCalled();
      }
      let pending: Promise<void> | undefined;
      try {
        if (
          change === "cache-source-changed-while-waiting" ||
          change === "candidate-graph-expanded"
        ) {
          await held(
            "store_asset",
            change === "candidate-graph-expanded" ? target.assetId : source.assetId,
            async (lock) => {
              pending = h.media.jobs.run({ jobId: target.jobs[0]!.id });
              void pending.catch(() => undefined);
              await lock.blocked();
              if (change === "candidate-graph-expanded")
                await lock.holder.query(
                  "UPDATE store_asset SET moderation_state='pass' WHERE id=$1::uuid",
                  [source.assetId],
                );
              else
                await lock.holder.query(
                  "UPDATE file_object SET etag='actual-cache-winner' WHERE id=$1::uuid",
                  [source.files[0]!.id],
                );
              await lock.commit();
              if (change === "candidate-graph-expanded")
                await expect(pending).rejects.toMatchObject({ code: "BUSY" });
              else await pending;
            },
          );
        } else await run(target);
        const job = await jobRow(target.jobs[0]!.id);
        if (change === "candidate-graph-expanded") {
          expect((await visions(target.assetId)).filter((row) => row.status === "ok")).toEqual([]);
          expect(signing).not.toHaveBeenCalled();
          expect(model).not.toHaveBeenCalled();
        } else {
          const result = AssetJobOutputSchema.parse(job.output);
          expect(result.status).toBe("ok");
          expect(visionContent(result.content)).toEqual(visible());
          expect(result.content.cacheSourceId).toBe(hit ? saved.id : null);
          expect(result.reusedFromId ?? null).toBe(hit ? saved.id : null);
          const installed = await visions(target.assetId);
          expect(installed).toHaveLength(1);
          expect(installed[0]!.content).toEqual(visible());
          expect(installed[0]!.reusedFromStoreAssetInsightId).toBe(hit ? saved.id : null);
          expect(signing).toHaveBeenCalledTimes(hit ? 0 : 1);
          expect(model).toHaveBeenCalledTimes(hit ? 0 : 1);
        }
        if (hit) expect(await visions(source.assetId)).toEqual(sourceBefore);
        expect(await tags(target.assetId)).toEqual([]);
        expect((await assetRow(target.assetId)).portraitAuthorizedAt).toBeNull();
      } finally {
        await pending?.catch(() => undefined);
        h.permitControlledModel(true);
      }
    },
    120_000,
  );
});

describe("public reprocess selects only the requested current source generation", () => {
  it.each([
    "digest-only-keeps-valid-vision",
    "selected-vision-refuses-old-run-as-new-result",
  ] as const)(
    "%s retains legitimate history without laundering it as a new result",
    async (change) => {
      const facts = await ready();
      await run(facts);
      await digest(facts);
      const before = await visions(facts.assetId),
        oldJob = await jobRow(facts.jobs[0]!.id);
      const next = await reprocess(
        facts,
        change.startsWith("digest-only") ? ["digest"] : ["vision", "digest"],
      );
      expect(await visions(facts.assetId)).toEqual(before);
      model.mockClear();
      signing.mockClear();
      h.fake.llm.resetCalls();
      if (change.startsWith("digest-only")) {
        await digest(facts);
        expect(h.fake.llm.callsOf("summarizeAsset")).toHaveLength(1);
        expect(
          (
            h.fake.llm.callsOf("summarizeAsset")[0]!.input as Parameters<
              LlmProvider["summarizeAsset"]
            >[0]
          ).text,
        ).toContain(visible().description);
        expect(await visions(facts.assetId)).toEqual(before);
        expect(model).not.toHaveBeenCalled();
        expect(signing).not.toHaveBeenCalled();
      } else {
        expect(next).toHaveLength(1);
        expect(AssetJobInputSchema.parse(next[0]!.input).runId).not.toBe(
          AssetJobInputSchema.parse(oldJob.input).runId,
        );
        // 合法终态历史不调用vision.finish，也不能覆盖保留洞察。
        await h.tx.run(async (tx) => {
          await lockRows(tx, "store_asset", [facts.assetId]);
          await lockRows(tx, "media_job", [next[0]!.id]);
          await tx.mediaJob.update({
            where: { id: next[0]!.id },
            data: { state: "canceled", finishedAt: h.clock.now(), leaseOwner: null },
          });
          await advanceAsset(tx, dependencies(), facts.assetId);
        });
        const result = await digest(facts);
        expect(result).toMatchObject({ status: "skipped", reason: "digest_source_missing" });
        expect(h.fake.llm.callsOf("summarizeAsset")).toEqual([]);
        expect(await visions(facts.assetId)).toEqual(before);
      }
      expect(await tags(facts.assetId)).toEqual([]);
    },
  );
});

describe("public runner winner and actual transactional rollback", () => {
  it("two real runner instances share one claim, IO and successful vision", async () => {
    const facts = await ready(),
      entered = gate(),
      release = gate();
    const second = createMediaJobs({
      tx: h.tx,
      clock: h.clock,
      ownerId: "vision-real-second-worker",
      handlers: [...h.media.jobs.handlers.values()],
      convergenceHandlers: [...h.media.jobs.convergence.values()],
    });
    model.mockImplementation(async () => {
      assertNotInTransaction("winner vision IO");
      entered.release();
      await release.promise;
      return ok(visible());
    });
    const running = h.media.jobs.run({ jobId: facts.jobs[0]!.id });
    void running.catch(() => undefined);
    try {
      await entered.promise;
      await second.run({ jobId: facts.jobs[0]!.id });
      expect(await visions(facts.assetId)).toEqual([]);
    } finally {
      release.release();
      await running;
      await second.shutdown();
    }
    expect(model).toHaveBeenCalledOnce();
    expect(signing).toHaveBeenCalledOnce();
    expect(await visions(facts.assetId)).toMatchObject([
      { content: visible(), reusedFromStoreAssetInsightId: null },
    ]);
    expect(await jobRow(facts.jobs[0]!.id)).toMatchObject({
      state: "succeeded",
      attemptNo: 1,
      leaseOwner: null,
    });
    await digest(facts);
    const events = await outbox(facts.assetId);
    expect(events.filter((e) => e.eventType === "asset.processed")).toHaveLength(1);
    expect(events.filter((e) => e.eventType === "asset.review_needed")).toHaveLength(1);
  });

  it("actual vision insert and later natural outbox failures roll back their own complete transactions", async () => {
    const facts = await ready();
    const snapshot = async () => ({
      asset: await assetRow(facts.assetId),
      insights: await allInsights(facts.assetId),
      tags: await tags(facts.assetId),
      events: await outbox(facts.assetId),
    });
    const before = await snapshot(),
      actual = handler().finish!;
    let claimed: MediaJob | undefined;
    model.mockImplementation(async () => {
      assertNotInTransaction("回滚用例的真实视觉IO边界");
      claimed = await jobRow(facts.jobs[0]!.id);
      return ok(visible());
    });
    const broken = vi.spyOn(handler(), "finish").mockImplementation(async (...args) => {
      await actual(...args);
      expect(
        await args[0].storeAssetInsight.count({
          where: { storeAssetId: facts.assetId, kind: "vision", status: "ok" },
        }),
      ).toBe(1);
      throw new Error("controlled failure after real vision insert");
    });
    await expect(h.media.jobs.run({ jobId: facts.jobs[0]!.id })).rejects.toThrow(
      "after real vision insert",
    );
    expect(claimed).toBeDefined();
    expect(await jobRow(facts.jobs[0]!.id)).toEqual(claimed);
    expect(await snapshot()).toEqual(before);
    broken.mockRestore();
    // 按既有真实租约到期重新认领，不伪造终态输出。
    h.clock.set(new Date(claimed!.nextRunAt.getTime() + 1));
    await h.media.jobs.run({ jobId: facts.jobs[0]!.id });
    expect(await visions(facts.assetId)).toHaveLength(1);
    const digestJob = await h.prisma.mediaJob.findFirstOrThrow({
      where: { parentId: facts.assetId, kind: "digest", state: "queued" },
    });
    const beforeDigest = await snapshot();
    let digestClaim: MediaJob | undefined;
    vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async () => {
      assertNotInTransaction("回滚用例的真实摘要IO边界");
      digestClaim = await jobRow(digestJob.id);
      return ok(summary());
    });
    const emit = h.events.emit;
    vi.spyOn(h.events, "emit").mockImplementation(async (...args) => {
      await emit(...args);
      throw new Error("controlled failure after real vision-chain outbox insert");
    });
    await expect(h.media.jobs.run({ jobId: digestJob.id })).rejects.toThrow(
      "after real vision-chain outbox insert",
    );
    expect(digestClaim).toBeDefined();
    expect(await jobRow(digestJob.id)).toEqual(digestClaim);
    expect(await snapshot()).toEqual(beforeDigest);
  });
});

describe("strict vision facts feed aggregate digest without private metadata", () => {
  it.each([
    "five-fields-feed-real-digest",
    "private-provenance-no-business-leak",
    "16000-cut-hash-keeps-suffix",
  ] as const)(
    "%s preserves public facts, full source hash and human-only authorization",
    async (scenario) => {
      const facts = await ready("image", { count: scenario.startsWith("16000") ? 2 : 1 });
      const reply = scenario.startsWith("16000")
        ? visible({
            description: "描".repeat(2000),
            quality: "质".repeat(500),
            textInImage: "字".repeat(7999) + "尾",
          })
        : visible();
      model.mockResolvedValue(ok(reply));
      await run(facts);
      if (scenario.startsWith("16000")) {
        const job = await h.prisma.mediaJob.findFirstOrThrow({
          where: { parentId: facts.assetId, kind: "digest", state: "queued" },
        });
        const claimed = await h.prisma.mediaJob.update({
          where: { id: job.id },
          data: {
            state: "running",
            attemptNo: 1,
            leaseOwner: "digest-suffix-owner",
            startedAt: h.clock.now(),
            nextRunAt: new Date(NOW.getTime() + 120_000),
          },
        });
        const digestStrategy = createAssetDigestStrategy(
          dependencies(),
          h.media.jobs.handlers.get("digest")!.current,
        );
        h.fake.llm.digestReplies.push(summary(), summary());
        const first = output(await digestStrategy.execute(claimed, new AbortController().signal));
        const rows = await visions(facts.assetId),
          last = rows.find((row) => row.fileId === facts.files[1]!.id)!;
        const origin = await jobRow(last.mediaJobId!),
          old = AssetJobOutputSchema.parse(origin.output);
        const changed = visible({ ...reply, textInImage: "字".repeat(7999) + "异" });
        await h.tx.run(async (tx) => {
          await lockRows(tx, "store_asset", [facts.assetId]);
          await lockRows(tx, "media_job", [origin.id]);
          await tx.mediaJob.update({
            where: { id: origin.id },
            data: { output: json({ ...old, content: { ...old.content, ...changed } }) },
          });
          await tx.storeAssetInsight.update({
            where: { id: last.id },
            data: { content: json(changed) },
          });
        });
        const second = output(await digestStrategy.execute(claimed, new AbortController().signal));
        const calls = h.fake.llm.callsOf("summarizeAsset");
        expect(calls).toHaveLength(2);
        expect(
          Array.from((calls[0]!.input as Parameters<LlmProvider["summarizeAsset"]>[0]).text),
        ).toHaveLength(16000);
        expect((calls[1]!.input as Parameters<LlmProvider["summarizeAsset"]>[0]).text).toBe(
          (calls[0]!.input as Parameters<LlmProvider["summarizeAsset"]>[0]).text,
        );
        expect(first.content.partial).toBe(true);
        expect(second.content.partial).toBe(true);
        expect(first.content.sourceHash).not.toBe(second.content.sourceHash);
        expect(await allInsights(facts.assetId)).not.toContainEqual(
          expect.objectContaining({ kind: "digest", status: "ok" }),
        );
      } else {
        await digest(facts);
        const calls = h.fake.llm.callsOf("summarizeAsset");
        expect(calls).toHaveLength(1);
        for (const field of [
          "description",
          "quality",
          "textInImage",
          "hasPeople",
          "identifiableCustomerFace",
        ])
          expect((calls[0]!.input as Parameters<LlmProvider["summarizeAsset"]>[0]).text).toContain(
            `${field}: ${String(reply[field as keyof LlmVision])}`,
          );
        const details = await h.media.assets.get(h.admin, facts.assetId);
        const serialized = JSON.stringify(
          {
            details,
            insights: await allInsights(facts.assetId),
            events: await outbox(facts.assetId),
          },
          (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
        );
        for (const privateFact of [
          "sourceHash",
          "frameAtMs",
          "cacheSourceId",
          "https://public.invalid/",
        ])
          expect(serialized).not.toContain(privateFact);
        expect(details).toMatchObject({
          portraitAuth: { authorizedAt: null },
          reviewState: "unreviewed",
          usability: null,
        });
        expect(await tags(facts.assetId)).toEqual([]);
        if (scenario === "private-provenance-no-business-leak") {
          // 明确合法历史旧DTO；既有摘要兼容分支须保留2000字，而非让新helper伪造五项。
          const row = (await visions(facts.assetId))[0]!,
            origin = await jobRow(row.mediaJobId!);
          const legacy = { description: "旧".repeat(2000), tags: [] };
          await h.tx.run(async (tx) => {
            await lockRows(tx, "store_asset", [facts.assetId]);
            await lockRows(tx, "media_job", [origin.id]);
            await lockRows(tx, "file_object", [row.fileId!]);
            await tx.mediaJob.update({
              where: { id: origin.id },
              data: {
                output: json({ ...AssetJobOutputSchema.parse(origin.output), content: legacy }),
              },
            });
            await tx.storeAssetInsight.update({ where: { id: row.id }, data: { content: legacy } });
          });
          await reprocess(facts, ["digest"]);
          h.fake.llm.resetCalls();
          await digest(facts);
          expect(h.fake.llm.callsOf("summarizeAsset")).toHaveLength(1);
          expect(
            (
              h.fake.llm.callsOf("summarizeAsset")[0]!.input as Parameters<
                LlmProvider["summarizeAsset"]
              >[0]
            ).text,
          ).toContain(legacy.description);
          expect((await visions(facts.assetId))[0]!.content).toEqual(legacy);
        }
      }
    },
  );
});

describe("the shared parent hook preserves nonvision concrete job locks", () => {
  it.each(["current-audit", "old-run-audit"] as const)(
    "%s enters a real cache parent graph without borrowing a vision400 lock",
    async (scenario) => {
      const source = await ready();
      await run(source);
      await digest(source);
      const sourceInsight = (await visions(source.assetId))[0]!;
      const files = [
        await stored("image", h.merchant, source.files[0]),
        await stored("image", h.merchant, source.files[0]),
      ];
      const created = await h.media.assets.create(h.owner, {
        type: "image",
        fileIds: files.map((file) => file.id),
      });
      const audits = await h.prisma.mediaJob.findMany({
        where: { parentId: created.storeAssetId, kind: "audit_image_wx" },
        orderBy: { subjectId: "asc" },
      });
      expect(audits).toHaveLength(2);
      await h.media.jobs.run({ jobId: audits[0]!.id });
      const active = await h.prisma.mediaJob.findMany({
        where: { parentId: created.storeAssetId, kind: "vision", state: "queued" },
      });
      expect(active).toHaveLength(1);
      expect((await jobRow(audits[1]!.id)).state).toBe("queued");
      const facts = { assetId: created.storeAssetId, jobs: active, files, actor: h.owner };
      const before = await allInsights(facts.assetId);
      const newest = scenario === "old-run-audit" ? await supersede(facts) : null;
      signing.mockClear();
      model.mockClear();
      await h.media.jobs.run({ jobId: audits[1]!.id });
      expect(signing).not.toHaveBeenCalled();
      expect(model).not.toHaveBeenCalled();
      expect(await jobRow(audits[1]!.id)).toMatchObject({
        state: newest ? "canceled" : "succeeded",
        leaseOwner: null,
      });
      if (newest) {
        expect(await allInsights(facts.assetId)).toEqual(before);
        expect(await jobRow(newest.id)).toMatchObject({ state: "queued", attemptNo: 0 });
      } else {
        const queued = await h.prisma.mediaJob.findMany({
          where: { parentId: facts.assetId, kind: "vision", state: "queued" },
        });
        expect(queued).toHaveLength(2);
        h.permitControlledModel(false);
        try {
          await run({ ...facts, jobs: queued });
        } finally {
          h.permitControlledModel(true);
        }
        const installed = await visions(facts.assetId);
        expect(installed).toHaveLength(2);
        for (const row of installed)
          expect(row.reusedFromStoreAssetInsightId).toBe(sourceInsight.id);
        expect(signing).not.toHaveBeenCalled();
        expect(model).not.toHaveBeenCalled();
      }
      expect(await visions(source.assetId)).toMatchObject([
        { id: sourceInsight.id, content: visible() },
      ]);
    },
  );
});
