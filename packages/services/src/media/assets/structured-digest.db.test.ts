import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileObject, MediaJob, Prisma } from "@liyoxi/db";
import { connectTestDatabase } from "@liyoxi/db/testing";
import { assertNotInTransaction, lockRows, uuidv7 } from "../../kernel/index.js";
import {
  configTestStaffBriefs,
  createMediaAssetsHarness,
  useSeededDatabase,
} from "../../testing/index.js";
import { createConfig, createConfigAdmin } from "../../config/index.js";
import { ok } from "../../providers/types.js";
import type { LlmDigest, LlmDigestInput, LlmProvider } from "../../providers/types.js";
import { createMediaJobs } from "../index.js";
import type { AssetDeps } from "./context.js";
import { createAssetDigestStrategy } from "./digest.js";
import { advanceAsset, AssetJobInputSchema, AssetJobOutputSchema } from "./pipeline.js";

// Real public create/config/review/reprocess, DB transactions and job convergence.
// External model IO is controlled; historical document/tag rows below are explicit fixtures.
const database = useSeededDatabase("services");
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
let config: ReturnType<typeof createConfigAdmin>;
let sequence = 0;
const codes: { content: string[]; usage: string[]; timeliness: string[] } = {
  content: [],
  usage: [],
  timeliness: [],
};
const configActor = () => ({ identity: h.admin.identity, staff: h.admin.staff! });
async function createTag(dimension: "content" | "usage" | "timeliness") {
  return config.createDictItem(configActor(), {
    typeKey: "asset_tag",
    name: `结构${dimension}${++sequence}`,
    ext: { dimension },
  });
}
beforeAll(async () => {
  h = await createMediaAssetsHarness(await database.prisma());
  config = createConfigAdmin({
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    config: createConfig({ db: h.prisma, clock: h.clock, redis: null }),
    staffBriefs: configTestStaffBriefs,
  });
  for (const dimension of ["content", "usage", "timeliness"] as const) {
    const count = dimension === "content" ? 5 : dimension === "usage" ? 4 : 1;
    for (let index = 0; index < count; index++)
      codes[dimension].push((await createTag(dimension)).code);
  }
}, 120_000);
beforeEach(() => {
  h.permitControlledModel(true);
  h.fake.llm.resetCalls();
  h.fake.llm.digestReplies.length = 0;
  h.fake.llm.keyPointReplies.length = 0;
  h.fake.llm.tagReplies.length = 0;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => h?.close());

const json = (value: unknown) => value as Prisma.InputJsonValue;
const asset = (id: string) => h.prisma.storeAsset.findUniqueOrThrow({ where: { id } });
const jobRow = (id: string) => h.prisma.mediaJob.findUniqueOrThrow({ where: { id } });
const tags = (id: string) =>
  h.prisma.storeAssetTag.findMany({ where: { storeAssetId: id }, orderBy: { id: "asc" } });
const digests = (id: string) =>
  h.prisma.storeAssetInsight.findMany({
    where: { storeAssetId: id, kind: "digest" },
    orderBy: { id: "asc" },
  });
const events = (id: string) =>
  h.prisma.outboxEvent.findMany({ where: { aggregateId: id }, orderBy: { id: "asc" } });
function complete(patch: Partial<LlmDigest> = {}): LlmDigest {
  // Explicit test data, never a production repair/default for missing model fields.
  return {
    title: "公开虚构门店摘要",
    keypoints: ["现场制作公开虚构菜品"],
    contentTags: [codes.content[0]!],
    suggestedUsage: [codes.usage[0]!],
    suggestedTimeliness: {
      code: codes.timeliness[0]!,
      from: "2026-10-11",
      to: "2026-10-18",
    },
    faceHint: "none",
    qualityNotes: ["仅依据公开虚构来源"],
    structuredItems: [{ name: "公开虚构招牌菜", price: "29元" }],
    ...patch,
  };
}
type Facts = { assetId: string; job: MediaJob; files: FileObject[] };
async function readyText(): Promise<Facts> {
  const created = await h.media.assets.create(h.owner, {
    type: "text",
    textBody: "公开虚构门店每天现场制作招牌菜。",
  });
  const audit = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentId: created.storeAssetId, kind: "audit_text" },
  });
  await h.media.jobs.run({ jobId: audit.id });
  const job = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentId: created.storeAssetId, kind: "digest" },
  });
  expect(job).toMatchObject({ state: "queued", provider: "fake", attemptNo: 0 });
  return { assetId: created.storeAssetId, job, files: [] };
}
async function readyDocument(): Promise<Facts> {
  const files: FileObject[] = [];
  for (let position = 0; position < 2; position++) {
    const body = Buffer.from(`公开虚构菜单${position}`),
      key = `test/${uuidv7()}.txt`;
    h.fake.storage.put({ bucket: "asset", key }, body, "text/plain");
    const head = await h.fake.storage.head({ bucket: "asset", key });
    if (!head.ok || !head.value.exists || !head.value.etag) throw new Error("fixture missing");
    files.push(
      await h.make.fileObject({
        bucket: "asset",
        category: "store_asset",
        scopeType: "store",
        entityId: h.merchant.entity.id,
        storeId: h.merchant.store.id,
        uploadActorType: "merchant",
        uploadActorId: h.merchant.user.id,
        uploadClient: "weapp",
        ext: "txt",
        objectKey: key,
        declaredSize: BigInt(body.length),
        sizeBytes: BigInt(body.length),
        declaredMime: "text/plain",
        mime: "text/plain",
        etag: head.value.etag,
        crc64: "12345",
        sha256: createHash("sha256").update(body).digest("hex"),
        moderationState: "pass",
      }),
    );
  }
  const created = await h.media.assets.create(h.owner, {
    type: "document",
    fileIds: files.map((file) => file.id),
  });
  const first = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentId: created.storeAssetId },
  });
  const base = AssetJobInputSchema.parse(first.input);
  for (const [index, file] of files.entries()) {
    const content = { text: `公开虚构菜单${index}`, truncated: false, charCount: 7 };
    for (const kind of ["doc_extract", "audit_text"] as const) {
      const dedupeKey = `asset:${created.storeAssetId}:${base.runId}:${kind}:${file.id}:v${base.promptVersion}`;
      const old = await h.prisma.mediaJob.findUnique({ where: { dedupeKey } });
      const data = {
        kind,
        provider: kind === "doc_extract" ? "mediatool" : "fake",
        mode: "local",
        parentType: "store_asset",
        parentId: created.storeAssetId,
        subjectType: "file_object",
        subjectId: file.id,
        input: json({
          ...base,
          fileId: file.id,
          etag: file.etag,
          crc64: file.crc64,
          sizeBytes: file.sizeBytes!.toString(),
        }),
        output: json({
          status: "ok",
          reason: null,
          content: kind === "doc_extract" ? content : {},
          verdict: kind === "audit_text" ? "pass" : null,
        }),
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
      if (kind === "doc_extract")
        await h.prisma.storeAssetInsight.create({
          data: {
            id: uuidv7(),
            storeAssetId: created.storeAssetId,
            fileId: file.id,
            kind: "doc_text",
            promptVersion: base.promptVersion,
            provider: origin.provider,
            mediaJobId: origin.id,
            status: "ok",
            content,
            createdAt: h.clock.now(),
            updatedAt: h.clock.now(),
          },
        });
    }
  }
  await h.tx.run(async (tx) => {
    await lockRows(tx, "store_asset", [created.storeAssetId]);
    await advanceAsset(tx, dependencies(), created.storeAssetId);
  });
  return {
    assetId: created.storeAssetId,
    job: await h.prisma.mediaJob.findFirstOrThrow({
      where: { parentId: created.storeAssetId, kind: "digest" },
    }),
    files,
  };
}
function dependencies(): AssetDeps {
  return {
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    events: h.events,
    storage: h.fake.storage,
    moderation: h.fake.media,
    refTypes: new Map(),
    guards: new Map(),
    assets: { ...h.assets, allowModelCall: async () => true },
  };
}
const handler = () => h.media.jobs.handlers.get("digest")!;
const strategy = () => createAssetDigestStrategy(dependencies(), handler().current);
async function claim(facts: Facts) {
  return h.prisma.mediaJob.update({
    where: { id: facts.job.id },
    data: {
      state: "running",
      attemptNo: 1,
      leaseOwner: `structured-digest:${uuidv7()}`,
      startedAt: h.clock.now(),
      nextRunAt: new Date(h.clock.now().getTime() + 120_000),
    },
  });
}
async function run(facts: Facts) {
  await h.media.jobs.run({ jobId: facts.job.id });
  const written = await jobRow(facts.job.id);
  expect(written).toMatchObject({
    state: "succeeded",
    attemptNo: 1,
    leaseOwner: null,
    isRetryable: false,
  });
  return AssetJobOutputSchema.parse(written.output);
}
function modelResult(value: unknown) {
  return vi
    .spyOn(h.fake.llm, "summarizeAsset")
    .mockResolvedValue(ok(value) as Awaited<ReturnType<LlmProvider["summarizeAsset"]>>);
}
async function reprocess(facts: Facts) {
  h.clock.advance(1);
  await h.media.assets.reprocess(h.admin, facts.assetId, { kinds: ["digest"] });
  return {
    ...facts,
    job: await h.prisma.mediaJob.findFirstOrThrow({
      where: { parentId: facts.assetId, kind: "digest" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  };
}
async function updateTag(id: string, changes: Parameters<typeof config.updateDictItem>[2]) {
  const current = await h.prisma.dictItem.findUniqueOrThrow({ where: { id } });
  return config.updateDictItem(configActor(), id, { ...changes, lockVersion: current.lockVersion });
}
async function historicalTag(
  assetId: string,
  dimension: "content" | "usage" | "timeliness",
  tagCode: string,
  source: "auto" | "uploader",
) {
  return h.prisma.storeAssetTag.create({
    data: {
      id: uuidv7(),
      storeAssetId: assetId,
      dimension,
      tagCode,
      source,
      isConfirmed: false,
      createdAt: h.clock.now(),
      updatedAt: h.clock.now(),
    },
  });
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function delayed(facts: Facts, mutation: () => Promise<unknown>) {
  const entered = gate(),
    release = gate();
  const call = vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async () => {
    assertNotInTransaction("structured digest delayed IO");
    entered.release();
    await release.promise;
    return ok(complete());
  });
  const running = h.media.jobs.run({ jobId: facts.job.id });
  void running.catch(() => undefined);
  try {
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce(), { timeout: 3000 });
    await entered.promise;
    await mutation();
  } finally {
    release.release();
  }
  await running;
}

describe("structured digest real persistence and suggestions", () => {
  it("stores every DTO field, keeps provenance on the job, and exposes current detail/search once", async () => {
    const facts = await readyText(),
      reply = complete();
    const call = vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async (input) => {
      assertNotInTransaction("structured digest model IO");
      expect(input.signal).toBeInstanceOf(AbortSignal);
      expect(input.text).toBe((await asset(facts.assetId)).textBody);
      expect(input.vocabulary).toMatchObject({
        content: expect.arrayContaining([{ code: codes.content[0], label: expect.any(String) }]),
        usage: expect.arrayContaining([{ code: codes.usage[0], label: expect.any(String) }]),
        timeliness: expect.arrayContaining([
          { code: codes.timeliness[0], label: expect.any(String) },
        ]),
      });
      return ok(reply);
    });
    const result = await run(facts);
    expect(result).toMatchObject({
      status: "ok",
      content: { ...reply, partial: false, sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(await digests(facts.assetId)).toMatchObject([
      { fileId: null, content: reply, status: "ok", mediaJobId: facts.job.id, provider: "fake" },
    ]);
    expect(await tags(facts.assetId)).toMatchObject([
      { dimension: "content", tagCode: codes.content[0], source: "auto", isConfirmed: false },
    ]);
    const savedAsset = await asset(facts.assetId);
    expect(savedAsset).toMatchObject({
      title: reply.title,
      reviewState: "unreviewed",
      usability: null,
      portraitAuthorizedAt: null,
      isInsightPartial: false,
    });
    expect(savedAsset.searchText).toContain(reply.title);
    expect(savedAsset.searchText).toContain(reply.keypoints[0]);
    const dictionary = await h.prisma.dictItem.findUniqueOrThrow({
      where: { dictTypeKey_code: { dictTypeKey: "asset_tag", code: codes.content[0]! } },
    });
    expect(savedAsset.searchText).toContain(dictionary.name);
    expect(await h.media.assets.get(h.admin, facts.assetId)).toMatchObject({
      title: reply.title,
      keypoints: reply.keypoints,
      structuredItems: [{ name: "公开虚构招牌菜", priceText: "29元" }],
      hasUnconfirmedAutoTags: true,
      suggestion: {
        contentTags: [{ code: codes.content[0], name: dictionary.name }],
        usageTags: [{ code: codes.usage[0], name: expect.any(String) }],
        timeliness: {
          tag: { code: codes.timeliness[0], name: expect.any(String) },
          validStartDate: "2026-10-11",
          validEndDate: "2026-10-18",
        },
        faceHint: "none",
        qualityNotes: reply.qualityNotes,
      },
    });
    const before = {
      job: await jobRow(facts.job.id),
      rows: await digests(facts.assetId),
      events: await events(facts.assetId),
    };
    await h.media.jobs.run({ jobId: facts.job.id });
    expect(await jobRow(facts.job.id)).toEqual(before.job);
    expect(await digests(facts.assetId)).toEqual(before.rows);
    expect(await events(facts.assetId)).toEqual(before.events);
    expect(before.events.filter((event) => event.eventType === "asset.processed")).toHaveLength(1);
    expect(before.events.filter((event) => event.eventType === "asset.review_needed")).toHaveLength(
      1,
    );
    expect(call).toHaveBeenCalledOnce();
    expect(h.fake.llm.callsOf("extractKeyPoints")).toEqual([]);
  });

  it("uses enabled real dictionary labels in their own dimensions, excluding disabled tags", async () => {
    const disabled = await createTag("content");
    await updateTag(disabled.dictItemId, { lockVersion: 0, isEnabled: false });
    const facts = await readyText();
    h.fake.llm.digestReplies.push(complete());
    await run(facts);
    const input = h.fake.llm.callsOf("summarizeAsset")[0]!.input as LlmDigestInput;
    const current = await h.prisma.dictItem.findMany({
      where: { dictTypeKey: "asset_tag", isEnabled: true },
    });
    for (const dimension of ["content", "usage", "timeliness"] as const) {
      const expected = current
        .filter((item) => (item.ext as { dimension: string }).dimension === dimension)
        .map((item) => ({ code: item.code, label: item.name }));
      expect([...input.vocabulary[dimension]].sort((a, b) => a.code.localeCompare(b.code))).toEqual(
        expected.sort((a, b) => a.code.localeCompare(b.code)),
      );
      expect(input.vocabulary[dimension].some((item) => item.code === disabled.code)).toBe(false);
    }
  });

  it("filters valid unknown, disabled and cross-dimension codes without promoting suggestions to tags", async () => {
    const disabled = await createTag("content");
    await updateTag(disabled.dictItemId, { lockVersion: 0, isEnabled: false });
    const facts = await readyText();
    modelResult(
      complete({
        contentTags: [codes.content[0]!, codes.usage[0]!, "UNKNOWN", disabled.code],
        suggestedUsage: [codes.usage[0]!, codes.content[0]!, "UNKNOWN"],
        suggestedTimeliness: { code: "UNKNOWN", from: "2026-10-11", to: "2026-10-12" },
      }),
    );
    const result = await run(facts);
    expect(result).toMatchObject({
      status: "ok",
      content: { contentTags: [codes.content[0]], suggestedUsage: [codes.usage[0]] },
    });
    expect(result.content).not.toHaveProperty("suggestedTimeliness");
    expect((await digests(facts.assetId))[0]!.content).not.toHaveProperty("suggestedTimeliness");
    expect(await tags(facts.assetId)).toMatchObject([
      { dimension: "content", tagCode: codes.content[0], source: "auto" },
    ]);
    expect(await tags(facts.assetId)).toHaveLength(1);
  });

  it("deduplicates actual auto rows while preserving the complete model DTO", async () => {
    const facts = await readyText(),
      reply = complete({ contentTags: [codes.content[0]!, codes.content[0]!] });
    h.fake.llm.digestReplies.push(reply);
    expect(await run(facts)).toMatchObject({ status: "ok" });
    expect((await digests(facts.assetId))[0]!.content).toEqual(reply);
    expect(await tags(facts.assetId)).toHaveLength(1);
    expect(await tags(facts.assetId)).toMatchObject([
      { source: "auto", isConfirmed: false, tagCode: codes.content[0] },
    ]);
  });

  it.each(["none", "people_unclear", "identifiable_customer"] as const)(
    "faceHint=%s remains a suggestion and never grants usability or portrait authorization",
    async (faceHint) => {
      const facts = await readyText();
      h.fake.llm.digestReplies.push(complete({ faceHint }));
      await run(facts);
      expect(await asset(facts.assetId)).toMatchObject({
        reviewState: "unreviewed",
        usability: null,
        portraitAuthorizedAt: null,
        reviewedAt: null,
        reviewedByStaffId: null,
      });
      expect((await tags(facts.assetId)).every((tag) => tag.dimension === "content")).toBe(true);
      expect(await h.media.assets.get(h.admin, facts.assetId)).toMatchObject({
        suggestion: { faceHint },
      });
    },
  );

  it("accepts Unicode codepoint maxima across the full DTO without UTF-16 truncation", async () => {
    const facts = await readyText(),
      reply = complete({
        title: "😀".repeat(20),
        keypoints: ["😀".repeat(60)],
        qualityNotes: ["😀".repeat(40)],
        structuredItems: [{ name: "😀".repeat(30), price: "😀".repeat(20) }],
      });
    h.fake.llm.digestReplies.push(reply);
    await run(facts);
    expect((await digests(facts.assetId))[0]!.content).toEqual(reply);
    expect((await asset(facts.assetId)).title).toBe(reply.title);
    expect(await h.media.assets.get(h.admin, facts.assetId)).toMatchObject({
      structuredItems: [{ name: reply.structuredItems![0]!.name, priceText: "😀".repeat(20) }],
    });
  });

  it("accepts required empty values, preserves them in insight, and leaves title fallback to convergence", async () => {
    const facts = await readyText();
    const reply: LlmDigest = {
      title: "",
      keypoints: [],
      contentTags: [],
      suggestedUsage: [],
      faceHint: "none",
      qualityNotes: [],
    };
    h.fake.llm.digestReplies.push(reply);
    expect(await run(facts)).toMatchObject({ status: "ok", content: { partial: false } });
    expect((await digests(facts.assetId))[0]!.content).toEqual(reply);
    expect((await asset(facts.assetId)).title).toMatch(/^文字1项 /u);
    expect(await tags(facts.assetId)).toEqual([]);
    expect(await h.media.assets.get(h.admin, facts.assetId)).toMatchObject({
      keypoints: [],
      structuredItems: [],
    });
  });

  it("does not manufacture optional timeliness or structured items omitted by the model", async () => {
    const facts = await readyText();
    const { suggestedTimeliness: _time, structuredItems: _items, ...reply } = complete();
    h.fake.llm.digestReplies.push(reply);
    const result = await run(facts);
    expect(result.content).not.toHaveProperty("suggestedTimeliness");
    expect(result.content).not.toHaveProperty("structuredItems");
    expect((await digests(facts.assetId))[0]!.content).toEqual(reply);
    expect(await h.media.assets.get(h.admin, facts.assetId)).toMatchObject({
      structuredItems: [],
      suggestion: { timeliness: null },
    });
  });
});

describe("structured digest validates uncontrolled provider output at the business boundary", () => {
  const invalid = [
    ...["title", "keypoints", "contentTags", "suggestedUsage", "faceHint", "qualityNotes"].map(
      (field) => ({
        name: `missing ${field}`,
        make: () => {
          const value: Record<string, unknown> = { ...complete() };
          delete value[field];
          return value;
        },
      }),
    ),
    { name: "old points-only reply", make: () => ({ points: ["旧接口要点"] }) },
    { name: "extra invented confidence", make: () => ({ ...complete(), confidence: 1 }) },
    { name: "21 Unicode title", make: () => complete({ title: "😀".repeat(21) }) },
    { name: "seven keypoints", make: () => complete({ keypoints: Array(7).fill("要点") }) },
    { name: "61 Unicode keypoint", make: () => complete({ keypoints: ["😀".repeat(61)] }) },
    { name: "five known content tags", make: () => complete({ contentTags: [...codes.content] }) },
    { name: "four known usage tags", make: () => complete({ suggestedUsage: [...codes.usage] }) },
    { name: "four quality notes", make: () => complete({ qualityNotes: Array(4).fill("说明") }) },
    { name: "41 Unicode quality note", make: () => complete({ qualityNotes: ["😀".repeat(41)] }) },
    { name: "invalid face hint", make: () => ({ ...complete(), faceHint: "recognized_person" }) },
    {
      name: "51 structured items",
      make: () =>
        complete({ structuredItems: Array.from({ length: 51 }, () => ({ name: "菜单项" })) }),
    },
  ];
  it.each(invalid)(
    "$name settles as partial without retry, title, auto tags or repaired DTO",
    async ({ make }) => {
      const facts = await readyText(),
        call = modelResult(make());
      expect(await run(facts)).toMatchObject({
        status: "skipped",
        reason: "digest_result_invalid",
        content: {},
      });
      expect(await digests(facts.assetId)).toMatchObject([
        { status: "skipped", content: { reason: "digest_result_invalid" } },
      ]);
      expect(await tags(facts.assetId)).toEqual([]);
      expect(await asset(facts.assetId)).toMatchObject({
        isInsightPartial: true,
        usability: null,
        reviewState: "unreviewed",
      });
      expect((await asset(facts.assetId)).title).not.toBe(complete().title);
      await h.media.jobs.run({ jobId: facts.job.id });
      expect(call).toHaveBeenCalledOnce();
      expect(await jobRow(facts.job.id)).toMatchObject({
        isRetryable: false,
        attemptNo: 1,
        errorCode: null,
      });
    },
  );

  it.each([
    { name: "non-calendar", from: "2026-02-30", to: "2026-03-01" },
    { name: "reversed", from: "2026-10-18", to: "2026-10-11" },
    { name: "non-ISO", from: "2026/10/11", to: "2026/10/18" },
  ])("$name timeliness cannot be saved even when the tag code is unknown", async ({ from, to }) => {
    const facts = await readyText();
    modelResult(complete({ suggestedTimeliness: { code: "UNKNOWN", from, to } }));
    expect(await run(facts)).toMatchObject({ status: "skipped", reason: "digest_result_invalid" });
    expect(await tags(facts.assetId)).toEqual([]);
    expect((await digests(facts.assetId))[0]!.content).toEqual({ reason: "digest_result_invalid" });
  });
});

describe("structured digest binds actual dictionary snapshots to all three windows", () => {
  it.each([
    { name: "missing dimension", ext: {} },
    { name: "unknown dimension", ext: { dimension: "invented" } },
    { name: "extra ext field", ext: { dimension: "content", defaultTag: true } },
  ])("historical $name is conservatively skipped before model IO", async ({ ext }) => {
    const item = await createTag("content"),
      facts = await readyText();
    // DB-valid historical object; the current public config schema rejects this malformed ext.
    await h.prisma.dictItem.update({ where: { id: item.dictItemId }, data: { ext: json(ext) } });
    try {
      expect(await run(facts)).toMatchObject({
        status: "skipped",
        reason: "digest_vocabulary_invalid",
      });
      expect(h.fake.llm.calls).toEqual([]);
      expect(await tags(facts.assetId)).toEqual([]);
      expect(await asset(facts.assetId)).toMatchObject({ isInsightPartial: true, usability: null });
    } finally {
      await h.prisma.dictItem.update({
        where: { id: item.dictItemId },
        data: { ext: { dimension: "content" }, isEnabled: false },
      });
    }
  });

  it("257 enabled entries in one real dimension reject the whole vocabulary before IO", async () => {
    const existing = await h.prisma.dictItem.findMany({
      where: { dictTypeKey: "asset_tag", isEnabled: true },
    });
    const count = existing.filter(
      (item) => (item.ext as { dimension: string }).dimension === "content",
    ).length;
    const created: string[] = [];
    try {
      for (let index = count; index < 257; index++)
        created.push((await createTag("content")).dictItemId);
      const facts = await readyText();
      expect(await run(facts)).toMatchObject({
        status: "skipped",
        reason: "digest_vocabulary_invalid",
      });
      expect(h.fake.llm.calls).toEqual([]);
      expect(await tags(facts.assetId)).toEqual([]);
    } finally {
      // Fixture cleanup retains immutable dictionary history; no rows or constraints are removed.
      await h.prisma.dictItem.updateMany({
        where: { id: { in: created } },
        data: { isEnabled: false },
      });
    }
  }, 60_000);

  it.each(["rename", "disable", "dimension", "add"] as const)(
    "%s during unlocked model IO cancels all late DTO and auto-tag writes",
    async (change) => {
      const item = await createTag("content"),
        facts = await readyText();
      await delayed(facts, async () => {
        h.clock.advance(1);
        if (change === "add") return createTag("usage");
        return updateTag(item.dictItemId, {
          lockVersion: 0,
          ...(change === "rename" ? { name: `词表赢家${++sequence}` } : {}),
          ...(change === "disable" ? { isEnabled: false } : {}),
          ...(change === "dimension" ? { ext: { dimension: "usage" } } : {}),
        });
      });
      expect(await jobRow(facts.job.id)).toMatchObject({ state: "canceled", leaseOwner: null });
      expect(await digests(facts.assetId)).toEqual([]);
      expect(await tags(facts.assetId)).toEqual([]);
      expect(await asset(facts.assetId)).toMatchObject({
        isInsightPartial: true,
        reviewState: "unreviewed",
        usability: null,
      });
      expect((await asset(facts.assetId)).title).not.toBe(complete().title);
      expect(
        (await events(facts.assetId)).filter((event) => event.eventType === "asset.review_needed"),
      ).toHaveLength(1);
    },
  );

  it("finish rejects a vocabulary winner committed after the successful IO recheck", async () => {
    const item = await createTag("content"),
      facts = await readyText(),
      job = await claim(facts);
    h.fake.llm.digestReplies.push(complete());
    const result = await strategy().execute(job, new AbortController().signal);
    expect(result.state).toBe("succeeded");
    if (result.state !== "succeeded") throw new Error("expected controlled model result");
    expect(AssetJobOutputSchema.parse(result.output).status).toBe("ok");
    h.clock.advance(1);
    await updateTag(item.dictItemId, { lockVersion: 0, name: `第三窗赢家${++sequence}` });
    await h.tx.run(async (tx) => {
      await lockRows(tx, "store_asset", [facts.assetId]);
      await lockRows(tx, "media_job", [job.id]);
      const written = await tx.mediaJob.update({
        where: { id: job.id },
        data: {
          state: "succeeded",
          output: json(result.output),
          finishedAt: h.clock.now(),
          leaseOwner: null,
        },
      });
      await handler().finish!(tx, written, result, h.admin.identity);
      await h.media.jobs.convergence.get("store_asset")!.converge(tx, facts.assetId, h.clock.now());
    });
    expect(await digests(facts.assetId)).toEqual([]);
    expect(await tags(facts.assetId)).toEqual([]);
    expect((await asset(facts.assetId)).title).not.toBe(complete().title);
    expect(await asset(facts.assetId)).toMatchObject({
      processingState: "processed",
      isInsightPartial: true,
      usability: null,
    });
  });
});

describe("structured digest preserves human ownership", () => {
  it("digest-only public reprocess replaces only automatic content rows and retains uploader/other dimensions", async () => {
    const facts = await readyText(),
      uploader = await historicalTag(facts.assetId, "content", codes.content[2]!, "uploader"),
      legacyUsage = await historicalTag(facts.assetId, "usage", codes.usage[1]!, "auto"),
      legacyTime = await historicalTag(facts.assetId, "timeliness", codes.timeliness[0]!, "auto");
    h.fake.llm.digestReplies.push(complete({ contentTags: [codes.content[0]!] }));
    await run(facts);
    const oldAuto = (await tags(facts.assetId)).find(
      (tag) => tag.source === "auto" && tag.dimension === "content",
    )!;
    const originalTitle = (await asset(facts.assetId)).title;
    const next = await reprocess(facts);
    h.fake.llm.digestReplies.push(
      complete({ title: "新的模型标题", contentTags: [codes.content[1]!] }),
    );
    await run(next);
    const current = await tags(facts.assetId);
    expect(current).toEqual(expect.arrayContaining([uploader, legacyUsage, legacyTime]));
    expect(current.some((tag) => tag.id === oldAuto.id)).toBe(false);
    expect(
      current.filter((tag) => tag.source === "auto" && tag.dimension === "content"),
    ).toMatchObject([{ tagCode: codes.content[1], isConfirmed: false }]);
    expect((await asset(facts.assetId)).title).toBe(originalTitle);
    expect(await digests(facts.assetId)).toHaveLength(1);
    expect((await digests(facts.assetId))[0]!.mediaJobId).toBe(next.job.id);
  });

  it.each(["ready", "need_portrait_auth"] as const)(
    "public human review with usability=%s wins over later model tags, title and faceHint",
    async (usability) => {
      const facts = await readyText();
      h.fake.llm.digestReplies.push(complete());
      await run(facts);
      await h.media.assets.review(h.admin, facts.assetId, {
        lockVersion: (await asset(facts.assetId)).lockVersion,
        title: "人工确认标题",
        contentTagCodes: [codes.content[2]!],
        usageTagCodes: [codes.usage[2]!],
        timeliness: {
          tagCode: codes.timeliness[0]!,
          validStartDate: "2026-10-01",
          validEndDate: "2026-10-31",
        },
        usability,
      });
      const before = await asset(facts.assetId),
        reviewed = (await tags(facts.assetId)).filter((tag) => tag.source === "reviewer");
      const next = await reprocess(facts);
      h.fake.llm.digestReplies.push(
        complete({
          title: "不能覆盖人工标题",
          contentTags: [codes.content[1]!],
          faceHint: "identifiable_customer",
        }),
      );
      await run(next);
      const after = await asset(facts.assetId);
      expect(after).toMatchObject({
        title: before.title,
        usability,
        reviewState: "reviewed",
        reviewedAt: before.reviewedAt,
        reviewedByStaffId: before.reviewedByStaffId,
        lockVersion: before.lockVersion,
        portraitAuthorizedAt: before.portraitAuthorizedAt,
      });
      expect((await tags(facts.assetId)).filter((tag) => tag.source === "reviewer")).toEqual(
        reviewed,
      );
      expect(await h.media.assets.get(h.admin, facts.assetId)).toMatchObject({
        title: "人工确认标题",
        usability,
        contentTags: [{ source: "reviewer", isConfirmed: true, tag: { code: codes.content[2] } }],
        usageTags: [{ source: "reviewer", isConfirmed: true, tag: { code: codes.usage[2] } }],
        hasUnconfirmedAutoTags: false,
        suggestion: {
          contentTags: [{ code: codes.content[1] }],
          faceHint: "identifiable_customer",
        },
      });
    },
  );

  it("does not replace an existing title whose origin cannot be inferred", async () => {
    const facts = await readyText();
    // Lawful historical title; the schema has no manual/system title provenance column.
    await h.prisma.storeAsset.update({
      where: { id: facts.assetId },
      data: { title: "已有历史标题" },
    });
    h.fake.llm.digestReplies.push(complete({ title: "模型新标题" }));
    await run(facts);
    expect((await asset(facts.assetId)).title).toBe("已有历史标题");
    expect((await digests(facts.assetId))[0]!.content).toMatchObject({ title: "模型新标题" });
  });

  it("a human-reviewed null title is not filled from a later model suggestion", async () => {
    const facts = await readyText();
    h.fake.llm.digestReplies.push(complete());
    await run(facts);
    await h.media.assets.review(h.admin, facts.assetId, {
      lockVersion: (await asset(facts.assetId)).lockVersion,
      title: null,
      contentTagCodes: [codes.content[2]!],
      usageTagCodes: [codes.usage[2]!],
      timeliness: { tagCode: codes.timeliness[0]! },
      usability: "reference_only",
    });
    expect((await asset(facts.assetId)).title).toBeNull();
    const next = await reprocess(facts);
    h.fake.llm.digestReplies.push(complete({ title: "不能代替人工的标题" }));
    await run(next);
    expect(await asset(facts.assetId)).toMatchObject({
      reviewState: "reviewed",
      usability: "reference_only",
    });
    expect((await asset(facts.assetId)).title).not.toBe("不能代替人工的标题");
    expect((await digests(facts.assetId))[0]!.content).toMatchObject({
      title: "不能代替人工的标题",
    });
  });
});

describe("structured digest aggregate document items", () => {
  it("projects aggregate items without attributing them to either source file or creating skipped extractors", async () => {
    const facts = await readyDocument(),
      reply = complete({
        structuredItems: [{ name: "跨文件汇总菜品", price: "39元" }, { name: "未标价项目" }],
      });
    h.fake.llm.digestReplies.push(reply);
    expect(await run(facts)).toMatchObject({ status: "ok", content: { partial: false } });
    expect((await digests(facts.assetId))[0]!.content).toEqual(reply);
    expect(
      await h.prisma.storeAssetInsight.findMany({
        where: { storeAssetId: facts.assetId, kind: "structured_items" },
      }),
    ).toEqual([]);
    expect(await asset(facts.assetId)).toMatchObject({ isInsightPartial: false, usability: null });
    expect(await h.media.assets.get(h.admin, facts.assetId)).toMatchObject({
      structuredItems: [
        { name: "跨文件汇总菜品", priceText: "39元" },
        { name: "未标价项目", priceText: null },
      ],
    });
  });

  it("retains legacy file-level structured items when the aggregate digest is a legacy shape", async () => {
    const facts = await readyDocument();
    h.fake.llm.digestReplies.push(complete());
    await run(facts);
    const digest = (await digests(facts.assetId))[0]!;
    await h.prisma.storeAssetInsight.update({
      where: { id: digest.id },
      data: { content: { keypoints: ["历史摘要"] } },
    });
    await h.prisma.storeAssetInsight.create({
      data: {
        id: uuidv7(),
        storeAssetId: facts.assetId,
        fileId: facts.files[0]!.id,
        kind: "structured_items",
        promptVersion: digest.promptVersion,
        status: "ok",
        provider: "historical",
        content: { items: [{ name: "历史文件菜单项", price: "19元" }] },
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    expect(await h.media.assets.get(h.admin, facts.assetId)).toMatchObject({
      keypoints: ["历史摘要"],
      structuredItems: [{ name: "历史文件菜单项", priceText: "19元" }],
    });
  });

  it.each(["omitted", "empty"] as const)(
    "%s aggregate structuredItems is honest success and does not revive old per-file items",
    async (condition) => {
      const facts = await readyDocument(),
        full = complete(),
        { structuredItems: _items, ...withoutItems } = full,
        reply = condition === "empty" ? { ...withoutItems, structuredItems: [] } : withoutItems;
      await h.prisma.storeAssetInsight.create({
        data: {
          id: uuidv7(),
          storeAssetId: facts.assetId,
          fileId: facts.files[0]!.id,
          kind: "structured_items",
          promptVersion: AssetJobInputSchema.parse(facts.job.input).promptVersion,
          status: "ok",
          provider: "historical",
          content: { items: [{ name: "旧文件项目" }] },
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
      h.fake.llm.digestReplies.push(reply);
      expect(await run(facts)).toMatchObject({ status: "ok", content: { partial: false } });
      expect((await digests(facts.assetId))[0]!.content).toEqual(reply);
      expect(await h.media.assets.get(h.admin, facts.assetId)).toMatchObject({
        structuredItems: [],
      });
      expect(await asset(facts.assetId)).toMatchObject({ isInsightPartial: false });
      const old = await h.prisma.storeAssetInsight.findMany({
        where: { storeAssetId: facts.assetId, kind: "structured_items" },
      });
      expect(old).toHaveLength(1);
      expect(old[0]).toMatchObject({
        status: "ok",
        provider: "historical",
        content: { items: [{ name: "旧文件项目" }] },
      });
    },
  );
});

describe("structured digest atomic DB settlement", () => {
  it.each(["deadline", "lease"] as const)(
    "%s expires during the real public runner's final file lock wait and rejects model settlement",
    async (boundary) => {
      const facts = await readyDocument(),
        clockBefore = h.clock.now(),
        executed = gate(),
        release = gate(),
        reply = complete({ title: "最终等待后不得接纳的模型标题" });
      if (boundary === "deadline")
        await h.prisma.mediaJob.update({
          where: { id: facts.job.id },
          data: { deadlineAt: new Date(clockBefore.getTime() + 1000) },
        });
      const beforeSources = await h.prisma.storeAssetInsight.findMany({
        where: { storeAssetId: facts.assetId },
        orderBy: { id: "asc" },
      });
      const call = vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async () => {
        assertNotInTransaction("structured digest final settlement model IO");
        return ok(reply);
      });
      const actualExecute = handler().execute;
      vi.spyOn(handler(), "execute").mockImplementation(async (...args) => {
        const result = await actualExecute(...args);
        expect(result).toMatchObject({ state: "succeeded", output: { status: "ok" } });
        // Both strategy admission transactions have finished; only final settlement remains.
        executed.release();
        await release.promise;
        return result;
      });
      const holder = await connectTestDatabase(database.name),
        observer = await connectTestDatabase(database.name, { role: null });
      let running: Promise<void> | undefined;
      try {
        running = h.media.jobs.run({ jobId: facts.job.id });
        void running.catch(() => undefined);
        await vi.waitFor(() => expect(call).toHaveBeenCalledOnce(), { timeout: 3000 });
        await executed.promise;
        const claimed = await jobRow(facts.job.id);
        expect(claimed).toMatchObject({ state: "running", attemptNo: 1 });
        const expiresAt = boundary === "deadline" ? claimed.deadlineAt : claimed.nextRunAt;
        expect(expiresAt.getTime()).toBeGreaterThan(h.clock.now().getTime());
        await holder.query("BEGIN");
        const { rows } = await holder.query<{ pid: number }>("SELECT pg_backend_pid()::int AS pid");
        await holder.query("SELECT id FROM file_object WHERE id=$1::uuid FOR UPDATE", [
          facts.files[0]!.id,
        ]);
        release.release();
        await vi.waitFor(
          async () => {
            const blocked = await observer.query<{ count: string }>(
              "SELECT count(*)::bigint AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query ILIKE '%file_object%'",
              [rows[0]!.pid],
            );
            expect(Number(blocked.rows[0]!.count)).toBe(1);
          },
          { timeout: 3000 },
        );
        expect(await digests(facts.assetId)).toEqual([]);
        expect(await tags(facts.assetId)).toEqual([]);
        h.clock.set(expiresAt);
        await holder.query("COMMIT");
        await running;
        expect(call).toHaveBeenCalledOnce();
        expect(await jobRow(facts.job.id)).toMatchObject({
          state: "succeeded",
          attemptNo: 1,
          nextRunAt: claimed.nextRunAt,
          deadlineAt: claimed.deadlineAt,
          leaseOwner: null,
        });
        expect(await digests(facts.assetId)).toEqual([]);
        expect(await tags(facts.assetId)).toEqual([]);
        expect((await asset(facts.assetId)).title).not.toBe(reply.title);
        expect(await asset(facts.assetId)).toMatchObject({
          processingState: "processed",
          isInsightPartial: true,
          usability: null,
        });
        expect(
          await h.prisma.storeAssetInsight.findMany({
            where: { storeAssetId: facts.assetId },
            orderBy: { id: "asc" },
          }),
        ).toEqual(beforeSources);
      } finally {
        release.release();
        await holder.query("ROLLBACK");
        await running?.catch(() => undefined);
        h.clock.set(clockBefore);
        await Promise.all([holder.end(), observer.end()]);
      }
    },
    120_000,
  );

  it("a real post-insert outbox failure rolls back complete DTO, auto replacement, title and terminal job", async () => {
    const facts = await readyText();
    await historicalTag(facts.assetId, "content", codes.content[2]!, "auto");
    const before = {
      asset: await asset(facts.assetId),
      tags: await tags(facts.assetId),
      events: await events(facts.assetId),
    };
    let claimed: MediaJob | undefined;
    vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async () => {
      assertNotInTransaction("structured digest rollback IO");
      claimed = await jobRow(facts.job.id);
      return ok(complete());
    });
    const emit = h.events.emit;
    vi.spyOn(h.events, "emit").mockImplementation(async (...args) => {
      await emit(...args);
      throw new Error("controlled failure after real structured digest outbox insert");
    });
    await expect(h.media.jobs.run({ jobId: facts.job.id })).rejects.toThrow(
      "after real structured digest outbox insert",
    );
    expect(claimed).toBeDefined();
    expect(await jobRow(facts.job.id)).toEqual(claimed);
    expect(await asset(facts.assetId)).toEqual(before.asset);
    expect(await tags(facts.assetId)).toEqual(before.tags);
    expect(await events(facts.assetId)).toEqual(before.events);
    expect(await digests(facts.assetId)).toEqual([]);
  });

  it("two real runner instances create one full digest, one set of auto tags and one settlement", async () => {
    const facts = await readyText(),
      entered = gate(),
      release = gate();
    const second = createMediaJobs({
      tx: h.tx,
      clock: h.clock,
      ownerId: "structured-digest-second-worker",
      handlers: [...h.media.jobs.handlers.values()],
      convergenceHandlers: [...h.media.jobs.convergence.values()],
    });
    const reply = complete({ contentTags: [codes.content[0]!, codes.content[1]!] });
    const call = vi.spyOn(h.fake.llm, "summarizeAsset").mockImplementation(async () => {
      assertNotInTransaction("structured digest two-runner IO");
      entered.release();
      await release.promise;
      return ok(reply);
    });
    const running = h.media.jobs.run({ jobId: facts.job.id });
    void running.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(call).toHaveBeenCalledOnce(), { timeout: 3000 });
      await entered.promise;
      await second.run({ jobId: facts.job.id });
      expect(await digests(facts.assetId)).toEqual([]);
      expect(await tags(facts.assetId)).toEqual([]);
    } finally {
      release.release();
      await running;
      await second.shutdown();
    }
    expect(call).toHaveBeenCalledOnce();
    expect(await digests(facts.assetId)).toMatchObject([{ content: reply }]);
    expect(await tags(facts.assetId)).toHaveLength(2);
    expect(
      (await tags(facts.assetId)).every((tag) => tag.source === "auto" && !tag.isConfirmed),
    ).toBe(true);
    expect(await jobRow(facts.job.id)).toMatchObject({ state: "succeeded", attemptNo: 1 });
    const emitted = await events(facts.assetId);
    expect(emitted.filter((event) => event.eventType === "asset.processed")).toHaveLength(1);
    expect(emitted.filter((event) => event.eventType === "asset.review_needed")).toHaveLength(1);
  });
});
