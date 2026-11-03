// Explicit small-archive protocol fixture. No business rows or successful job states are written here.
import { createHash } from "node:crypto";
import { assertNotInTransaction } from "../kernel/index.js";
import { failed } from "../providers/types.js";
import type { MediaZipPreview, StorageProvider } from "../providers/types.js";
import type { FakeProviders } from "./providers/index.js";
import type { PrismaClient } from "@liyoxi/db";
import { createMedia } from "../media/index.js";
import {
  createDeliveryZipPackages,
  createPublishLists,
  readReleaseZipInput,
} from "../delivery/index.js";
import { productionHarness } from "./delivery-production.fixture.js";
import { released } from "./delivery-release.fixture.js";

const MAX_BYTES = 64 * 1024 * 1024;
const crc32Table = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let value = 0xffffffff;
  for (const byte of bytes) value = (value >>> 8) ^ crc32Table[(value ^ byte) & 255]!;
  return (value ^ 0xffffffff) >>> 0;
};
const mask64 = (1n << 64n) - 1n;
const crc64Table = Array.from({ length: 256 }, (_, index) => {
  let value = BigInt(index) << 56n;
  for (let bit = 0; bit < 8; bit++)
    value = ((value << 1n) ^ (value & (1n << 63n) ? 0x42f0e1eba9ea3693n : 0n)) & mask64;
  return value;
});
/** CRC64/ECMA-182 over the actual local bytes, never a cloud verification claim. */
export function zipFixtureCrc64(bytes: Uint8Array) {
  let value = 0n;
  for (const byte of bytes)
    value = ((value << 8n) ^ crc64Table[Number((value >> 56n) ^ BigInt(byte))]!) & mask64;
  return value.toString();
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
type Entry = { readonly name: string; readonly bytes: Uint8Array };
function archive(entries: readonly Entry[]) {
  const local: Buffer[] = [],
    directory: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8"),
      bytes = Buffer.from(entry.bytes),
      crc = crc32(bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, bytes);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += header.length + name.length + bytes.length;
  }
  const central = Buffer.concat(directory),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, central, end]);
}

/** Independently walk the emitted central directory and verify every local body/CRC. */
export function inspectZipFixture(bytes: Uint8Array): MediaZipPreview {
  const data = Buffer.from(bytes),
    end = data.length - 22;
  if (end < 0 || data.readUInt32LE(end) !== 0x06054b50 || data.readUInt16LE(end + 20) !== 0)
    throw new Error("fixture ZIP end missing");
  const count = data.readUInt16LE(end + 10),
    directoryEnd = data.readUInt32LE(end + 16) + data.readUInt32LE(end + 12);
  let at = data.readUInt32LE(end + 16);
  if (directoryEnd !== end || count < 1 || count > 101 || data.readUInt16LE(end + 8) !== count)
    throw new Error("fixture ZIP directory boundary invalid");
  const entries: Array<{ name: string; sizeBytes: string }> = [];
  for (let index = 0; index < count; index++) {
    if (data.readUInt32LE(at) !== 0x02014b50 || data.readUInt16LE(at + 10) !== 0)
      throw new Error("fixture ZIP directory invalid");
    const length = data.readUInt16LE(at + 28),
      size = data.readUInt32LE(at + 24),
      start = data.readUInt32LE(at + 42);
    const name = data.subarray(at + 46, at + 46 + length).toString("utf8");
    if (
      data.readUInt32LE(start) !== 0x04034b50 ||
      data.readUInt32LE(start + 18) !== size ||
      data.readUInt32LE(start + 22) !== size ||
      data.readUInt16LE(start + 26) !== length ||
      data.subarray(start + 30, start + 30 + length).toString("utf8") !== name
    )
      throw new Error("fixture ZIP local header mismatch");
    const bodyAt = start + 30 + length + data.readUInt16LE(start + 28),
      body = data.subarray(bodyAt, bodyAt + size);
    if (
      body.length !== size ||
      bodyAt + size > data.readUInt32LE(end + 16) ||
      crc32(body) !== data.readUInt32LE(at + 16) ||
      crc32(body) !== data.readUInt32LE(start + 14)
    )
      throw new Error("fixture ZIP payload CRC mismatch");
    entries.push({ name, sizeBytes: String(size) });
    at += 46 + length + data.readUInt16LE(at + 30) + data.readUInt16LE(at + 32);
  }
  if (at !== directoryEnd || new Set(entries.map((entry) => entry.name)).size !== entries.length)
    throw new Error("fixture ZIP incomplete or duplicate directory");
  return { fileCount: entries.length, truncated: false, entries };
}

