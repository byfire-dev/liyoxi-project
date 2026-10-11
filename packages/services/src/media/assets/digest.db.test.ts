import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileObject, MediaJob, Prisma, StoreAssetInsight } from "@liyoxi/db";
import { assertNotInTransaction, lockRows, uuidv7 } from "../../kernel/index.js";
import {
  connectTestDatabase,
  configTestStaffBriefs,
  createMediaAssetsHarness,
  useSeededDatabase,
} from "../../testing/index.js";
import { createConfig, createConfigAdmin } from "../../config/index.js";
import { failed, ok } from "../../providers/types.js";
import type { LlmDigest, LlmProvider } from "../../providers/types.js";
import { createMediaJobs } from "../index.js";
import type { JobJson, JobOutcome } from "../jobs/types.js";
import type { AssetDeps } from "./context.js";
import { createAssetDigestStrategy } from "./digest.js";
import {
  advanceAsset,
  AssetJobInputSchema,
  AssetJobOutputSchema,
  assetJobOwned,
} from "./pipeline.js";
import { assetFileSteps } from "./steps.js";
import type { AssetType } from "./steps.js";
import { visionContent } from "./vision.js";

// Real Tx/locks, public asset registration, job runner, insight and outbox writes.
// Controlled historical source rows below are lawful provenance fixtures, not cloud evidence.
const database = useSeededDatabase("services");
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
beforeAll(async () => {
  h = await createMediaAssetsHarness(await database.prisma());
  const admin = createConfigAdmin({
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    config: createConfig({ db: h.prisma, clock: h.clock, redis: null }),
    staffBriefs: configTestStaffBriefs,
  });
  for (const dimension of ["usage", "timeliness"] as const)
    await admin.createDictItem(
      { identity: h.admin.identity, staff: h.admin.staff! },
      { typeKey: "asset_tag", name: `摘要测试${dimension}`, ext: { dimension } },
    );
}, 120_000);
beforeEach(() => {
  h.permitControlledModel(true);
  h.fake.llm.resetCalls();
  h.fake.llm.digestReplies.length = 0;
  h.fake.llm.tagReplies.length = 0;
  h.fake.llm.visionReplies.length = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  h.fake.llm.visionReplies.length = 0;
});
afterAll(async () => h?.close());

const json = (value: unknown) => value as Prisma.InputJsonValue;
// Explicit complete model fixture; production never fills missing Digest fields.
const summary = (keypoints: readonly string[]): LlmDigest => ({
  title: "",
  keypoints: [...keypoints],
  contentTags: [],
  suggestedUsage: [],
  faceHint: "none",
  qualityNotes: [],
});
const row = (id: string) => h.prisma.mediaJob.findUniqueOrThrow({ where: { id } });
const asset = (id: string) => h.prisma.storeAsset.findUniqueOrThrow({ where: { id } });
const insights = (id: string) =>
  h.prisma.storeAssetInsight.findMany({
    where: { storeAssetId: id, kind: "digest" },
    orderBy: { id: "asc" },
  });
const events = (id: string) =>
  h.prisma.outboxEvent.findMany({
    where: { aggregateId: id },
    orderBy: { id: "asc" },
  });
