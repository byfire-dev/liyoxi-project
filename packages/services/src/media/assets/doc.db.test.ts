import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { MediaJob } from "@liyoxi/db";
import {
  assertNotInTransaction,
  createIdentityContext,
  lockRows,
  uuidv7,
} from "../../kernel/index.js";
import {
  connectTestDatabase,
  createMediaAssetsHarness,
  useSeededDatabase,
} from "../../testing/index.js";
import { docx, pdf } from "../../testing/document-fixtures.js";
import { failed, ok } from "../../providers/types.js";
import type { MediaToolClient, ProviderResult, StorageProvider } from "../../providers/types.js";
import type { DocTextResult } from "../../providers/mediatool/schema.js";
import { createMediaToolClient } from "../../providers/mediatool/client.js";
import { createMediaWorkspace } from "../../providers/mediatool/work-io.js";
import type { MediaActor } from "../index.js";
import { fileCategoryGuardPort, fileRefTypePort } from "../index.js";
import type { MediaProductionDeps } from "../production-types.js";
import { advanceAsset, AssetJobInputSchema, AssetJobOutputSchema } from "./pipeline.js";

// Real registration, storage metadata, parent/job locks, insights and outbox rows.
// This UNIX peer only checks transport wiring; it does not parse documents. Actual
// isolated parsing remains infra/docker/mediatool/verify/cases/08-doc-text.test.mjs.
const database = useSeededDatabase("services");
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
let production: MediaProductionDeps;
let server: http.Server;
let root: string, workDir: string;
let sequence = 1;
const peerInstance = randomUUID();
const textFacts = (text = "公开虚构菜单😀") => ({
  text,
  truncated: false,
  charCount: Array.from(text).length,
});
let peerFacts: DocTextResult = textFacts();
const RequestSchema = z.strictObject({
  path: z.string().regex(/^[A-Za-z0-9-]+\/source\.mp4$/),
  ext: z.enum(["txt", "docx", "pdf"]),
  maxChars: z.literal(10000),
  timeoutMs: z.number().int().min(1000).max(10000),
});
type Request = z.infer<typeof RequestSchema>;
const docText = vi.fn<NonNullable<MediaToolClient["docText"]>>();
const peerSeen: Array<{ request: Request; bytes: Buffer; sha256: string }> = [];
const directories: string[] = [];
const cleaned: string[] = [];
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let client: MediaToolClient;
let originalReadTo: StorageProvider["readTo"];

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "lyx-doc-db-")));
  workDir = join(root, "work");
  await mkdir(workDir);
  const socketPath = join(root, "tool.sock");
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      void (async () => {
        assertNotInTransaction("document protocol peer");
        if (req.url !== "/docText" || req.method !== "POST") {
          res.writeHead(404).end();
          return;
        }
        const request = RequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        const bytes = await readFile(join(workDir, request.path));
        peerSeen.push({ request, bytes, sha256: hash(bytes) });
        const id = String(req.headers["x-lyx-call-id"]);
        res.writeInformation(102, { "x-lyx-call-id": id, "x-lyx-instance": peerInstance });
        res.writeHead(200, {
          "content-type": "application/json",
          "x-lyx-call-id": id,
          "x-lyx-instance": peerInstance,
          "x-lyx-complete": "1",
        });
        res.end(JSON.stringify({ ok: true, ...peerFacts }));
      })().catch(() => res.writeHead(503).end(JSON.stringify({ ok: false, code: "internal" })));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  client = createMediaToolClient({ workDir, socketPath, responseTimeoutMs: 2000 });
  h = await createMediaAssetsHarness(await database.prisma(), {
    production: (fake) => {
      originalReadTo = fake.storage.readTo;
      production = {
        tool: { ...client, docText },
        workspace: createMediaWorkspace({
          workDir,
          storage: fake.storage,
          beforeCall: () => assertNotInTransaction("document workspace IO"),
          registerCleanup: (directory) => {
            directories.push(directory);
          },
          beforeCleanup: async (directory) => {
            cleaned.push(directory);
          },
        }),
        cloud: fake.media,
        config: {
          aigc: {
            Label: "1",
            ContentProducer: "PUBLIC-SYSTEM",
            ReservedCode1: "",
            ContentPropagator: "",
            ReservedCode2: "",
          },
          templates: {
            normalize: "normalize",
            sample: "sample",
            sd: "sd",
            hd: "hd",
            brand: "brand",
            ai: "ai",
          },
        },
        parameters: async () => {
          throw new Error("document tests must not use production parameters");
        },
        readStoreFacts: async () => ({ name: "公开虚构店铺" }),
      };
      return production;
    },
  });
}, 120_000);

