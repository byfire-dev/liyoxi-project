import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { assertNotInTransaction, uuidv7 } from "../../kernel/index.js";
import { createMediaAssetsHarness, useSeededDatabase } from "../../testing/index.js";
import { createMediaWorkspace } from "../../providers/mediatool/work-io.js";
import { DocTextResponseSchema } from "../../providers/mediatool/schema.js";
import type { MediaToolClient } from "../../providers/types.js";
import { failed, ok } from "../../providers/types.js";

// Real DB/strategy/workspace plus the accepted Linux parser. The test-only transport moves
// this workspace's public fixture bytes to the original shared volume, never parses on host.
const database = useSeededDatabase("services");
const repository = fileURLToPath(new URL("../../../../../", import.meta.url));
const compose = resolve(repository, "infra/docker/mediatool/compose.verify.yml");
const session = z
  .string()
  .regex(/^[a-z0-9]{1,12}$/)
  .parse(process.env.LYX_TEST_SESSION);
const project = `lyx-doc-strategy-${session}`;
const imageManifest = "sha256:08340b032c22d3cb46622bf23e4aeee127782edca3f514573144ba1040aa4020";
const children = new Set<number>();
const observed: { ext: string; size: number; sha256: string; maxChars: number }[] = [];
let root: string;
let h: Awaited<ReturnType<typeof createMediaAssetsHarness>>;
let specimens: Record<"txt" | "docx" | "pdf", Uint8Array>;
let started = false;

async function docker(args: string[], input = "", signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(60000);
  const stage =
    args[0] === "image"
      ? "image_identity"
      : args[0] === "inspect"
        ? args.at(-1) === "{{json .ImageManifestDescriptor}}"
          ? "runtime_manifest"
          : "runtime_metadata"
        : args[5] === "run"
          ? "fixture_or_caller"
          : "compose";
  return new Promise<string>((resolvePromise, reject) => {
    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (child.pid) children.add(child.pid);
    const chunks: Buffer[] = [];
    let length = 0;
    let error: Error | undefined;
    child.on("error", (value) => {
      error = value;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > 1024 ** 2) child.kill("SIGTERM");
      else chunks.push(chunk);
    });
    // Container diagnostics are not fixture evidence and may contain parser input.
    child.stderr.resume();
    child.on("close", (code) => {
      if (child.pid) children.delete(child.pid);
      if (error || code !== 0 || length > 1024 ** 2)
        reject(new Error(`owned document container command failed: ${stage}, exit ${code}`));
      else resolvePromise(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", (value) => {
      error = value;
    });
    child.stdin.end(input);
  });
}
const command = (...args: string[]) => ["compose", "-f", compose, "-p", project, ...args];
const run = (service: "fixtures" | "caller", script: string, input = "", signal?: AbortSignal) =>
  docker(
    command(
      "run",
      "--rm",
      "--no-deps",
      "--pull",
      "never",
      "-T",
      service,
      "node",
      "--input-type=module",
      "-e",
      script,
    ),
    input,
    signal,
  );

const prepare = `
import {docx,pdf} from '/verify/lib/document-fixtures.mjs';
const result={txt:Buffer.from('虚构正文😀').toString('base64'),
  docx:Buffer.from(docx('虚构正文😀',{tableText:'表格不应抽取'})).toString('base64'),
  pdf:Buffer.from(pdf('虚构正文😀',2)).toString('base64')};
process.stdout.write(JSON.stringify(result));`;
const stage = String.raw`
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(!/^[0-9a-f-]+-[1-9][0-9]*-[A-Za-z0-9_-]+\/source\.mp4$/.test(value.path))throw Error('path');
const destination=join('/work',value.path);
await mkdir(dirname(destination),{recursive:true});
const bytes=Buffer.from(value.bytes,'base64');
await writeFile(destination,bytes,{flag:'wx'});
process.stdout.write(JSON.stringify({size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));`;
const parse = `
import {call} from '/verify/lib/client.mjs';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
process.stdout.write(JSON.stringify(await call('POST','/docText',
  JSON.parse(Buffer.concat(chunks).toString('utf8')))));`;