function deps(overrides: Partial<AssetDeps["assets"]> = {}): AssetDeps {
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
const handler = () => h.media.jobs.handlers.get("digest")!;
const strategy = (overrides: Partial<AssetDeps["assets"]> = {}) =>
  createAssetDigestStrategy(deps(overrides), handler().current);
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
type Source = { origin: MediaJob; insight: StoreAssetInsight };
type Facts = { assetId: string; job: MediaJob; files: FileObject[]; sources: Source[] };
async function readyText(textBody = "门店每天现场制作。招牌菜使用公开虚构食材。"): Promise<Facts> {
  const created = await h.media.assets.create(h.owner, { type: "text", textBody });
  const audit = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentId: created.storeAssetId, kind: "audit_text" },
  });
  await h.media.jobs.run({ jobId: audit.id });
  const job = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentId: created.storeAssetId, kind: "digest" },
  });
  expect(job).toMatchObject({ state: "queued", attemptNo: 0, provider: "fake", mode: "local" });
  return { assetId: created.storeAssetId, job, files: [], sources: [] };
}
async function claim(facts: Facts) {
  // An explicit live claim exercises strategy admission without bypassing its DB rereads.
  return h.prisma.mediaJob.update({
    where: { id: facts.job.id },
    data: {
      state: "running",
      attemptNo: 1,
      leaseOwner: `digest-test:${uuidv7()}`,
      startedAt: h.clock.now(),
      nextRunAt: new Date(h.clock.now().getTime() + 120_000),
    },
  });
}
async function supersede(facts: Facts) {
  // A lawful historical replacement run, not a claim that public reprocess interrupts IO.
  const input = AssetJobInputSchema.parse(facts.job.input),
    runId = uuidv7();
  h.clock.advance(1);
  return h.prisma.mediaJob.create({
    data: {
      id: uuidv7(),
      kind: "digest",
      provider: facts.job.provider,
      mode: "local",
      parentType: "store_asset",
      parentId: facts.assetId,
      subjectType: "store_asset",
      subjectId: facts.assetId,
      dedupeKey: `asset:${facts.assetId}:${runId}:digest:text:v${input.promptVersion}`,
      input: json({ ...input, runId, selected: ["digest"] }),
      state: "queued",
      maxAttempts: 3,
      nextRunAt: h.clock.now(),
      deadlineAt: new Date(h.clock.now().getTime() + 900_000),
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
}
async function output(facts: Facts) {
  await h.media.jobs.run({ jobId: facts.job.id });
  const written = await row(facts.job.id);
  expect(written).toMatchObject({
    state: "succeeded",
    attemptNo: 1,
    leaseOwner: null,
    isRetryable: false,
  });
  return AssetJobOutputSchema.parse(written.output);
}
const document = (text: string, truncated = false) => ({
  text,
  truncated,
  charCount: Array.from(text).length,
});
const transcript = (text: string) => ({
  text,
  durationSec: 10,
  segments: [{ text, fromMs: 0, toMs: 1000 }],
});
const vision = (description: string) => ({ description, tags: [] });
async function contentCode(dimension = "content") {
  const rows = await h.prisma.dictItem.findMany({
    where: { dictTypeKey: "asset_tag", isEnabled: true },
  });
  const found = rows.find((item) => (item.ext as { dimension?: string })?.dimension === dimension);
  if (!found) throw new Error(`fixture has no ${dimension} tag`);
  return found.code;
}
async function tag(assetId: string) {
  return h.prisma.storeAssetTag.create({
    data: {
      id: uuidv7(),
      storeAssetId: assetId,
      dimension: "content",
      tagCode: await contentCode(),
      source: "uploader",
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
}
async function stored(ext: string, merchant = h.merchant) {
  const body = Buffer.from(`公开虚构来源 ${uuidv7()}`),
    key = `test/${uuidv7()}.${ext}`;
  const mime = ext === "txt" ? "text/plain" : ext === "png" ? "image/png" : "video/mp4";
  h.fake.storage.put({ bucket: "asset", key }, body, mime);
  const head = await h.fake.storage.head({ bucket: "asset", key });
  if (!head.ok || !head.value.exists || !head.value.etag) throw new Error("fixture object missing");
  return h.make.fileObject({
    bucket: "asset",
    category: "store_asset",
    scopeType: "store",
    entityId: merchant.entity.id,
    storeId: merchant.store.id,
    uploadActorType: "merchant",
    uploadActorId: merchant.user.id,
    uploadClient: "weapp",
    ext,
    objectKey: key,
    declaredSize: BigInt(body.length),
    sizeBytes: BigInt(body.length),
    declaredMime: mime,
    mime,
    etag: head.value.etag,
    crc64: "12345",
    sha256: createHash("sha256").update(body).digest("hex"),
    moderationState: "pass",
  });
}
async function readySources(
  type: Exclude<AssetType, "text" | "recording"> = "image",
  bodies = ["门店开放式厨房与招牌菜展示"],
  note = "",
): Promise<Facts> {
  const ext =
    type === "document" ? "txt" : type === "image" ? "png" : type === "audio" ? "wav" : "mp4";
  const files: FileObject[] = [];
  for (const _body of bodies) files.push(await stored(ext));
  const created = await h.media.assets.create(h.owner, {
    type,
    fileIds: files.map((file) => file.id),
    note,
  });
  const first = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentId: created.storeAssetId },
  });
  const base = AssetJobInputSchema.parse(first.input),
    sources: Source[] = [];
  for (const [index, file] of files.entries()) {
    for (const kind of assetFileSteps(type, true)) {
      const sourceKind =
        kind === "asr"
          ? "transcript"
          : kind === "vision"
            ? "vision"
            : kind === "doc_extract"
              ? "doc_text"
              : null;
      const content =
        sourceKind === "transcript"
          ? transcript(bodies[index]!)
          : sourceKind === "vision"
            ? vision(bodies[index]!)
            : sourceKind === "doc_text"
              ? document(bodies[index]!)
              : {};
      const input = {
        ...base,
        fileId: file.id,
        etag: file.etag,
        crc64: file.crc64,
        sizeBytes: file.sizeBytes!.toString(),
      };
      const dedupeKey = `asset:${created.storeAssetId}:${base.runId}:${kind}:${file.id}:v${base.promptVersion}`;
      const old = await h.prisma.mediaJob.findUnique({ where: { dedupeKey } });
      const result = {
        status: sourceKind ? "ok" : "skipped",
        reason: sourceKind ? null : "historical_fixture",
        content,
        verdict: null,
      };
      const data = {
        kind,
        provider: kind === "doc_extract" || kind === "probe" ? "mediatool" : "fake",
        mode: ["audit_image_wx", "audit_video", "asr"].includes(kind) ? "remote" : "local",
        parentType: "store_asset",
        parentId: created.storeAssetId,
        subjectType: "file_object",
        subjectId: file.id,
        input: json(input),
        output: json(result),
        state: "succeeded",
        attemptNo: 1,
        finishedAt: h.clock.now(),
        leaseOwner: null,
        updatedAt: h.clock.now(),
      };
      const origin = old
        ? await h.prisma.mediaJob.update({ where: { id: old.id }, data })
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
      if (sourceKind)
        sources.push({
          origin,
          insight: await h.prisma.storeAssetInsight.create({
            data: {
              id: uuidv7(),
              storeAssetId: created.storeAssetId,
              fileId: file.id,
              kind: sourceKind,
              promptVersion: base.promptVersion,
              provider: origin.provider,
              mediaJobId: origin.id,
              status: "ok",
              content: json(content),
              createdAt: h.clock.now(),
              updatedAt: h.clock.now(),
            },
          }),
        });
    }
  }
  await h.tx.run(async (tx) => {
    await lockRows(tx, "store_asset", [created.storeAssetId]);
    await advanceAsset(tx, deps(), created.storeAssetId);
  });
  const job = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentId: created.storeAssetId, kind: "digest" },
  });
  expect(job.state).toBe("queued");
  return { assetId: created.storeAssetId, job, files, sources };
}
async function replaceSource(source: Source, content: Record<string, JobJson>) {
  const before = AssetJobOutputSchema.parse((await row(source.origin.id)).output);
  await h.prisma.mediaJob.update({
    where: { id: source.origin.id },
    data: { output: json({ ...before, content }) },
  });
  await h.prisma.storeAssetInsight.update({
    where: { id: source.insight.id },
    data: { content: json(content) },
  });
}
function success(outcome: JobOutcome) {
  expect(outcome.state).toBe("succeeded");
  if (outcome.state !== "succeeded") throw new Error("expected digest output");
  return AssetJobOutputSchema.parse(outcome.output);
}
async function held(
  facts: Facts,
  mutation: () => Promise<unknown>,
  publicRun = false,
  observed: string[] = [],
) {
  const entered = gate(),
    release = gate();
  const call = vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async (input) => {
    assertNotInTransaction("digest model IO");
    expect(input.signal).toBeInstanceOf(AbortSignal);
    observed.push(input.text);
    entered.release();
    await release.promise;
    return ok(summary(["公开虚构摘要要点"]));
  });
  const running = publicRun
    ? h.media.jobs.run({ jobId: facts.job.id })
    : strategy().execute(await claim(facts), new AbortController().signal);
  void running.catch(() => undefined);
  try {
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce(), { timeout: 3000 });
    await entered.promise;
    await mutation();
  } finally {
    release.release();
  }
  return running;
}

