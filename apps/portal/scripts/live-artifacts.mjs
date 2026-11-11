// Only these validated in-memory buffers may be copied into the CI upload root.
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { assertRunId, assertVersion, diagnosticLine } from "./live-protocol.mjs";

export const CASE_IDS = Object.freeze([
  "portal-authorize-revoke",
  "portal-logout",
  "portal-rejected-csrf",
  "preview-ad-playback",
  "preview-ad-stale-channel",
  "preview-cross-store-q9",
  "preview-revoke-media",
  "verify-revisions",
  "verify-lifecycle-reporting",
  "preview-expired-media",
]);
export const SHOT_IDS = Object.freeze([
  "session-ready",
  "session-revoked",
  "session-logout",
  "ticket-rejected",
  "ad-initial",
  "ad-playing",
  "ad-version-changed",
  "ad-channel-unavailable",
  "sample-q9",
  "ad-cross-store",
  "ad-revoked",
  "verify-current",
  "verify-pending",
  "verify-outdated",
  "verify-revision-missing",
  "verify-expired",
  "verify-voided",
  "verify-invalid",
  "ad-expired",
  "ad-renewed",
]);
const PORTAL = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SAFE_OUTPUT_ROOT = join(PORTAL, "dist/e2e-live-safe");
const MAX_DURATION_MS = 10 * 60_000;
const captures = new WeakMap();
const SENTINEL = "PUBLIC-PORTAL-ERROR-SENTINEL";
const fail = () => new Error("PORTAL_LIVE_SAFE_OUTPUT_REJECTED");
// Filesystem/parser failures must not expose paths, source bytes or original exceptions.
async function boundedFailure(action) {
  let value,
    rejected = false;
  try {
    value = await action();
  } catch {
    rejected = true;
  }
  if (rejected) throw fail();
  return value;
}
const duration = (value) => Number.isFinite(value) && value >= 0 && value <= MAX_DURATION_MS;
const imageHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw fail();
}
export function safeCases(raw) {
  exact(raw, ["status", "rejectedOutput", "cases"]);
  if (
    !["passed", "failed", "timedout", "interrupted"].includes(raw.status) ||
    raw.rejectedOutput !== false ||
    !Array.isArray(raw.cases) ||
    raw.cases.length > CASE_IDS.length
  )
    throw fail();
  const seen = new Set();
  const cases = raw.cases.map((item) => {
    exact(item, ["id", "status", "durationMs"]);
    if (
      !CASE_IDS.includes(item.id) ||
      seen.has(item.id) ||
      !["passed", "failed", "timedOut", "skipped", "interrupted"].includes(item.status) ||
      !duration(item.durationMs)
    )
      throw fail();
    seen.add(item.id);
    return { id: item.id, status: item.status, durationMs: Math.round(item.durationMs) };
  });
  if (
    raw.status === "passed" &&
    (cases.length !== CASE_IDS.length || cases.some((item) => item.status !== "passed"))
  )
    throw fail();
  return { status: raw.status, rejectedOutput: false, cases };
}
export function safePng(bytes) {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > 10 * 1024 * 1024 ||
    !bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  )
    throw fail();
  let offset = 8,
    first = true,
    image = false,
    ended = false,
    chunks = 0;
  const metadata = new Set();
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset),
      type = bytes.toString("latin1", offset + 4, offset + 8);
    if (
      ++chunks > 256 ||
      offset + 12 + length > bytes.length ||
      !["IHDR", "IDAT", "IEND", "sRGB", "gAMA", "cHRM", "pHYs"].includes(type) ||
      crc32(bytes.subarray(offset + 4, offset + 8 + length)) !==
        bytes.readUInt32BE(offset + 8 + length)
    )
      throw fail();
    if (first) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        bytes.readUInt32BE(offset + 8) !== 1440 ||
        bytes.readUInt32BE(offset + 12) !== 900 ||
        bytes[offset + 16] !== 8 ||
        ![2, 6].includes(bytes[offset + 17]) ||
        bytes.subarray(offset + 18, offset + 21).some((value) => value !== 0)
      )
        throw fail();
      first = false;
    } else if (type === "IHDR") throw fail();
    if (["sRGB", "gAMA", "cHRM", "pHYs"].includes(type)) {
      if (image || metadata.has(type) || length !== { sRGB: 1, gAMA: 4, cHRM: 32, pHYs: 9 }[type])
        throw fail();
      metadata.add(type);
    }
    if (type === "IDAT") image = true;
    offset += 12 + length;
    if (type === "IEND") {
      ended = length === 0;
      break;
    }
  }
  if (!image || !ended || offset !== bytes.length) throw fail();
  return bytes;
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
async function directoryIdentity(path, privateMode = false) {
  const stat = await lstat(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    stat.uid !== process.getuid() ||
    stat.mode & (privateMode ? 0o077 : 0o022)
  )
    throw fail();
  return stat;
}
async function regularFile(path, limit) {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid() ||
    before.size > limit
  )
    throw fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened) || opened.nlink !== 1 || opened.size > limit) throw fail();
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      size > limit ||
      size !== opened.size ||
      after.size !== opened.size ||
      after.nlink !== 1 ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      !sameFile(after, await lstat(path))
    )
      throw fail();
    return Buffer.from(bytes.subarray(0, size));
  } finally {
    await handle.close();
  }
}
function json(bytes) {
  if (bytes.includes(SENTINEL)) throw fail();
  return JSON.parse(bytes.toString("utf8"));
}
async function isAbsent(path) {
  let missing = false,
    unreadable = false;
  try {
    await lstat(path);
  } catch (error) {
    missing = error.code === "ENOENT";
    unreadable = !missing;
  }
  if (unreadable) throw fail();
  return missing;
}
async function removeOwnedDirectory(path, identity, recursive) {
  if (!identity || !sameFile(identity, await directoryIdentity(path, true))) throw fail();
  if (recursive) await rm(path, { recursive: true });
  else await rmdir(path);
}
export async function collectSafeArtifacts(directory) {
  return boundedFailure(async () => {
    if (typeof directory !== "string") throw fail();
    const base = await realpath("/tmp"),
      owner = dirname(directory);
    const runId = basename(owner).slice("lyx-portal-".length);
    assertRunId(runId);
    if (
      !["/tmp", "/private/tmp"].includes(base) ||
      owner !== join(base, `lyx-portal-${runId}`) ||
      directory !== join(owner, "stage")
    )
      throw fail();
    const ownerIdentity = await directoryIdentity(owner, true),
      stageIdentity = await directoryIdentity(directory, true);
    const entries = await readdir(directory);
    const allowed = new Set([
      "cases.json",
      ...SHOT_IDS.flatMap((id) => [`${id}.png`, `${id}.privacy.json`]),
    ]);
    if (entries.length > allowed.size || entries.some((entry) => !allowed.has(entry))) throw fail();
    let cases = { status: "interrupted", rejectedOutput: false, cases: [] };
    if (entries.includes("cases.json")) {
      const bytes = await regularFile(join(directory, "cases.json"), 64 * 1024);
      cases = safeCases(json(bytes));
    }
    const images = [];
    for (const id of SHOT_IDS) {
      const present = entries.includes(`${id}.png`),
        proof = entries.includes(`${id}.privacy.json`);
      if (present !== proof) throw fail();
      if (!present) continue;
      const privacy = json(await regularFile(join(directory, `${id}.privacy.json`), 128));
      exact(privacy, ["safe"]);
      if (privacy.safe !== true) throw fail();
      images.push({
        name: `${id}.png`,
        bytes: safePng(await regularFile(join(directory, `${id}.png`), 10 * 1024 * 1024)),
      });
    }
    if (cases.status === "passed" && images.length !== SHOT_IDS.length) throw fail();
    if (
      !sameFile(ownerIdentity, await directoryIdentity(owner, true)) ||
      !sameFile(stageIdentity, await directoryIdentity(directory, true)) ||
      entries.sort().join("\0") !== (await readdir(directory)).sort().join("\0")
    )
      throw fail();
    const artifacts = { cases, images };
    captures.set(artifacts, {
      runId,
      cases: JSON.stringify(cases),
      images: new Map(images.map((item) => [item.name, imageHash(item.bytes)])),
    });
    return artifacts;
  });
}
export async function publishSafeArtifacts(root, input) {
  return boundedFailure(async () => {
    exact(input, [
      "runId",
      "version",
      "durationMs",
      "cleanup",
      "processPassed",
      "diagnostics",
      "artifacts",
    ]);
    const { runId, version, durationMs, cleanup, processPassed, diagnostics, artifacts } = input;
    assertRunId(runId);
    assertVersion(version);
    const capture = captures.get(artifacts);
    if (
      root !== SAFE_OUTPUT_ROOT ||
      version.includes(SENTINEL) ||
      !duration(durationMs) ||
      typeof processPassed !== "boolean" ||
      !["confirmed", "unconfirmed"].includes(cleanup) ||
      !Array.isArray(diagnostics) ||
      diagnostics.length > 128 ||
      capture?.runId !== runId
    )
      throw fail();
    exact(artifacts, ["cases", "images"]);
    if (
      !Array.isArray(artifacts.images) ||
      artifacts.images.length > SHOT_IDS.length ||
      capture.images.size !== artifacts.images.length ||
      JSON.stringify(artifacts.cases) !== capture.cases
    )
      throw fail();
    const cases = safeCases(artifacts.cases);
    const diagnosticBytes = Buffer.from(diagnostics.map(diagnosticLine).join(""));
    const summary = {
      runId,
      version,
      success: processPassed && cleanup === "confirmed" && cases.status === "passed",
      cleanup,
      durationMs: Math.round(durationMs),
      passed: cases.cases.filter((item) => item.status === "passed").length,
      failed: cases.cases.filter((item) =>
        ["failed", "timedOut", "interrupted"].includes(item.status),
      ).length,
      skipped: cases.cases.filter((item) => item.status === "skipped").length,
      cases: cases.cases,
    };
    const seen = new Set();
    const files = [
      { name: "result.json", bytes: Buffer.from(`${JSON.stringify(summary)}\n`) },
      { name: "diagnostics.jsonl", bytes: diagnosticBytes },
      ...artifacts.images.map((item) => {
        exact(item, ["name", "bytes"]);
        if (!SHOT_IDS.some((id) => item.name === `${id}.png`) || seen.has(item.name)) throw fail();
        seen.add(item.name);
        const bytes = Buffer.from(safePng(item.bytes));
        if (capture.images.get(item.name) !== imageHash(bytes)) throw fail();
        return { name: item.name, bytes };
      }),
    ];
    if (cases.status === "passed" && seen.size !== SHOT_IDS.length) throw fail();
    // Text has no open strings except the bounded version. PNG pixels are not text/OCR scanned:
    // screenshots rely on the bridge's pre-shot privacy assertion; metadata is rejected above.
    if (files.slice(0, 2).some((file) => file.bytes.includes(SENTINEL))) throw fail();
    // All bytes are validated before creating anything under the fixed application output root.
    await directoryIdentity(PORTAL);
    const dist = join(PORTAL, "dist");
    for (const path of [dist, root]) {
      if (await isAbsent(path)) await mkdir(path, { mode: 0o700 });
      await directoryIdentity(path);
    }
    const distIdentity = await directoryIdentity(dist),
      rootIdentity = await directoryIdentity(root);
    const destination = join(root, runId);
    const absent = async () => {
      if (!(await isAbsent(destination))) throw fail();
    };
    await absent();
    // A same-run exclusive lock prevents concurrent publishers; temporary bytes are outside
    // e2e-live-safe, so an always-upload step cannot observe a partially written run.
    const lock = join(dist, `.portal-live-safe-${runId}.lock`);
    await mkdir(lock, { mode: 0o700 });
    const lockIdentity = await directoryIdentity(lock, true);
    let temporary, temporaryIdentity;
    try {
      await absent();
      temporary = await mkdtemp(join(dist, `.portal-live-safe-${runId}-`));
      temporaryIdentity = await directoryIdentity(temporary, true);
      for (const file of files)
        await writeFile(join(temporary, file.name), file.bytes, { flag: "wx", mode: 0o600 });
      if (
        !sameFile(distIdentity, await directoryIdentity(dist)) ||
        !sameFile(rootIdentity, await directoryIdentity(root))
      )
        throw fail();
      await absent();
      await rename(temporary, destination);
      temporary = undefined;
    } finally {
      try {
        if (temporary) await removeOwnedDirectory(temporary, temporaryIdentity, true);
      } finally {
        await removeOwnedDirectory(lock, lockIdentity, false);
      }
    }
    captures.delete(artifacts);
    return summary;
  });
}