export function installZipPackageFixture(
  providers: Pick<FakeProviders, "media" | "storage">,
  externalStorage?: StorageProvider,
) {
  const io = externalStorage ?? providers.storage,
    originalPack = providers.media.pack;
  const written = new Map<string, { etag: string; size: number; crc64: string }>();
  const storage: StorageProvider = {
    ...io,
    head: async (input) => {
      const result = await io.head(input),
        proof = written.get(`${input.bucket}/${input.key}`);
      if (
        result.ok &&
        proof &&
        result.value.exists &&
        result.value.etag === proof.etag &&
        result.value.size === proof.size
      )
        return { ...result, value: { ...result.value, crc64: proof.crc64 } };
      return result;
    },
  };
  providers.media.pack = async (input) => {
    assertNotInTransaction("zip-package-fixture");
    if (
      input.bucket !== "media" ||
      input.items.length < 1 ||
      input.items.length > 101 ||
      !/^pkg\/[a-f0-9-]+\/[a-f0-9-]+-\d+\/[a-f0-9-]+-\d+\.zip$/.test(input.dstKey) ||
      input.items.some((item) => /[\\/\p{Cc}]/u.test(item.name)) ||
      new Set(input.items.map((item) => item.name)).size !== input.items.length
    )
      return failed("rejected", "fixture ZIP scope invalid");
    const entries: Entry[] = [];
    let total = 0;
    for (const item of input.items) {
      const src = { bucket: "media" as const, key: item.key },
        head = await io.head({ ...src, signal: input.signal });
      if (
        !head.ok ||
        !head.value.exists ||
        !head.value.etag ||
        (total += head.value.size) > MAX_BYTES
      )
        return failed("rejected", "fixture ZIP source missing or too large");
      const read = await io.readObject({
        ...src,
        maxBytes: head.value.size,
        ifMatchEtag: head.value.etag,
        signal: input.signal,
      });
      if (!read.ok || read.value.length !== head.value.size)
        return failed("rejected", "fixture ZIP source changed");
      entries.push({ name: item.name, bytes: read.value });
    }
    const bytes = archive(entries),
      parsed = inspectZipFixture(bytes);
    if (
      parsed.entries.some(
        (entry) =>
          !entries.some(
            (source) =>
              source.name === entry.name && String(source.bytes.length) === entry.sizeBytes,
          ),
      )
    )
      return failed("rejected", "fixture ZIP independent directory mismatch");
    const before = providers.media.jobs.length,
      result = originalPack(input);
    const job = providers.media.jobs
      .slice(before)
      .find((entry) => entry.kind === "pack" && entry.userData === input.userData);
    // Fake delays model an accepted remote call whose response is late. Produce its actual
    // archive before awaiting that response, so recovery can inspect independent evidence.
    if (!job) return result;
    const target = { bucket: "media" as const, key: input.dstKey };
    const put = await io.putStream({
      ...target,
      body: async function* (active) {
        for (let at = 0; at < bytes.length; at += 64 * 1024) {
          active.throwIfAborted();
          yield bytes.subarray(at, at + 64 * 1024);
        }
      },
      size: bytes.length,
      sha256: sha(bytes),
      contentType: "application/zip",
      contentIdentity: sha(Buffer.from(JSON.stringify([input.userData, input.dstKey, sha(bytes)]))),
      ifAbsent: true,
      signal: input.signal ?? new AbortController().signal,
    });
    if (!put.ok || put.value.size !== bytes.length)
      return failed("rejected", "fixture ZIP upload failed");
    const read = await io.readObject({
      ...target,
      maxBytes: bytes.length,
      ifMatchEtag: put.value.etag,
      signal: input.signal,
    });
    if (!read.ok || sha(read.value) !== sha(bytes))
      return failed("rejected", "fixture ZIP stored bytes changed");
    const proof = { etag: put.value.etag, size: bytes.length, crc64: zipFixtureCrc64(read.value) };
    written.set(`media/${input.dstKey}`, proof);
    if (!externalStorage) {
      const object = providers.storage.objects.get(`media/${input.dstKey}`);
      if (object) object.crc64 = proof.crc64;
    }
    job.output = { zip: { dst: target, fileCount: parsed.fileCount, errorCount: 0 } };
    providers.media.zipPreviews.set(`media/${input.dstKey}`, inspectZipFixture(read.value));
    return result;
  };
  return {
    storage,
    close() {
      providers.media.pack = originalPack;
      for (const key of written.keys()) providers.media.zipPreviews.delete(key);
      written.clear();
    },
  };
}

/** Real delivery/QC/release producers shared by ZIP domain and worker integration tests. */
export function createZipPackageFixture(prisma: PrismaClient) {
  const h = productionHarness(prisma),
    protocol = installZipPackageFixture(h.fake);
  const zipMedia = createMedia({
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    events: h.events,
    storage: protocol.storage,
    zipProvider: h.fake.media,
  });
  h.media.ensureZip = zipMedia.ensureZip;
  return {
    ...h,
    zipMedia,
    zipStorage: protocol.storage,
    zipPackages: createDeliveryZipPackages({ ...h.deps, media: zipMedia }),
    publishLists: createPublishLists(h.deps),
    release: (episodes = 2) => released(h, false, undefined, episodes),
    input: (releaseId: string) =>
      h.tx.run((tx) => readReleaseZipInput(tx, zipMedia, releaseId, h.clock.now())),
    async close() {
      await zipMedia.jobs.shutdown();
      protocol.close();
      await h.close();
    },
  };
}