describe("digest public jobs and manual fallback", () => {
  it("audits real text, sends the same signal outside Tx, and stores six bounded Unicode points once", async () => {
    const facts = await readyText(),
      points = Array.from({ length: 6 }, (_, index) => `${index}${"😀".repeat(59)}`);
    const call = vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async (input) => {
      assertNotInTransaction("public digest model IO");
      expect(input).toMatchObject({
        text: (await asset(facts.assetId)).textBody,
        vocabulary: expect.any(Object),
      });
      expect(input.signal).toBeInstanceOf(AbortSignal);
      return ok(summary(points));
    });
    const result = await output(facts);
    expect(result).toMatchObject({
      status: "ok",
      reason: null,
      verdict: null,
      content: { keypoints: points, partial: false },
    });
    expect(result.content.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(result.content).sort()).toEqual([
      "contentTags",
      "faceHint",
      "keypoints",
      "partial",
      "qualityNotes",
      "sourceHash",
      "suggestedUsage",
      "title",
    ]);
    expect(points.every((point) => Array.from(point).length === 60)).toBe(true);
    expect(await asset(facts.assetId)).toMatchObject({
      processingState: "processed",
      reviewState: "unreviewed",
      usability: null,
      isInsightPartial: false,
    });
    const saved = await insights(facts.assetId),
      emitted = await events(facts.assetId),
      written = await row(facts.job.id);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      status: "ok",
      content: summary(points),
      mediaJobId: facts.job.id,
    });
    expect(emitted.filter((event) => event.eventType === "asset.processed")).toHaveLength(1);
    expect(emitted.filter((event) => event.eventType === "asset.review_needed")).toHaveLength(1);
    expect(
      await h.prisma.storeAssetTag.findMany({ where: { storeAssetId: facts.assetId } }),
    ).toEqual([]);
    await h.media.jobs.run({ jobId: facts.job.id });
    expect(await row(facts.job.id)).toEqual(written);
    expect(await insights(facts.assetId)).toEqual(saved);
    expect(await events(facts.assetId)).toEqual(emitted);
    expect(call).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(emitted, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ).not.toContain(points[0]);
  });

  it("real image vision output is accepted with its actual producing job", async () => {
    const file = await h.stored();
    await h.prisma.fileObject.update({ where: { id: file.id }, data: { moderationState: "pass" } });
    const created = await h.media.assets.create(h.owner, {
      type: "image",
      fileIds: [file.id],
      note: "拍摄开放式厨房",
    });
    const audit = await h.prisma.mediaJob.findFirstOrThrow({
      where: { parentId: created.storeAssetId, kind: "audit_image_wx" },
    });
    await h.media.jobs.run({ jobId: audit.id });
    h.fake.llm.visionReplies.push({
      description: "公开虚构厨房正在现场制作",
      quality: "公开虚构清晰画面",
      hasPeople: false,
      identifiableCustomerFace: false,
      textInImage: "",
    });
    vi.spyOn(h.fake.storage, "presignVisionGet").mockResolvedValue(
      ok({
        url: "https://public.invalid/vision.jpg",
        expiresAt: new Date(h.clock.now().getTime() + 900_000),
      }),
    );
    const origin = await h.prisma.mediaJob.findFirstOrThrow({
      where: { parentId: created.storeAssetId, kind: "vision" },
    });
    await h.media.jobs.run({ jobId: origin.id });
    h.fake.llm.digestReplies.push(summary(["现场制作展示"]));
    const job = await h.prisma.mediaJob.findFirstOrThrow({
      where: { parentId: created.storeAssetId, kind: "digest" },
    });
    const result = await output({ assetId: created.storeAssetId, job, files: [file], sources: [] });
    expect(result).toMatchObject({
      status: "ok",
      content: { partial: false, keypoints: ["现场制作展示"] },
    });
    const source = await h.prisma.storeAssetInsight.findFirstOrThrow({
      where: { storeAssetId: created.storeAssetId, kind: "vision" },
    });
    expect(source.mediaJobId).toBe(origin.id);
    expect(
      visionContent(AssetJobOutputSchema.parse((await row(origin.id)).output).content),
    ).toEqual(source.content);
    expect(h.fake.llm.callsOf("summarizeAsset")[0]!.input).toMatchObject({
      text: "拍摄开放式厨房\nvision: description: 公开虚构厨房正在现场制作\nquality: 公开虚构清晰画面\ntextInImage: \nhasPeople: false\nidentifiableCustomerFace: false",
      vocabulary: expect.any(Object),
    });
  });

  it("missing budget settles once as partial and leaves the actual human review available", async () => {
    const facts = await readyText();
    h.permitControlledModel(false);
    expect(await output(facts)).toMatchObject({
      status: "skipped",
      reason: "budget_unconfigured",
      content: {},
    });
    expect(h.fake.llm.calls).toEqual([]);
    expect(await asset(facts.assetId)).toMatchObject({
      processingState: "processed",
      isInsightPartial: true,
      reviewState: "unreviewed",
      usability: null,
    });
    expect((await insights(facts.assetId))[0]).toMatchObject({
      status: "skipped",
      content: { reason: "budget_unconfigured" },
    });
    const reviewEvent = (await events(facts.assetId)).find(
      (event) => event.eventType === "asset.review_needed",
    );
    expect(reviewEvent).toBeDefined();
    await h.media.assets.review(h.admin, facts.assetId, {
      lockVersion: (await asset(facts.assetId)).lockVersion,
      title: "人工确认公开虚构素材",
      contentTagCodes: [await contentCode()],
      usageTagCodes: [await contentCode("usage")],
      timeliness: { tagCode: await contentCode("timeliness") },
      usability: "ready",
    });
    expect(await asset(facts.assetId)).toMatchObject({
      reviewState: "reviewed",
      usability: "ready",
      isInsightPartial: true,
    });
  });

  it.each([
    { name: "empty", value: { points: [] } },
    { name: "seven", value: summary(Array.from({ length: 7 }, () => "要点")) },
    { name: "61 codepoints", value: summary(["😀".repeat(61)]) },
    { name: "whitespace", value: { points: [" \n\t"] } },
    { name: "non string", value: { points: [7] } },
    { name: "extra invented tags", value: { ...summary(["要点"]), tags: ["广告"] } },
    { name: "missing DTO", value: { keypoints: ["要点"] } },
  ])(
    "$name model DTO becomes a controlled skip without retry or invented fields",
    async ({ value }) => {
      const facts = await readyText();
      vi.spyOn(h.fake.llm, "summarizeAsset").mockResolvedValue(
        ok(value) as Awaited<ReturnType<LlmProvider["summarizeAsset"]>>,
      );
      expect(await output(facts)).toMatchObject({
        status: "skipped",
        reason: "digest_result_invalid",
        content: {},
      });
      expect(await asset(facts.assetId)).toMatchObject({
        isInsightPartial: true,
        reviewState: "unreviewed",
        usability: null,
      });
      expect((await insights(facts.assetId))[0]).toMatchObject({
        status: "skipped",
        content: { reason: "digest_result_invalid" },
      });
    },
  );

  it.each(["unavailable", "rejected", "throw"] as const)(
    "provider %s does not enter generic automatic retries",
    async (reason) => {
      const facts = await readyText(),
        call = vi.spyOn(h.fake.llm, "summarizeAsset");
      if (reason === "throw")
        call.mockRejectedValue(new Error("public fictional provider failure"));
      else call.mockResolvedValue(failed(reason, "public fictional provider failure"));
      expect(await output(facts)).toMatchObject({
        status: "skipped",
        reason: "digest_unavailable",
      });
      expect(await row(facts.job.id)).toMatchObject({
        errorCode: null,
        attemptNo: 1,
        isRetryable: false,
      });
      await h.media.jobs.run({ jobId: facts.job.id });
      expect(call).toHaveBeenCalledOnce();
      expect(await insights(facts.assetId)).toHaveLength(1);
    },
  );

  it("model admission exceptions are caught before IO", async () => {
    const facts = await readyText(),
      job = await claim(facts);
    const allowModelCall = vi
      .fn<NonNullable<AssetDeps["assets"]["allowModelCall"]>>()
      .mockRejectedValue(new Error("budget unavailable"));
    const result = await strategy({ allowModelCall }).execute(job, new AbortController().signal);
    expect(success(result)).toMatchObject({ status: "skipped", reason: "digest_unavailable" });
    expect(allowModelCall).toHaveBeenCalledOnce();
    expect(h.fake.llm.calls).toEqual([]);
  });

  it("an unconfigured provider and absent admission callback each skip without IO", async () => {
    const facts = await readyText();
    const unconfiguredLlm: LlmProvider = {
      ...h.fake.llm,
      status: "unconfigured",
      configured: false,
    };
    await h.prisma.mediaJob.update({
      where: { id: facts.job.id },
      data: { provider: "unconfigured" },
    });
    const job = await claim(facts);
    expect(
      success(await strategy({ llm: unconfiguredLlm }).execute(job, new AbortController().signal)),
    ).toMatchObject({ reason: "llm_unconfigured", status: "skipped" });
    expect(
      success(
        await strategy({ llm: unconfiguredLlm, allowModelCall: undefined }).execute(
          job,
          new AbortController().signal,
        ),
      ),
    ).toMatchObject({ reason: "budget_unconfigured", status: "skipped" });
    expect(h.fake.llm.calls).toEqual([]);
  });
});