const remove = `
import {rm} from 'node:fs/promises';
const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);
const directory=Buffer.concat(chunks).toString('utf8');
if(!/^[0-9a-f-]+-[1-9][0-9]*-[A-Za-z0-9_-]+$/.test(directory))throw Error('directory');
await rm('/work/'+directory,{recursive:true,force:true});`;

const tool: MediaToolClient = {
  health: async () => failed("unavailable", "unused"),
  probe: async () => failed("unavailable", "unused"),
  poster: async () => failed("unavailable", "unused"),
  stampAigc: async () => failed("unavailable", "unused"),
  docText: async (input) => {
    assertNotInTransaction("real isolated document test transport");
    expect(input.path).toMatch(/^[0-9a-f-]+-[1-9][0-9]*-[A-Za-z0-9_-]+\/source\.mp4$/);
    const bytes = await readFile(join(root, input.path));
    observed.push({
      ext: input.ext,
      maxChars: input.maxChars,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const directory = input.path.split("/")[0]!;
    try {
      const staged = z
        .object({ size: z.number(), sha256: z.string() })
        .parse(
          JSON.parse(
            await run(
              "fixtures",
              stage,
              JSON.stringify({ path: input.path, bytes: bytes.toString("base64") }),
              input.signal,
            ),
          ),
        );
      expect(staged).toEqual({
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      const response = z.object({ status: z.literal(200), json: z.unknown() }).parse(
        JSON.parse(
          await run(
            "caller",
            parse,
            JSON.stringify({
              path: input.path,
              ext: input.ext,
              maxChars: input.maxChars,
              timeoutMs: input.timeoutMs,
            }),
            input.signal,
          ),
        ),
      );
      const parsed = DocTextResponseSchema.parse(response.json);
      if (!parsed.ok) return failed("rejected", "isolated document rejected");
      const { ok: _, ...value } = parsed;
      return ok(value);
    } finally {
      await run("fixtures", remove, directory);
    }
  },
};

beforeAll(async () => {
  const imageIndex = (
    await docker(["image", "inspect", "liyoxi/mediatool:verify", "--format", "{{.Id}}"])
  ).trim();
  expect(imageIndex).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(
    await docker([
      "image",
      "inspect",
      "--platform",
      "linux/arm64",
      "liyoxi/mediatool:verify",
      "--format",
      "{{.Id}}",
    ]),
  ).toBe(`${imageManifest}\n`);
  root = await mkdtemp(join(tmpdir(), "lyx-doc-strategy-"));
  started = true;
  await docker(
    command(
      "up",
      "-d",
      "--no-build",
      "--pull",
      "never",
      "--wait",
      "--wait-timeout",
      "60",
      "mediatool",
    ),
  );
  const id = (await docker(command("ps", "-q", "mediatool"))).trim();
  expect((await docker(["inspect", id, "--format", "{{.Image}}"])).trim()).toBe(imageIndex);
  z.object({ digest: z.literal(imageManifest) }).parse(
    JSON.parse(await docker(["inspect", id, "--format", "{{json .ImageManifestDescriptor}}"])),
  );
  const sandbox = z
    .object({
      NetworkMode: z.literal("none"),
      ReadonlyRootfs: z.literal(true),
      Memory: z.literal(1024 ** 3),
      NanoCpus: z.literal(1e9),
      PidsLimit: z.literal(128),
      CapDrop: z.array(z.string()),
      CapAdd: z.array(z.string()).nullable(),
      Privileged: z.literal(false),
      SecurityOpt: z.array(z.string()),
    })
    .parse(JSON.parse(await docker(["inspect", id, "--format", "{{json .HostConfig}}"])));
  expect(sandbox.CapDrop).toEqual(["ALL"]);
  expect(sandbox.CapAdd ?? []).toEqual([]);
  expect(sandbox.SecurityOpt).toContain("no-new-privileges:true");
  expect((await docker(["inspect", id, "--format", "{{.Config.User}}"])).trim()).toBe("1000:1000");
  const fixture = z
    .object({ txt: z.string(), docx: z.string(), pdf: z.string() })
    .parse(JSON.parse(await run("fixtures", prepare)));
  specimens = {
    txt: Buffer.from(fixture.txt, "base64"),
    docx: Buffer.from(fixture.docx, "base64"),
    pdf: Buffer.from(fixture.pdf, "base64"),
  };
  h = await createMediaAssetsHarness(await database.prisma(), {
    production: (fake) => ({
      tool,
      workspace: createMediaWorkspace({
        workDir: root,
        storage: fake.storage,
        beforeCall: () => assertNotInTransaction("real doc workspace"),
      }),
      cloud: fake.media,
      config: {
        aigc: {
          Label: "1",
          ContentProducer: "PUBLIC-TEST",
          ContentPropagator: "",
          ReservedCode1: "",
          ReservedCode2: "",
        },
        templates: {
          normalize: "normalize",
          sd: "sd",
          hd: "hd",
          sample: "sample",
          brand: "brand",
          ai: "ai",
        },
      },
      parameters: async () => {
        throw new Error("document does not request production parameters");
      },
      readStoreFacts: async () => null,
    }),
  });
}, 120000);

afterAll(async () => {
  try {
    await h?.close();
  } finally {
    try {
      if (started) {
        await docker(command("down", "--volumes", "--remove-orphans", "--timeout", "10"));
        const label = `label=com.docker.compose.project=${project}`;
        expect((await docker(["ps", "-a", "-q", "--filter", label])).trim()).toBe("");
        expect((await docker(["volume", "ls", "-q", "--filter", label])).trim()).toBe("");
      }
    } finally {
      if (root) await rm(root, { recursive: true, force: true });
      expect(children.size).toBe(0);
      vi.restoreAllMocks();
    }
  }
}, 120000);

it.each(["txt", "docx", "pdf"] as const)(
  "真实 %s 字节经隔离 socket 保存文档事实并推进审核，重放零重复",
  async (ext) => {
    const bytes = specimens[ext];
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThan(32 * 1024);
    const item = (
      await h.media.register(h.owner, {
        category: "store_asset",
        files: [
          { fileName: `public.${ext}`, sizeBytes: String(bytes.length), clientToken: uuidv7() },
        ],
      })
    ).items[0]!;
    h.fake.storage.put(
      { bucket: "asset", key: item.key },
      bytes,
      ext === "txt"
        ? "text/plain"
        : ext === "pdf"
          ? "application/pdf"
          : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    await h.media.complete(h.owner, item.fileId);
    const promote = await h.prisma.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `promote:${item.fileId}` },
    });
    await h.media.jobs.run({ jobId: promote.id });
    const asset = await h.media.assets.create(h.owner, {
      type: "document",
      fileIds: [item.fileId],
    });
    await h.drain(asset.storeAssetId);
    const jobs = await h.prisma.mediaJob.findMany({ where: { parentId: asset.storeAssetId } });
    const extract = jobs.find((row) => row.kind === "doc_extract")!;
    expect(extract).toMatchObject({
      state: "succeeded",
      attemptNo: 1,
      mode: "local",
      provider: "mediatool",
    });
    expect(jobs.find((row) => row.kind === "audit_text")).toMatchObject({ state: "succeeded" });
    const row = await h.prisma.storeAssetInsight.findFirstOrThrow({
      where: { storeAssetId: asset.storeAssetId, kind: "doc_text" },
    });
    const value = z
      .object({
        text: z.string(),
        charCount: z.number().int(),
        truncated: z.literal(false),
        pageCount: z.number().optional(),
      })
      .parse(row.content);
    expect(row.status).toBe("ok");
    expect(value.text).toContain("虚构正文😀");
    expect(value.text).not.toContain("表格不应抽取");
    expect(value.charCount).toBe(Array.from(value.text).length);
    expect(value.pageCount).toBe(ext === "pdf" ? 2 : undefined);
    expect(observed.at(-1)).toEqual({
      ext,
      size: bytes.length,
      maxChars: 10000,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const count = observed.length;
    await h.media.jobs.run({ jobId: extract.id });
    expect(observed).toHaveLength(count);
    expect(
      await h.prisma.storeAssetInsight.count({
        where: { storeAssetId: asset.storeAssetId, kind: "doc_text" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.storeAsset.findUniqueOrThrow({ where: { id: asset.storeAssetId } }),
    ).toMatchObject({
      processingState: "processed",
      reviewState: "unreviewed",
      moderationState: "pass",
      isInsightPartial: true,
    });
  },
  180000,
);
