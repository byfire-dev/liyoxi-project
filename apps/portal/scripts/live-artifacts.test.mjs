import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import {
  CASE_IDS,
  SHOT_IDS,
  SAFE_OUTPUT_ROOT,
  collectSafeArtifacts,
  publishSafeArtifacts,
  safeCases,
  safePng,
} from "./live-artifacts.mjs";
import { createOwnedDirectory } from "./live-edge.mjs";

const REJECTED = /^Error: PORTAL_LIVE_SAFE_OUTPUT_REJECTED$/;
const SENTINEL = "PUBLIC-PORTAL-ERROR-SENTINEL";
const failed = () => ({
  status: "failed",
  rejectedOutput: false,
  cases: [{ id: "portal-logout", status: "failed", durationMs: 1 }],
});
const passed = () => ({
  status: "passed",
  rejectedOutput: false,
  cases: CASE_IDS.map((id) => ({ id, status: "passed", durationMs: 1 })),
});
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]),
    bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  body.copy(bytes, 4);
  bytes.writeUInt32BE(crc32(body), bytes.length - 4);
  return bytes;
}
// A real stdlib-generated 1440x900 PNG, without browser or image-tool dependencies.
function png(extra = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1440);
  header.writeUInt32BE(900, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    ...extra,
    chunk("IDAT", deflateSync(Buffer.alloc((1 + 1440 * 3) * 900))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
async function setup(t, report = failed()) {
  const runId = randomBytes(6).toString("hex"),
    owner = await createOwnedDirectory(runId);
  const stage = join(owner.directory, "stage");
  await mkdir(stage, { mode: 0o700 });
  if (report) await writeFile(join(stage, "cases.json"), JSON.stringify(report));
  t.after(() => owner.close());
  return { runId, owner, stage };
}
function publication(runId, artifacts, values = {}) {
  return {
    runId,
    version: "fixture",
    durationMs: 12,
    cleanup: "confirmed",
    processPassed: true,
    diagnostics: [{ stage: "closing", code: "CLOSED" }],
    artifacts,
    ...values,
  };
}
async function missing(path) {
  await assert.rejects(lstat(path), { code: "ENOENT" });
}
async function screenshot(stage, id, proof = { safe: true }) {
  await writeFile(join(stage, `${id}.png`), png());
  if (proof) await writeFile(join(stage, `${id}.privacy.json`), JSON.stringify(proof));
}

test("report rejects open text, duplicates, unbounded time and false success", () => {
  const report = failed();
  assert.deepEqual(safeCases(report), report);
  for (const bad of [
    { ...report, error: SENTINEL },
    { ...report, rejectedOutput: true },
    { ...report, status: "passed" },
    { ...report, cases: [...report.cases, ...report.cases] },
    { ...report, cases: [{ ...report.cases[0], id: SENTINEL }] },
    ...[Infinity, -1, 600_001].map((durationMs) => ({
      ...report,
      cases: [{ ...report.cases[0], durationMs }],
    })),
  ])
    assert.throws(() => safeCases(bad), REJECTED);
});

test("PNG permits the known screenshot container, rejects text/EXIF/trailing bytes and corrupt CRC", () => {
  const image = png();
  assert.deepEqual(safePng(image), image);
  const corrupt = Buffer.from(image);
  corrupt[corrupt.length - 1] ^= 1;
  for (const bad of [
    Buffer.from(SENTINEL),
    corrupt,
    Buffer.concat([image, Buffer.from(SENTINEL)]),
    ...["tEXt", "iTXt", "zTXt", "eXIf"].map((name) => png([chunk(name, Buffer.from(SENTINEL))])),
  ])
    assert.throws(() => safePng(bad), REJECTED);
});

test("collection rejects unknown files, sensitive text and missing screenshot privacy proof", async (t) => {
  for (const kind of ["unknown", "json", "proof", "false-proof", "missing-proof"]) {
    const { stage, runId } = await setup(t);
    if (kind === "unknown") await writeFile(join(stage, "trace.zip"), SENTINEL);
    if (kind === "json")
      await writeFile(join(stage, "cases.json"), JSON.stringify({ ...failed(), stack: SENTINEL }));
    if (kind === "proof") await screenshot(stage, "session-ready", { safe: true, error: SENTINEL });
    if (kind === "false-proof") await screenshot(stage, "session-ready", { safe: false });
    if (kind === "missing-proof") await screenshot(stage, "session-ready", null);
    await assert.rejects(collectSafeArtifacts(stage), REJECTED);
    await missing(join(SAFE_OUTPUT_ROOT, runId));
  }
});

test("collection rejects root escape, stage symlink, file symlink and hardlink", async (t) => {
  const { owner, stage } = await setup(t, null);
  const outside = join(owner.directory, "private-report.json");
  await writeFile(outside, JSON.stringify(failed()));
  await symlink(outside, join(stage, "cases.json"));
  await assert.rejects(collectSafeArtifacts(stage), REJECTED);
  await rm(join(stage, "cases.json"));
  await link(outside, join(stage, "cases.json"));
  await assert.rejects(collectSafeArtifacts(stage), REJECTED);
  await assert.rejects(collectSafeArtifacts(join(stage, "..")), REJECTED);
  const second = await setup(t, null);
  await rm(second.stage, { recursive: true });
  await symlink(stage, second.stage);
  await assert.rejects(collectSafeArtifacts(second.stage), REJECTED);
  assert.equal(await readFile(outside, "utf8"), JSON.stringify(failed()));
});

test("publication refuses arbitrary targets, wrong run, unsafe diagnostics and modified capture", async (t) => {
  const { runId, owner, stage } = await setup(t);
  const artifacts = await collectSafeArtifacts(stage),
    input = publication(runId, artifacts);
  await assert.rejects(publishSafeArtifacts(join(owner.directory, "safe"), input), REJECTED);
  for (const bad of [
    { ...input, version: SENTINEL },
    { ...input, runId: randomBytes(6).toString("hex") },
    { ...input, diagnostics: [{ stage: "closing", code: SENTINEL }] },
    { ...input, diagnostics: [{ stage: "closing", code: "CLOSED", error: SENTINEL }] },
    { ...input, artifacts: { ...artifacts } },
    { ...input, error: SENTINEL },
  ])
    await assert.rejects(publishSafeArtifacts(SAFE_OUTPUT_ROOT, bad), REJECTED);
  artifacts.cases.cases[0].status = "passed";
  await assert.rejects(publishSafeArtifacts(SAFE_OUTPUT_ROOT, input), REJECTED);
  await missing(join(SAFE_OUTPUT_ROOT, runId));
  await missing(join(owner.directory, "safe"));
});

test("approved in-memory bytes publish after private source cleanup; no private evidence is copied", async (t) => {
  const { runId, owner, stage } = await setup(t, passed());
  for (const id of SHOT_IDS) await screenshot(stage, id);
  const artifacts = await collectSafeArtifacts(stage);
  await writeFile(join(owner.directory, "private-auth.txt"), SENTINEL);
  await owner.close();
  const result = await publishSafeArtifacts(SAFE_OUTPUT_ROOT, publication(runId, artifacts));
  const target = join(SAFE_OUTPUT_ROOT, runId);
  t.after(() => rm(target, { recursive: true }));
  assert.equal(result.success, true);
  assert.equal(result.passed, 3);
  assert.equal(result.failed, 0);
  assert.deepEqual(
    (await readdir(target)).sort(),
    ["result.json", "diagnostics.jsonl", ...SHOT_IDS.map((id) => `${id}.png`)].sort(),
  );
  assert.equal((await lstat(target)).isSymbolicLink(), false);
  assert.deepEqual(JSON.parse(await readFile(join(target, "result.json"), "utf8")), result);
  assert.equal(
    (await readFile(join(target, "diagnostics.jsonl"), "utf8")).includes(SENTINEL),
    false,
  );
});

test("a valid PNG replacement cannot borrow another image's privacy proof", async (t) => {
  const { runId, stage } = await setup(t);
  await screenshot(stage, "session-ready");
  const artifacts = await collectSafeArtifacts(stage);
  const replacement = png([chunk("sRGB", Buffer.from([0]))]);
  assert.deepEqual(safePng(replacement), replacement);
  artifacts.images[0].bytes = replacement;
  await assert.rejects(
    publishSafeArtifacts(SAFE_OUTPUT_ROOT, publication(runId, artifacts)),
    REJECTED,
  );
  await missing(join(SAFE_OUTPUT_ROOT, runId));
});

test("simultaneous same-run publication has one winner and exposes only the complete report", async (t) => {
  const { runId, stage } = await setup(t);
  const first = await collectSafeArtifacts(stage),
    second = await collectSafeArtifacts(stage);
  const results = await Promise.allSettled([
    publishSafeArtifacts(SAFE_OUTPUT_ROOT, publication(runId, first)),
    publishSafeArtifacts(SAFE_OUTPUT_ROOT, publication(runId, second)),
  ]);
  const target = join(SAFE_OUTPUT_ROOT, runId);
  t.after(async () => {
    if (results.some((item) => item.status === "fulfilled")) await rm(target, { recursive: true });
  });
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(
    results.filter((item) => item.status === "rejected" && REJECTED.test(String(item.reason)))
      .length,
    1,
  );
  assert.deepEqual((await readdir(target)).sort(), ["diagnostics.jsonl", "result.json"]);
});

test("existing destination, including a symlink, is preserved; cleanup failure cannot become success", async (t) => {
  const { runId, owner, stage } = await setup(t, passed());
  for (const id of SHOT_IDS) await screenshot(stage, id);
  const result = await publishSafeArtifacts(
    SAFE_OUTPUT_ROOT,
    publication(runId, await collectSafeArtifacts(stage), { cleanup: "unconfirmed" }),
  );
  const target = join(SAFE_OUTPUT_ROOT, runId);
  t.after(() => rm(target, { recursive: true }));
  assert.equal(result.success, false);
  assert.equal(result.cleanup, "unconfirmed");
  const before = await readFile(join(target, "result.json"));
  await assert.rejects(
    publishSafeArtifacts(SAFE_OUTPUT_ROOT, publication(runId, await collectSafeArtifacts(stage))),
    REJECTED,
  );
  assert.deepEqual(await readFile(join(target, "result.json")), before);
  await rm(target, { recursive: true });
  await mkdir(target);
  await assert.rejects(
    publishSafeArtifacts(SAFE_OUTPUT_ROOT, publication(runId, await collectSafeArtifacts(stage))),
    REJECTED,
  );
  assert.deepEqual(await readdir(target), []);
  await rm(target, { recursive: true });
  await symlink(owner.directory, target);
  await assert.rejects(
    publishSafeArtifacts(SAFE_OUTPUT_ROOT, publication(runId, await collectSafeArtifacts(stage))),
    REJECTED,
  );
  assert.equal((await lstat(target)).isSymbolicLink(), true);
  assert.equal((await lstat(owner.directory)).isDirectory(), true);
});