describe("digest uses complete current source provenance", () => {
  it("a real note provides partial body evidence despite missing vision, while codes remain context", async () => {
    const facts = await readySources("image", ["公开虚构菜品"], "公开虚构拍摄说明");
    const code = await tag(facts.assetId);
    await h.prisma.storeAssetInsight.delete({ where: { id: facts.sources[0]!.insight.id } });
    h.fake.llm.digestReplies.push(summary(["公开虚构说明要点"]));
    expect(await output(facts)).toMatchObject({
      status: "ok",
      content: { partial: true, keypoints: ["公开虚构说明要点"] },
    });
    expect(h.fake.llm.callsOf("summarizeAsset")).toHaveLength(1);
    expect(h.fake.llm.callsOf("summarizeAsset")[0]!.input).toMatchObject({
      text: `公开虚构拍摄说明\n${code.tagCode}`,
    });
    expect(await asset(facts.assetId)).toMatchObject({
      processingState: "processed",
      isInsightPartial: true,
      usability: null,
    });
  });

  it("uses ordered current sources, uploader codes and note, while a missing file source remains partial", async () => {
    const facts = await readySources("image", ["公开虚构菜品", "公开虚构环境"], "公开虚构拍摄说明"),
      code = await tag(facts.assetId);
    await h.prisma.storeAssetInsight.delete({ where: { id: facts.sources[1]!.insight.id } });
    h.fake.llm.digestReplies.push(summary(["菜品展示"]));
    expect(await output(facts)).toMatchObject({
      status: "ok",
      content: { partial: true, keypoints: ["菜品展示"] },
    });
    expect(h.fake.llm.callsOf("summarizeAsset")[0]!.input).toMatchObject({
      text: `公开虚构拍摄说明\n${code.tagCode}\nvision: 公开虚构菜品`,
    });
    expect(await asset(facts.assetId)).toMatchObject({ isInsightPartial: true });
  });

  it.each([
    "no origin",
    "nonterminal origin",
    "other run",
    "other prompt",
    "foreign parent",
    "forged dedupe",
    "wrong kind",
    "different output",
    "different provider",
    "old file etag",
    "old file crc",
    "old file size",
    "old insight prompt",
  ])("%s cannot masquerade as usable provenance", async (defect) => {
    const facts = await readySources(),
      source = facts.sources[0]!,
      input = AssetJobInputSchema.parse(source.origin.input);
    const updateOrigin = (data: Prisma.MediaJobUpdateInput) =>
      h.prisma.mediaJob.update({ where: { id: source.origin.id }, data });
    const updateInsight = (data: Prisma.StoreAssetInsightUpdateInput) =>
      h.prisma.storeAssetInsight.update({ where: { id: source.insight.id }, data });
    if (defect === "no origin") {
      await tag(facts.assetId);
      await updateInsight({ mediaJob: { disconnect: true } });
    }
    if (defect === "nonterminal origin") await updateOrigin({ state: "queued", finishedAt: null });
    if (defect === "other run" || defect === "other prompt") {
      const runId = defect === "other run" ? uuidv7() : input.runId;
      const promptVersion =
        defect === "other prompt" ? input.promptVersion + 1 : input.promptVersion;
      await updateOrigin({
        input: json({ ...input, runId, promptVersion }),
        dedupeKey: `asset:${facts.assetId}:${runId}:vision:${input.fileId}:v${promptVersion}`,
      });
    }
    if (defect === "foreign parent") {
      const other = await readySources();
      await updateInsight({ mediaJob: { connect: { id: other.sources[0]!.origin.id } } });
    }
    if (defect === "forged dedupe") await updateOrigin({ dedupeKey: `foreign:${uuidv7()}` });
    if (defect === "wrong kind") await updateOrigin({ kind: "ocr" });
    if (defect === "different output")
      await updateInsight({ content: vision("伪造且没有真实生产输出的说明") });
    if (defect === "different provider") await updateInsight({ provider: "other-provider" });
    if (defect === "old file etag")
      await updateOrigin({ input: json({ ...input, etag: "old-etag" }) });
    if (defect === "old file crc")
      await updateOrigin({ input: json({ ...input, crc64: "98765" }) });
    if (defect === "old file size")
      await updateOrigin({ input: json({ ...input, sizeBytes: "9999" }) });
    if (defect === "old insight prompt")
      await updateInsight({ promptVersion: input.promptVersion + 1 });
    expect(await output(facts)).toMatchObject({
      status: "skipped",
      reason: "digest_source_missing",
    });
    expect(h.fake.llm.calls).toEqual([]);
    expect((await insights(facts.assetId))[0]).toMatchObject({ status: "skipped" });
  });

  it.each(["blocked", "deleted", "other entity", "other category"])(
    "a linked %s file prevents model admission",
    async (condition) => {
      const facts = await readySources(),
        file = facts.files[0]!;
      if (condition === "blocked")
        await h.prisma.fileObject.update({
          where: { id: file.id },
          data: { moderationState: "block" },
        });
      if (condition === "deleted")
        await h.prisma.fileObject.update({
          where: { id: file.id },
          data: { status: "deleted", deletedAt: h.clock.now() },
        });
      if (condition === "other entity" || condition === "other category") {
        const replacement =
          condition === "other entity"
            ? await stored("png", await h.make.merchant({ verified: true }))
            : await h.stored(h.owner, "portrait_auth");
        await h.prisma.storeAssetFile.update({
          where: { storeAssetId_position: { storeAssetId: facts.assetId, position: 1 } },
          data: { fileId: replacement.id },
        });
      }
      const result = await strategy().execute(await claim(facts), new AbortController().signal);
      expect(result).toEqual({ state: "canceled" });
      expect(h.fake.llm.calls).toEqual([]);
      expect(await insights(facts.assetId)).toEqual([]);
    },
  );

  it.each([
    { type: "audio" as const, limit: 6000, prefix: "transcript", character: "😀" },
    { type: "document" as const, limit: 8000, prefix: "doc_text", character: "文" },
  ])(
    "$type truncates the complete source set to $limit codepoints, not per file",
    async ({ type, limit, prefix, character }) => {
      const text = character.repeat(limit / 2 + 1),
        facts = await readySources(type, [text, text], "");
      h.fake.llm.digestReplies.push(summary(["公开虚构长来源要点"]));
      const result = await output(facts),
        input = h.fake.llm.callsOf("summarizeAsset")[0]!.input as Parameters<
          LlmProvider["summarizeAsset"]
        >[0];
      expect(input.text).toBe(`${prefix}: ${text}\n${prefix}: ${character.repeat(limit / 2 - 1)}`);
      expect(Array.from(input.text.replaceAll(`${prefix}: `, "").replaceAll("\n", "")).length).toBe(
        limit,
      );
      expect(result).toMatchObject({ status: "ok", content: { partial: true } });
      expect(await asset(facts.assetId)).toMatchObject({ isInsightPartial: true, usability: null });
      if (type === "document") {
        const structured = await h.prisma.storeAssetInsight.findMany({
          where: { storeAssetId: facts.assetId, kind: "structured_items" },
        });
        // A valid aggregate DTO is not an extraction result attributed to each file.
        expect(structured).toEqual([]);
        expect((await insights(facts.assetId))[0]?.content).toEqual(
          summary(["公开虚构长来源要点"]),
        );
      }
    },
  );

  it("an extractor-truncated document remains explicitly partial", async () => {
    const facts = await readySources("document", ["文".repeat(10000)], ""),
      source = facts.sources[0]!;
    await replaceSource(source, { text: "文".repeat(10000), truncated: true, charCount: 12000 });
    h.fake.llm.digestReplies.push(summary(["公开虚构文档要点"]));
    expect(await output(facts)).toMatchObject({ status: "ok", content: { partial: true } });
  });

  it("caps all model input at 16000 Unicode codepoints and the provider UTF8 byte ceiling", async () => {
    const facts = await readySources(
      "video",
      Array.from({ length: 9 }, () => "文".repeat(2000)),
      "",
    );
    h.fake.llm.digestReplies.push(summary(["公开虚构视频要点"]));
    const result = await output(facts),
      input = h.fake.llm.callsOf("summarizeAsset")[0]!.input as Parameters<
        LlmProvider["summarizeAsset"]
      >[0];
    expect(Array.from(input.text)).toHaveLength(16000);
    expect(Buffer.byteLength(input.text)).toBeLessThanOrEqual(64 * 1024);
    expect(result).toMatchObject({ status: "ok", content: { partial: true } });
  });
});