beforeEach(() => {
  h.fake.storage.resetCalls();
  h.fake.media.resetCalls();
  h.fake.llm.resetCalls();
  h.permitControlledModel(false);
  peerSeen.length = 0;
  directories.length = 0;
  cleaned.length = 0;
  peerFacts = textFacts();
  production.tool.docText = docText;
  docText.mockReset();
  docText.mockImplementation(async (input) => {
    assertNotInTransaction("document tool IO");
    expect(input).toMatchObject({ maxChars: 10000, timeoutMs: 10000 });
    expect(input.signal).toBeInstanceOf(AbortSignal);
    return client.docText!(input);
  });
  vi.spyOn(h.fake.storage, "readTo").mockImplementation(async (input) => {
    assertNotInTransaction("document object download");
    return originalReadTo(input);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  expect(cleaned).toEqual(directories);
  expect(await readdir(workDir)).toEqual([]);
});
afterAll(async () => {
  try {
    await h?.close();
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (root) await rm(root, { recursive: true, force: true });
  }
});

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function bytes() {
  return Buffer.from(`公开虚构文档 ${sequence++}，仅供测试。`);
}
// Actual ECMA-182 upload fingerprint, rather than editing CRC/size to force a hit.
function crc64(body: Uint8Array) {
  let value = 0n;
  const mask = (1n << 64n) - 1n;
  for (const byte of body) {
    value ^= BigInt(byte) << 56n;
    for (let bit = 0; bit < 8; bit++)
      value = (value & (1n << 63n) ? (value << 1n) ^ 0x42f0e1eba9ea3693n : value << 1n) & mask;
  }
  return value.toString();
}
async function stored(body = bytes(), ext = "txt", actor = h.owner) {
  const head = h.fake.storage.head;
  const metadata = vi.spyOn(h.fake.storage, "head").mockImplementation(async (input) => {
    const result = await head(input);
    const object = h.fake.storage.objects.get(`${input.bucket}/${input.key}`);
    return result.ok && result.value.exists && object
      ? ok({ ...result.value, crc64: crc64(object.body) })
      : result;
  });
  try {
    const item = (
      await h.media.register(actor, {
        category: "store_asset",
        files: [
          {
            fileName: `document.${ext}`,
            sizeBytes: String(body.byteLength),
            clientToken: uuidv7(),
          },
        ],
      })
    ).items[0]!;
    h.fake.storage.put(
      { bucket: "asset", key: item.key },
      body,
      ext === "pdf"
        ? "application/pdf"
        : ext === "docx"
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "text/plain",
    );
    await h.media.complete(actor, item.fileId);
    const promote = await h.prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${item.fileId}` },
    });
    await h.media.jobs.run({ jobId: promote.id });
    const file = await h.prisma.fileObject.findUniqueOrThrow({ where: { id: item.fileId } });
    expect(file).toMatchObject({
      status: "stored",
      ext,
      crc64: crc64(body),
      sizeBytes: BigInt(body.byteLength),
    });
    return file;
  } finally {
    metadata.mockRestore();
  }
}
async function ready(body = bytes(), ext = "txt", actor = h.owner) {
  const file = await stored(body, ext, actor);
  const asset = await h.media.assets.create(actor, { type: "document", fileIds: [file.id] });
  const job = await h.prisma.mediaJob.findFirstOrThrow({
    where: {
      parentType: "store_asset",
      parentId: asset.storeAssetId,
      kind: "doc_extract",
    },
  });
  expect(job).toMatchObject({
    mode: "local",
    provider: "mediatool",
    state: "queued",
    attemptNo: 0,
  });
  expect(job.deadlineAt.getTime() - job.createdAt.getTime()).toBe(900_000);
  return { assetId: asset.storeAssetId, file, job, body };
}
type Ready = Awaited<ReturnType<typeof ready>>;
const row = (id: string) => h.prisma.mediaJob.findUniqueOrThrow({ where: { id } });
const assetRow = (id: string) => h.prisma.storeAsset.findUniqueOrThrow({ where: { id } });
const insights = (assetId: string) =>
  h.prisma.storeAssetInsight.findMany({
    where: { storeAssetId: assetId, kind: "doc_text" },
    orderBy: { id: "asc" },
  });
const events = (assetId: string) =>
  h.prisma.outboxEvent.findMany({ where: { aggregateId: assetId }, orderBy: { id: "asc" } });
async function extract(facts: Ready) {
  await h.media.jobs.run({ jobId: facts.job.id });
  expect(await row(facts.job.id)).toMatchObject({
    state: "succeeded",
    attemptNo: 1,
    leaseOwner: null,
  });
  const rows = await insights(facts.assetId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}
async function audit(facts: Ready) {
  const job = await h.prisma.mediaJob.findFirstOrThrow({
    where: { parentId: facts.assetId, kind: "audit_text" },
  });
  await h.media.jobs.run({ jobId: job.id });
  return row(job.id);
}
function noPaidCalls() {
  expect(h.fake.llm.calls).toEqual([]);
  expect(h.fake.asr.calls).toEqual([]);
}
async function foreignActor(): Promise<MediaActor> {
  const merchant = await h.make.merchant({ verified: true });
  return {
    identity: createIdentityContext({
      actor: { type: "merchant", id: merchant.user.id, client: "weapp", role: "owner" },
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
    }),
    merchant: { entityId: merchant.entity.id, storeId: merchant.store.id, standing: "owner" },
  };
}
async function holdTool(facts: Ready) {
  const held = gate();
  docText.mockImplementation(async (input) => {
    assertNotInTransaction("held document extraction");
    expect(input.signal?.aborted).toBe(false);
    await held.promise;
    return ok(peerFacts);
  });
  const running = h.media.jobs.run({ jobId: facts.job.id });
  void running.catch(() => undefined);
  try {
    await vi.waitFor(() => expect(docText).toHaveBeenCalledOnce(), { timeout: 3000 });
  } catch (error) {
    held.release();
    await running;
    throw error;
  }
  return { release: held.release, running, job: await row(facts.job.id) };
}
async function controlledClaim(facts: Ready) {
  const handler = h.media.jobs.handlers.get("doc_extract")!;
  const claimed = await h.prisma.mediaJob.update({
    where: { id: facts.job.id },
    data: {
      state: "running",
      attemptNo: 1,
      leaseOwner: "controlled-document-caller",
      nextRunAt: new Date(h.clock.now().getTime() + 120000),
    },
  });
  const context = await h.tx.run(async (tx) => {
    await lockRows(tx, "store_asset", [facts.assetId]);
    await lockRows(tx, "media_job", [claimed.id]);
    return handler.prepare!(tx, claimed);
  });
  return { handler, claimed, context };
}

describe("document facts and the existing successor chain", () => {
  it.each([
    {
      name: "UTF8 TXT",
      ext: "txt",
      body: () => Buffer.from(`公开虚构😀 ${sequence++}`),
      facts: () => textFacts("公开虚构😀"),
    },
    {
      name: "GBK TXT",
      ext: "txt",
      body: () => Buffer.concat([Buffer.from("d6d0cec4", "hex"), Buffer.from(` ${sequence++}`)]),
      facts: () => textFacts("中文"),
    },
    {
      name: "DOCX",
      ext: "docx",
      body: () => Buffer.from(docx(`公开虚构段落 ${sequence++}`)),
      facts: () => textFacts("公开虚构段落\n"),
    },
    {
      name: "two-page PDF",
      ext: "pdf",
      body: () => Buffer.from(pdf(`公开虚构页 ${sequence++}`, 2)),
      facts: () => ({ ...textFacts("公开虚构页\n公开虚构页"), pageCount: 2 }),
    },
  ])(
    "$name downloads exact bytes through workspace/socket and saves plain facts",
    async (sample) => {
      peerFacts = sample.facts();
      const facts = await ready(sample.body(), sample.ext);
      const sourceBefore = await h.prisma.fileObject.findUniqueOrThrow({
        where: { id: facts.file.id },
      });
      const insight = await extract(facts);
      expect(insight).toMatchObject({
        status: "ok",
        fileId: facts.file.id,
        mediaJobId: facts.job.id,
        promptVersion: 1,
        content: peerFacts,
        reusedFromStoreAssetInsightId: null,
      });
      expect(Object.keys(insight.content as object).sort()).toEqual(Object.keys(peerFacts).sort());
      expect(peerSeen).toHaveLength(1);
      expect(peerSeen[0]).toMatchObject({
        bytes: facts.body,
        sha256: hash(facts.body),
        request: { ext: sample.ext, maxChars: 10000, timeoutMs: 10000 },
      });
      expect(peerSeen[0]!.request.path).toMatch(/^[A-Za-z0-9-]+\/source\.mp4$/);
      expect(h.fake.storage.callsOf("readTo")).toHaveLength(1);
      expect(await h.prisma.fileObject.findUniqueOrThrow({ where: { id: facts.file.id } })).toEqual(
        sourceBefore,
      );
      const moderated = await audit(facts);
      expect(AssetJobOutputSchema.parse(moderated.output)).toMatchObject({
        status: "ok",
        verdict: "pass",
      });
      expect(h.fake.media.callsOf("auditText")[0]!.input).toMatchObject({ text: peerFacts.text });
      expect(await assetRow(facts.assetId)).toMatchObject({ moderationState: "pass" });
      const view = await h.media.assets.get(h.owner, facts.assetId);
      expect(view).toMatchObject({ pageCount: sample.ext === "pdf" ? 2 : null });
      await h.drain(facts.assetId);
      expect(await assetRow(facts.assetId)).toMatchObject({
        processingState: "processed",
        isInsightPartial: true,
        reviewState: "unreviewed",
      });
      expect(
        await h.prisma.storeAssetInsight.findFirstOrThrow({
          where: { storeAssetId: facts.assetId, kind: "structured_items" },
        }),
      ).toMatchObject({
        status: "skipped",
        content: { reason: "structured_extractor_unconfigured" },
      });
      expect(
        (await events(facts.assetId)).filter((event) => event.eventType === "asset.processed"),
      ).toHaveLength(1);
      noPaidCalls();
    },
  );

  it.each(["pass", "review", "block"] as const)(
    "truncated codepoint prefix keeps confirmed %s without certifying a full document",
    async (verdict) => {
      peerFacts = { text: "😀".repeat(10000), truncated: true, charCount: 10001 };
      const facts = await ready();
      await extract(facts);
      vi.spyOn(h.fake.media, "auditText").mockImplementation(async (input) => {
        assertNotInTransaction("document moderation");
        expect(input.text).toBe("😀".repeat(5000));
        return ok({ processed: true, verdict, labels: [] });
      });
      const result = AssetJobOutputSchema.parse((await audit(facts)).output);
      expect(result).toMatchObject({
        status: "skipped",
        reason: "document_audit_incomplete",
        verdict: verdict === "pass" ? "pending" : verdict,
      });
      expect(await assetRow(facts.assetId)).toMatchObject({
        moderationState: verdict === "pass" ? "pending" : verdict,
        isInsightPartial: true,
      });
      expect((await insights(facts.assetId))[0]!.content).toEqual(peerFacts);
      noPaidCalls();
    },
  );

  it("complete extraction exceeding the UTF16 audit budget still keeps pending/partial", async () => {
    peerFacts = textFacts("😀".repeat(6000));
    const facts = await ready();
    await extract(facts);
    const result = AssetJobOutputSchema.parse((await audit(facts)).output);
    expect(result).toMatchObject({ status: "skipped", verdict: "pending" });
    expect(h.fake.media.callsOf("auditText")[0]!.input).toMatchObject({ text: "😀".repeat(5000) });
    expect(await assetRow(facts.assetId)).toMatchObject({
      moderationState: "pending",
      isInsightPartial: true,
    });
    expect((await insights(facts.assetId))[0]!.content).toEqual(peerFacts);
  });

  it("missing optional tool degrades without model admission, download or fabricated page count", async () => {
    production.tool.docText = undefined;
    const facts = await ready();
    expect(await extract(facts)).toMatchObject({
      status: "skipped",
      content: { reason: "document_extractor_unconfigured" },
    });
    expect(docText).not.toHaveBeenCalled();
    expect(h.fake.storage.callsOf("readTo")).toEqual([]);
    expect(AssetJobOutputSchema.parse((await audit(facts)).output)).toMatchObject({
      verdict: "pending",
    });
    expect(await h.media.assets.get(h.owner, facts.assetId)).toMatchObject({ pageCount: null });
    noPaidCalls();
  });
});

describe("bounded inputs and untrusted tool results", () => {
  it.each(["unsupported", "sizeBytes", "etag", "oversize"] as const)(
    "rejects %s before workspace or parser IO",
    async (change) => {
      const facts = await ready();
      // Asset creation admits only supported formats. Recreate an obsolete stored-row
      // and matching job snapshot after that public validation to exercise execution.
      const file = await h.prisma.fileObject.update({
        where: { id: facts.file.id },
        data:
          change === "unsupported"
            ? { ext: "xlsx" }
            : change === "sizeBytes"
              ? { sizeBytes: null }
              : change === "etag"
                ? { etag: null }
                : { sizeBytes: 20n * 1024n ** 2n + 1n },
      });
      await h.prisma.mediaJob.update({
        where: { id: facts.job.id },
        data: {
          input: {
            ...AssetJobInputSchema.parse(facts.job.input),
            etag: file.etag,
            sizeBytes: file.sizeBytes?.toString() ?? null,
          },
        },
      });
      if (change === "sizeBytes") {
        // The existing current() fingerprint guard rejects an absent size before claim.
        await h.media.jobs.run({ jobId: facts.job.id });
        expect(await row(facts.job.id)).toMatchObject({ state: "canceled", attemptNo: 0 });
        expect(await insights(facts.assetId)).toEqual([]);
      } else {
        expect(await extract(facts)).toMatchObject({
          status: "skipped",
          content: {
            reason:
              change === "unsupported"
                ? "document_format_unsupported"
                : change === "oversize"
                  ? "document_text_limit"
                  : "document_missing",
          },
        });
        expect(await assetRow(facts.assetId)).toMatchObject({ isInsightPartial: true });
      }
      expect(docText).not.toHaveBeenCalled();
      expect(directories).toEqual([]);
      expect(h.fake.storage.callsOf("readTo")).toEqual([]);
    },
  );

  it.each(["malformed", "txt-pages", "pdf-no-pages", "throw"] as const)(
    "refuses %s and keeps sensitive diagnostics out of persisted rows",
    async (change) => {
      const facts = await ready(
        change === "pdf-no-pages" ? Buffer.from(pdf(`fixture ${sequence++}`)) : bytes(),
        change === "pdf-no-pages" ? "pdf" : "txt",
      );
      const candidates: unknown[] =
        change === "malformed"
          ? [
              null,
              { text: "visible", charCount: 99, truncated: false },
              { text: "visible", charCount: 7, truncated: true },
              { text: " ", charCount: 1, truncated: false },
              { text: "x".repeat(10001), charCount: 10001, truncated: false },
              { ...textFacts(), html: "<p>private-parser-fragment</p>" },
            ]
          : change === "txt-pages"
            ? [{ ...textFacts(), pageCount: 1 }]
            : change === "pdf-no-pages"
              ? [textFacts()]
              : [null];
      // Each malformed reply gets its own real job/asset; no successful row is recycled.
      for (let index = 0; index < candidates.length; index++) {
        const current = index === 0 ? facts : await ready();
        docText.mockImplementation(async () => {
          assertNotInTransaction("hostile document result");
          if (change === "throw")
            throw new Error("vendor-sensitive-error https://private.invalid/?secret=fixture");
          return ok(candidates[index]) as ProviderResult<DocTextResult>;
        });
        const result = await extract(current);
        expect(result.status).toBe("skipped");
        const persisted = JSON.stringify(
          {
            job: await row(current.job.id),
            insights: await insights(current.assetId),
            events: await events(current.assetId),
          },
          (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
        );
        for (const secret of [
          "vendor-sensitive-error",
          "private.invalid",
          "private-parser-fragment",
        ])
          expect(persisted).not.toContain(secret);
        expect(await assetRow(current.assetId)).toMatchObject({ isInsightPartial: true });
      }
      noPaidCalls();
    },
  );

  it("actual downloaded SHA must match an already known source SHA before parser IO", async () => {
    const body = bytes(),
      file = await stored(body);
    await h.prisma.fileObject.update({
      where: { id: file.id },
      data: { sha256: hash(Buffer.from("different public fixture")) },
    });
    const asset = await h.media.assets.create(h.owner, { type: "document", fileIds: [file.id] });
    const job = await h.prisma.mediaJob.findFirstOrThrow({
      where: { parentId: asset.storeAssetId, kind: "doc_extract" },
    });
    expect(await extract({ assetId: asset.storeAssetId, file, body, job })).toMatchObject({
      status: "skipped",
      content: { reason: "document_source_invalid" },
    });
    expect(h.fake.storage.callsOf("readTo")).toHaveLength(1);
    expect(docText).not.toHaveBeenCalled();
  });
});

describe("document cache keeps source identity and format semantics", () => {
  it.each(["same", "foreign", "ext", "sha", "fingerprint", "prompt", "legacy"] as const)(
    "%s candidate is copied only when all current facts permit it",
    async (change) => {
      const body = bytes(),
        first = await ready(body);
      const source = await extract(first);
      let actor = h.owner;
      if (change === "foreign") actor = await foreignActor();
      if (change === "ext") {
        // Polluted old format metadata; CRC/size continue to describe actual uploaded bytes.
        await h.prisma.fileObject.update({ where: { id: first.file.id }, data: { ext: "docx" } });
      }
      if (change === "sha")
        await h.prisma.fileObject.update({
          where: { id: first.file.id },
          data: { sha256: hash(Buffer.from("other fictional bytes")) },
        });
      if (change === "prompt")
        await h.prisma.storeAssetInsight.update({
          where: { id: source.id },
          data: { promptVersion: 2 },
        });
      if (change === "legacy")
        await h.prisma.storeAssetInsight.update({
          where: { id: source.id },
          data: { content: { text: "旧TXT假页数", pageCount: 1 } },
        });
      const historical = await h.prisma.storeAssetInsight.findUniqueOrThrow({
        where: { id: source.id },
      });
      const next = await ready(change === "fingerprint" ? bytes() : body, "txt", actor);
      if (change === "sha")
        await h.prisma.fileObject.update({
          where: { id: next.file.id },
          data: { sha256: hash(body) },
        });
      docText.mockClear();
      h.fake.storage.resetCalls();
      peerSeen.length = 0;
      const result = await extract(next);
      expect(result).toMatchObject({
        status: "ok",
        content: peerFacts,
        reusedFromStoreAssetInsightId: change === "same" ? source.id : null,
      });
      expect(docText).toHaveBeenCalledTimes(change === "same" ? 0 : 1);
      expect(h.fake.storage.callsOf("readTo")).toHaveLength(change === "same" ? 0 : 1);
      expect(
        await h.prisma.storeAssetInsight.findUniqueOrThrow({ where: { id: source.id } }),
      ).toEqual(historical);
      expect(await h.media.assets.get(actor, next.assetId)).toMatchObject({ pageCount: null });
      if (change === "legacy")
        expect(await h.media.assets.get(h.owner, first.assetId)).toMatchObject({ pageCount: null });
      if (change === "same") {
        // Even an already prepared valid cache must re-admit the current source.
        const late = await ready(body),
          { handler, claimed, context } = await controlledClaim(late);
        const before = await row(claimed.id);
        await h.prisma.fileObject.update({
          where: { id: late.file.id },
          data: { etag: '"cache-source-replaced"' },
        });
        expect(await handler.execute(claimed, context, new AbortController().signal)).toEqual({
          state: "canceled",
        });
        expect(await row(claimed.id)).toEqual(before);
        expect(await insights(late.assetId)).toEqual([]);
        expect(docText).not.toHaveBeenCalled();
        expect(h.fake.storage.callsOf("readTo")).toEqual([]);
      }
      noPaidCalls();
    },
  );
});

describe("fresh parent/job/source admission around document IO", () => {
  it.each(["etag", "delete", "block", "lease", "attempt", "run", "deadline"] as const)(
    "%s winner during parser IO discards the late result and preserves winner snapshots",
    async (change) => {
      const facts = await ready();
      const held = await holdTool(facts);
      let winner: MediaJob | undefined;
      let assetBefore: Awaited<ReturnType<typeof assetRow>> | undefined;
      let eventsBefore: Awaited<ReturnType<typeof events>> | undefined;
      try {
        if (change === "etag")
          await h.prisma.fileObject.update({
            where: { id: facts.file.id },
            data: { etag: '"replacement-object"' },
          });
        else if (change === "delete")
          await h.media.assets.remove(h.admin, facts.assetId, { reasonText: "公开测试撤销" });
        else if (change === "block")
          await h.tx.run(async (tx) => {
            await lockRows(tx, "store_asset", [facts.assetId]);
            await tx.storeAsset.update({
              where: { id: facts.assetId },
              data: { moderationState: "block" },
            });
            await advanceAsset(
              tx,
              {
                tx: h.tx,
                clock: h.clock,
                events: h.events,
                assembly: h.assembly,
                storage: h.fake.storage,
                assets: h.assets,
                refTypes: h.assembly.portEntries(fileRefTypePort),
                guards: h.assembly.portEntries(fileCategoryGuardPort),
              },
              facts.assetId,
            );
          });
        else if (change === "run") {
          const input = AssetJobInputSchema.parse(held.job.input),
            runId = uuidv7();
          await h.prisma.mediaJob.create({
            data: {
              id: uuidv7(),
              kind: "doc_extract",
              provider: "mediatool",
              mode: "local",
              parentType: "store_asset",
              parentId: facts.assetId,
              subjectType: "file_object",
              subjectId: facts.file.id,
              input: { ...input, runId },
              state: "queued",
              nextRunAt: h.clock.now(),
              deadlineAt: held.job.deadlineAt,
              dedupeKey: `asset:${facts.assetId}:${runId}:doc_extract:${facts.file.id}:v${input.promptVersion}`,
              createdAt: new Date(h.clock.now().getTime() + 1),
              updatedAt: h.clock.now(),
            },
          });
        } else if (change === "deadline")
          await h.prisma.mediaJob.update({
            where: { id: held.job.id },
            data: { deadlineAt: new Date(h.clock.now().getTime() - 1) },
          });
        else
          winner = await h.prisma.mediaJob.update({
            where: { id: held.job.id },
            data:
              change === "lease"
                ? {
                    leaseOwner: "new-document-owner",
                    nextRunAt: new Date(h.clock.now().getTime() + 120000),
                  }
                : {
                    attemptNo: held.job.attemptNo + 1,
                    leaseOwner: "new-document-attempt",
                    nextRunAt: new Date(h.clock.now().getTime() + 120000),
                  },
          });
        assetBefore = await assetRow(facts.assetId);
        eventsBefore = await events(facts.assetId);
      } finally {
        held.release();
        await held.running;
      }
      expect(await insights(facts.assetId)).toEqual(
        change === "deadline"
          ? [
              expect.objectContaining({
                status: "failed",
                content: { reason: "MEDIA_JOB_DEADLINE" },
              }),
            ]
          : [],
      );
      if (winner) expect(await row(held.job.id)).toEqual(winner);
      else if (change === "deadline")
        expect(await row(held.job.id)).toMatchObject({
          state: "failed",
          errorCode: "MEDIA_JOB_DEADLINE",
        });
      else expect(await row(held.job.id)).toMatchObject({ state: "canceled" });
      // Deadline exhaustion may converge the original run; other late results may not
      // create a successor or event, or overwrite a parent settled by another action.
      if (change !== "deadline") {
        expect(await assetRow(facts.assetId)).toEqual(assetBefore);
        expect(await events(facts.assetId)).toEqual(eventsBefore);
      }
      expect(docText).toHaveBeenCalledOnce();
    },
  );

  it("source replaced while download completes is rejected before parser IO", async () => {
    const facts = await ready();
    const held = gate();
    let entered = false;
    vi.spyOn(h.fake.storage, "readTo").mockImplementation(async (input) => {
      const result = await originalReadTo(input);
      assertNotInTransaction("held document download");
      entered = true;
      await held.promise;
      return result;
    });
    const running = h.media.jobs.run({ jobId: facts.job.id });
    try {
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 3000 });
      await h.prisma.fileObject.update({
        where: { id: facts.file.id },
        data: { etag: '"new-source-after-read"' },
      });
    } finally {
      held.release();
      await running;
    }
    expect(docText).not.toHaveBeenCalled();
    expect(await row(facts.job.id)).toMatchObject({ state: "canceled" });
    expect(await insights(facts.assetId)).toEqual([]);
  });

  it("claim waits for the real parent lock before any download and writes one result after release", async () => {
    const facts = await ready(),
      locked = gate(),
      unlock = gate();
    const observer = await connectTestDatabase(database.name, { role: null });
    let blockerPid: number;
    const parent = h.tx.run(async (tx) => {
      await lockRows(tx, "store_asset", [facts.assetId]);
      const session = await tx.$queryRaw<
        Array<{ pid: number }>
      >`SELECT pg_backend_pid()::int AS pid`;
      blockerPid = session[0]!.pid;
      locked.release();
      await unlock.promise;
    });
    let running: Promise<void> | undefined;
    try {
      await Promise.race([
        locked.promise,
        parent.then(() => {
          throw new Error("parent lock ended before observation");
        }),
      ]);
      running = h.media.jobs.run({ jobId: facts.job.id });
      await vi.waitFor(
        async () => {
          const blocked = await observer.query<{ count: string }>(
            `
          SELECT count(*)::bigint AS count FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock'
            AND query LIKE '%store_asset%' AND $1=ANY(pg_blocking_pids(pid))
        `,
            [blockerPid!],
          );
          expect(Number(blocked.rows[0]!.count)).toBeGreaterThan(0);
        },
        { timeout: 3000 },
      );
      expect(docText).not.toHaveBeenCalled();
      expect(h.fake.storage.callsOf("readTo")).toEqual([]);
      expect(await insights(facts.assetId)).toEqual([]);
    } finally {
      unlock.release();
      try {
        await parent;
        await running;
      } finally {
        await observer.end();
      }
    }
    expect(await row(facts.job.id)).toMatchObject({ state: "succeeded" });
    expect(await insights(facts.assetId)).toHaveLength(1);
    expect(docText).toHaveBeenCalledOnce();
  });

  it("terminal replay preserves whole job, insight and event snapshots with zero repeated IO", async () => {
    const facts = await ready();
    await extract(facts);
    await h.drain(facts.assetId);
    const jobBefore = await row(facts.job.id),
      rowsBefore = await insights(facts.assetId);
    const assetBefore = await assetRow(facts.assetId),
      eventsBefore = await events(facts.assetId);
    docText.mockClear();
    h.fake.storage.resetCalls();
    await Promise.all([
      h.media.jobs.run({ jobId: facts.job.id }),
      h.media.jobs.run({ jobId: facts.job.id }),
    ]);
    expect(await row(facts.job.id)).toEqual(jobBefore);
    expect(await insights(facts.assetId)).toEqual(rowsBefore);
    expect(await assetRow(facts.assetId)).toEqual(assetBefore);
    expect(await events(facts.assetId)).toEqual(eventsBefore);
    expect(docText).not.toHaveBeenCalled();
    expect(h.fake.storage.callsOf("readTo")).toEqual([]);
  });

  it("caller abort during extraction propagates the original signal and cleans the real workspace", async () => {
    const facts = await ready(),
      controller = new AbortController();
    const { handler, claimed, context } = await controlledClaim(facts);
    docText.mockImplementation(async (input) => {
      assertNotInTransaction("aborted document tool");
      expect(input.signal).toBe(controller.signal);
      return new Promise((resolve) => {
        input.signal!.addEventListener("abort", () => resolve(failed("unavailable", "canceled")), {
          once: true,
        });
      });
    });
    const running = handler.execute(claimed, context, controller.signal);
    try {
      await vi.waitFor(() => expect(docText).toHaveBeenCalledOnce(), { timeout: 3000 });
      controller.abort("public-caller-abort");
      expect(await running).toEqual({ state: "canceled" });
    } finally {
      controller.abort();
      await running;
    }
    // Direct handler invocation proves cancellation without inventing runner settlement.
    expect(await row(claimed.id)).toEqual(claimed);
    expect(await insights(facts.assetId)).toEqual([]);
    expect(cleaned).toHaveLength(1);
    expect(await readdir(workDir)).toEqual([]);
  });
});