describe("digest fresh lease and source snapshots around IO", () => {
  it.each([
    "state",
    "attempt",
    "lease owner",
    "no owner",
    "expired lease",
    "deadline",
    "provider",
    "input",
  ])("fresh %s mismatch prevents IO", async (change) => {
    const facts = await readyText(),
      job = await claim(facts),
      input = AssetJobInputSchema.parse(job.input);
    const data: Prisma.MediaJobUpdateInput =
      change === "state"
        ? { state: "queued" }
        : change === "attempt"
          ? { attemptNo: 2 }
          : change === "lease owner"
            ? { leaseOwner: "winner" }
            : change === "no owner"
              ? { leaseOwner: null }
              : change === "expired lease"
                ? { nextRunAt: h.clock.now() }
                : change === "deadline"
                  ? { deadlineAt: h.clock.now() }
                  : change === "provider"
                    ? { provider: "other" }
                    : { input: json({ ...input, selected: ["digest"] }) };
    await h.prisma.mediaJob.update({ where: { id: job.id }, data });
    expect(await strategy().execute(job, new AbortController().signal)).toEqual({
      state: "canceled",
    });
    expect(h.fake.llm.calls).toEqual([]);
    expect(await insights(facts.assetId)).toEqual([]);
  });

  it.each(["new run", "deleted asset", "blocked asset"])(
    "%s invalidates the real current guard before IO",
    async (change) => {
      const facts = await readyText(),
        job = await claim(facts);
      if (change === "new run") await supersede(facts);
      else
        await h.prisma.storeAsset.update({
          where: { id: facts.assetId },
          data:
            change === "deleted asset"
              ? { deletedAt: h.clock.now() }
              : { moderationState: "block" },
        });
      expect(await strategy().execute(job, new AbortController().signal)).toEqual({
        state: "canceled",
      });
      expect(h.fake.llm.calls).toEqual([]);
    },
  );

  it.each([
    "text",
    "note",
    "tags",
    "source content",
    "origin output",
    "source attempt",
    "source providers",
    "etag",
    "sha256",
    "remove link",
    "add link",
  ])("%s changed during IO rejects the late result", async (change) => {
    const facts = change === "text" ? await readyText() : await readySources();
    const result = await held(facts, async () => {
      const source = facts.sources[0],
        file = facts.files[0];
      if (change === "text")
        return h.prisma.storeAsset.update({
          where: { id: facts.assetId },
          data: { textBody: "赢家更新的公开虚构正文" },
        });
      if (change === "note")
        return h.prisma.storeAsset.update({
          where: { id: facts.assetId },
          data: { note: "赢家的新说明" },
        });
      if (change === "tags") return tag(facts.assetId);
      if (change === "source content") return replaceSource(source!, vision("赢家来源新内容"));
      if (change === "origin output")
        return h.prisma.mediaJob.update({
          where: { id: source!.origin.id },
          data: {
            output: json({
              status: "ok",
              reason: null,
              content: vision("不同来源正文"),
              verdict: null,
            }),
          },
        });
      if (change === "source attempt")
        return h.prisma.mediaJob.update({
          where: { id: source!.origin.id },
          data: { attemptNo: 2 },
        });
      if (change === "source providers") {
        await h.prisma.mediaJob.update({
          where: { id: source!.origin.id },
          data: { provider: "replacement-provider" },
        });
        return h.prisma.storeAssetInsight.update({
          where: { id: source!.insight.id },
          data: { provider: "replacement-provider" },
        });
      }
      if (change === "etag" || change === "sha256")
        return h.prisma.fileObject.update({
          where: { id: file!.id },
          data: change === "etag" ? { etag: "winner-etag" } : { sha256: "b".repeat(64) },
        });
      if (change === "remove link")
        return h.prisma.storeAssetFile.delete({
          where: { storeAssetId_position: { storeAssetId: facts.assetId, position: 1 } },
        });
      const added = await stored("png");
      return h.prisma.storeAssetFile.create({
        data: {
          storeAssetId: facts.assetId,
          fileId: added.id,
          position: 2,
          createdAt: h.clock.now(),
        },
      });
    });
    expect(result).toEqual({ state: "canceled" });
    expect(await insights(facts.assetId)).toEqual([]);
  });

  it.each([
    { type: "audio" as const, limit: 6000, content: transcript },
    { type: "document" as const, limit: 8000, content: document },
  ])("$type hashes source suffixes discarded by projection", async ({ type, limit, content }) => {
    const facts = await readySources(type, ["甲".repeat(limit) + "旧"], ""),
      source = facts.sources[0]!;
    const observed: string[] = [];
    const result = await held(
      facts,
      () => replaceSource(source, content("甲".repeat(limit) + "新")),
      false,
      observed,
    );
    expect(result).toEqual({ state: "canceled" });
    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toContain("旧");
    expect(observed[0]).not.toContain("新");
    expect(await insights(facts.assetId)).toEqual([]);
  });

  it.each(["lease", "attempt", "deadline", "new run"])(
    "%s winner during IO suppresses settlement",
    async (change) => {
      const facts = await readyText();
      const result = await held(facts, () =>
        change === "new run"
          ? supersede(facts)
          : h.prisma.mediaJob.update({
              where: { id: facts.job.id },
              data:
                change === "lease"
                  ? { leaseOwner: "winning-worker" }
                  : change === "attempt"
                    ? { attemptNo: 2 }
                    : { deadlineAt: h.clock.now() },
            }),
      );
      expect(result).toEqual({ state: "canceled" });
      expect(await insights(facts.assetId)).toEqual([]);
    },
  );

  it("abort before admission and an abort-ignoring late model both return canceled", async () => {
    const facts = await readyText(),
      job = await claim(facts),
      controller = new AbortController();
    controller.abort("fixture abort");
    expect(await strategy().execute(job, controller.signal)).toEqual({ state: "canceled" });
    expect(h.fake.llm.calls).toEqual([]);
    const live = new AbortController(),
      release = gate();
    const call = vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async (input) => {
      assertNotInTransaction("abort-ignoring fixture IO");
      expect(input.signal).toBe(live.signal);
      await release.promise;
      return ok(summary(["不能采纳的晚结果"]));
    });
    const running = strategy().execute(job, live.signal);
    try {
      await vi.waitFor(() => expect(call).toHaveBeenCalledOnce(), { timeout: 3000 });
      live.abort("late abort");
    } finally {
      release.release();
    }
    expect(await running).toEqual({ state: "canceled" });
    expect(await insights(facts.assetId)).toEqual([]);
  });

  it("a public source-change cancellation writes no digest and converges to partial manual review", async () => {
    const facts = await readyText();
    await held(
      facts,
      () =>
        h.prisma.storeAsset.update({
          where: { id: facts.assetId },
          data: { textBody: "公开虚构赢家正文" },
        }),
      true,
    );
    expect(await row(facts.job.id)).toMatchObject({ state: "canceled", leaseOwner: null });
    expect(await insights(facts.assetId)).toEqual([]);
    expect(await asset(facts.assetId)).toMatchObject({
      processingState: "processed",
      isInsightPartial: true,
      reviewState: "unreviewed",
      usability: null,
    });
    expect(
      (await events(facts.assetId)).filter((event) => event.eventType === "asset.review_needed"),
    ).toHaveLength(1);
  });
});

describe("digest real transaction and lock boundaries", () => {
  it("waits for an independent DB parent lock, then uses the committed winner's current text", async () => {
    const facts = await readyText(),
      holder = await connectTestDatabase(database.name),
      observer = await connectTestDatabase(database.name, { role: null });
    let running: Promise<void> | undefined;
    const call = vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async (input) => {
      assertNotInTransaction("lock-winner digest IO");
      expect(input.text).toBe("公开虚构锁赢家正文");
      return ok(summary(["锁赢家要点"]));
    });
    try {
      await holder.query("BEGIN");
      const pid = await holder.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid");
      await holder.query("SELECT id FROM store_asset WHERE id=$1::uuid FOR UPDATE", [
        facts.assetId,
      ]);
      running = h.media.jobs.run({ jobId: facts.job.id });
      void running.catch(() => undefined);
      await vi.waitFor(
        async () => {
          const blocked = await observer.query<{ count: string }>(
            "SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
            [pid.rows[0]!.pid],
          );
          expect(Number(blocked.rows[0]!.count)).toBeGreaterThan(0);
        },
        { timeout: 3000 },
      );
      expect(call).not.toHaveBeenCalled();
      await holder.query("UPDATE store_asset SET text_body=$2 WHERE id=$1::uuid", [
        facts.assetId,
        "公开虚构锁赢家正文",
      ]);
      await holder.query("COMMIT");
      await running;
      expect(call).toHaveBeenCalledOnce();
      expect((await insights(facts.assetId))[0]).toMatchObject({
        status: "ok",
        content: { keypoints: ["锁赢家要点"] },
      });
    } finally {
      await holder.query("ROLLBACK");
      await running;
      await holder.end();
      await observer.end();
    }
  });

  it("two real runner instances share one DB claim and never double-call the model", async () => {
    const facts = await readyText(),
      entered = gate(),
      release = gate();
    const second = createMediaJobs({
      tx: h.tx,
      clock: h.clock,
      ownerId: "digest-second-worker",
      handlers: [...h.media.jobs.handlers.values()],
      convergenceHandlers: [...h.media.jobs.convergence.values()],
    });
    const call = vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async () => {
      assertNotInTransaction("two-worker digest IO");
      entered.release();
      await release.promise;
      return ok(summary(["唯一摘要"]));
    });
    const running = h.media.jobs.run({ jobId: facts.job.id });
    try {
      await vi.waitFor(() => expect(call).toHaveBeenCalledOnce(), { timeout: 3000 });
      await entered.promise;
      await second.run({ jobId: facts.job.id });
      expect(call).toHaveBeenCalledOnce();
      expect(await insights(facts.assetId)).toEqual([]);
    } finally {
      release.release();
      await running;
      await second.shutdown();
    }
    expect(await row(facts.job.id)).toMatchObject({ state: "succeeded", attemptNo: 1 });
    expect(await insights(facts.assetId)).toHaveLength(1);
    expect(
      (await events(facts.assetId)).filter((event) => event.eventType === "asset.processed"),
    ).toHaveLength(1);
  });

  it("finish rereads the source hash after IO and rejects a third-window content winner", async () => {
    const facts = await readyText(),
      job = await claim(facts);
    h.fake.llm.digestReplies.push(summary(["公开虚构旧正文要点"]));
    const result = await strategy().execute(job, new AbortController().signal);
    expect(success(result).status).toBe("ok");
    await h.prisma.storeAsset.update({
      where: { id: facts.assetId },
      data: { textBody: "完成事务前的赢家正文" },
    });
    await h.tx.run(async (tx) => {
      await lockRows(tx, "store_asset", [facts.assetId]);
      await lockRows(tx, "media_job", [job.id]);
      const written = await tx.mediaJob.update({
        where: { id: job.id },
        data: {
          state: "succeeded",
          output: json(result.state === "succeeded" ? result.output : {}),
          finishedAt: h.clock.now(),
          leaseOwner: null,
        },
      });
      await handler().finish!(tx, written, result, h.admin.identity);
      await h.media.jobs.convergence.get("store_asset")!.converge(tx, facts.assetId, h.clock.now());
    });
    expect(await insights(facts.assetId)).toEqual([]);
    expect(await asset(facts.assetId)).toMatchObject({
      processingState: "processed",
      isInsightPartial: true,
      usability: null,
    });
  });

  it("a real outbox failure rolls back digest, terminal job and parent settlement together", async () => {
    const facts = await readyText(),
      beforeAsset = await asset(facts.assetId),
      beforeEvents = await events(facts.assetId);
    let claimed: MediaJob | undefined;
    vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async () => {
      assertNotInTransaction("rollback digest IO");
      claimed = await row(facts.job.id);
      return ok(summary(["公开虚构待回滚要点"]));
    });
    const emit = h.events.emit;
    vi.spyOn(h.events, "emit").mockImplementation(async (...args) => {
      await emit(...args);
      throw new Error("public fictional failure after actual outbox insert");
    });
    await expect(h.media.jobs.run({ jobId: facts.job.id })).rejects.toThrow(
      "after actual outbox insert",
    );
    expect(claimed).toBeDefined();
    expect(await row(facts.job.id)).toEqual(claimed);
    expect(await insights(facts.assetId)).toEqual([]);
    expect(await asset(facts.assetId)).toEqual(beforeAsset);
    expect(await events(facts.assetId)).toEqual(beforeEvents);
  });
});

describe("digest 文件锁等待后的新鲜准入", () => {
  it.each(["lease", "deadline"] as const)(
    "%s 在真实410锁等待期间到期，准入与模型都不调用",
    async (boundary) => {
      const facts = await readySources();
      const clockBefore = h.clock.now();
      await claim(facts);
      const job = await h.prisma.mediaJob.update({
        where: { id: facts.job.id },
        data: {
          nextRunAt: new Date(clockBefore.getTime() + (boundary === "lease" ? 1000 : 60_000)),
          deadlineAt: new Date(clockBefore.getTime() + (boundary === "deadline" ? 1000 : 60_000)),
        },
      });
      const admission = vi.fn(async () => true);
      const call = vi
        .spyOn(h.fake.llm, "summarizeAsset")
        .mockResolvedValue(ok(summary(["过期工作不应调用模型"])));
      const beforeEvents = await events(facts.assetId);
      const holder = await connectTestDatabase(database.name);
      const observer = await connectTestDatabase(database.name, { role: null });
      let running: Promise<JobOutcome> | undefined;
      try {
        await holder.query("BEGIN");
        const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid");
        await holder.query("SELECT id FROM file_object WHERE id=$1::uuid FOR UPDATE", [
          facts.files[0]!.id,
        ]);
        running = strategy({ allowModelCall: admission }).execute(
          job,
          new AbortController().signal,
        );
        void running.catch(() => undefined);
        await vi.waitFor(
          async () => {
            const blocked = await observer.query<{ count: string }>(
              "SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",
              [rows[0]!.pid],
            );
            expect(Number(blocked.rows[0]!.count)).toBeGreaterThan(0);
          },
          { timeout: 3000 },
        );
        expect(admission).not.toHaveBeenCalled();
        expect(call).not.toHaveBeenCalled();
        h.clock.advance(1001);
        await holder.query("COMMIT");
        expect(await running).toEqual({ state: "canceled" });
        expect(admission).not.toHaveBeenCalled();
        expect(call).not.toHaveBeenCalled();
        expect(await insights(facts.assetId)).toEqual([]);
        expect(await row(job.id)).toEqual(job);
        expect(await events(facts.assetId)).toEqual(beforeEvents);
      } finally {
        await holder.query("ROLLBACK");
        await running?.catch(() => undefined);
        h.clock.set(clockBefore);
        await Promise.all([holder.end(), observer.end()]);
      }
    },
    120_000,
  );
});

const REPROCESS_SOURCES = [
  { type: "image" as const, insightKind: "vision", jobKind: "vision" },
  { type: "audio" as const, insightKind: "transcript", jobKind: "asr" },
  { type: "document" as const, insightKind: "doc_text", jobKind: "doc_extract" },
] as const;

describe("digest 真实 public reprocess 的选中来源语义", () => {
  it.each(REPROCESS_SOURCES)(
    "$type 仅重跑digest保留旧run同prompt合法来源并生成新摘要",
    async ({ type, insightKind }) => {
      const marker = `公开虚构${type}此前真实来源正文`;
      const facts = await readySources(type, [marker], "");
      const first = await output(facts);
      expect(first.status).toBe("ok");
      expect(await asset(facts.assetId)).toMatchObject({ processingState: "processed" });
      const beforeSources = await Promise.all(
        facts.sources.map(async (source) => ({
          origin: await row(source.origin.id),
          insight: await h.prisma.storeAssetInsight.findUniqueOrThrow({
            where: { id: source.insight.id },
          }),
        })),
      );
      h.fake.llm.resetCalls();
      await h.media.assets.reprocess(h.admin, facts.assetId, { kinds: ["digest"] });
      const job = await h.prisma.mediaJob.findFirstOrThrow({
        where: { parentId: facts.assetId, kind: "digest", id: { not: facts.job.id } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      const input = AssetJobInputSchema.parse(job.input);
      expect(input.selected).toEqual(["digest"]);
      expect(input.runId).not.toBe(AssetJobInputSchema.parse(facts.job.input).runId);
      for (const source of beforeSources) {
        const original = AssetJobInputSchema.parse(source.origin.input);
        expect(original.runId).not.toBe(input.runId);
        expect(original.promptVersion).toBe(input.promptVersion);
        expect(source.insight).toMatchObject({
          status: "ok",
          kind: insightKind,
          mediaJobId: source.origin.id,
        });
        expect(assetJobOwned(source.origin)).toBe(true);
        expect(AssetJobOutputSchema.parse(source.origin.output).content).toEqual(
          source.insight.content,
        );
      }
      const call = vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async (request) => {
        assertNotInTransaction("重跑摘要模型外呼");
        expect(request.text).toContain(`${insightKind}: ${marker}`);
        expect(Object.keys(request.vocabulary).sort()).toEqual(["content", "timeliness", "usage"]);
        return ok(summary(["重跑采用合法未选中来源"]));
      });
      const result = await output({ ...facts, job });
      expect(result).toMatchObject({
        status: "ok",
        reason: null,
        content: { keypoints: ["重跑采用合法未选中来源"], partial: false },
      });
      expect(result.content.sourceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(call).toHaveBeenCalledOnce();
      expect((await insights(facts.assetId))[0]).toMatchObject({
        mediaJobId: job.id,
        status: "ok",
        content: summary(["重跑采用合法未选中来源"]),
      });
      for (const source of beforeSources) {
        expect(await row(source.origin.id)).toEqual(source.origin);
        expect(
          await h.prisma.storeAssetInsight.findUniqueOrThrow({ where: { id: source.insight.id } }),
        ).toEqual(source.insight);
      }
      const currentJobs = (
        await h.prisma.mediaJob.findMany({ where: { parentId: facts.assetId } })
      ).filter((candidate) => AssetJobInputSchema.parse(candidate.input).runId === input.runId);
      expect(currentJobs.map((candidate) => candidate.kind)).toEqual(["digest"]);
      expect(await asset(facts.assetId)).toMatchObject({
        processingState: "processed",
        reviewState: "unreviewed",
        usability: null,
      });
    },
    120_000,
  );

  it.each(REPROCESS_SOURCES)(
    "$type 选中来源的当前run取消后，不借旧run来源伪装新成果",
    async ({ type, insightKind, jobKind }) => {
      const facts = await readySources(type, [`公开虚构${type}旧来源必须拒绝`], "");
      expect((await output(facts)).status).toBe("ok");
      const beforeSources = await Promise.all(
        facts.sources.map(async (source) => ({
          origin: await row(source.origin.id),
          insight: await h.prisma.storeAssetInsight.findUniqueOrThrow({
            where: { id: source.insight.id },
          }),
        })),
      );
      await h.media.assets.reprocess(h.admin, facts.assetId, { kinds: [insightKind, "digest"] });
      const selected = await h.prisma.mediaJob.findFirstOrThrow({
        where: { parentId: facts.assetId, kind: jobKind, state: "queued" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      const current = AssetJobInputSchema.parse(selected.input);
      expect(current.selected).toEqual([insightKind, "digest"]);
      expect(current.runId).not.toBe(AssetJobInputSchema.parse(facts.job.input).runId);
      // 当前source的合法取消终态是历史前提；不调用会覆盖旧洞察的finish。
      // 摘要任务仍由真实advanceAsset产生，不手写新digest或伪造来源结果。
      await h.tx.run(async (tx) => {
        await lockRows(tx, "store_asset", [facts.assetId]);
        await lockRows(tx, "media_job", [selected.id]);
        await tx.mediaJob.update({
          where: { id: selected.id },
          data: {
            state: "canceled",
            finishedAt: h.clock.now(),
            leaseOwner: null,
            updatedAt: h.clock.now(),
          },
        });
        await advanceAsset(tx, deps(), facts.assetId);
      });
      const job = await h.prisma.mediaJob.findFirstOrThrow({
        where: { parentId: facts.assetId, kind: "digest", state: "queued" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      });
      expect(AssetJobInputSchema.parse(job.input)).toMatchObject({
        runId: current.runId,
        selected: [insightKind, "digest"],
      });
      const call = vi.spyOn(h.fake.llm, "summarizeAsset");
      h.fake.llm.resetCalls();
      expect(await output({ ...facts, job })).toMatchObject({
        status: "skipped",
        reason: "digest_source_missing",
        content: {},
      });
      expect(call).not.toHaveBeenCalled();
      expect(h.fake.llm.calls).toEqual([]);
      for (const source of beforeSources) {
        expect(await row(source.origin.id)).toEqual(source.origin);
        expect(
          await h.prisma.storeAssetInsight.findUniqueOrThrow({ where: { id: source.insight.id } }),
        ).toEqual(source.insight);
      }
      expect((await insights(facts.assetId))[0]).toMatchObject({
        status: "skipped",
        mediaJobId: job.id,
      });
      expect(await asset(facts.assetId)).toMatchObject({
        processingState: "processed",
        isInsightPartial: true,
        reviewState: "unreviewed",
        usability: null,
      });
    },
    120_000,
  );
});
