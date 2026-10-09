import { createHash, randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createMinioStorage } from "./minio.js";
import { STORAGE_BUCKETS } from "../types.js";
import type { ObjectRef } from "../types.js";

const storage = createMinioStorage(),
  prefix = `w304-stream-${randomUUID()}`,
  own: ObjectRef[] = [];
const bytes = new TextEncoder().encode("狸有戏 bounded stream four buckets"),
  sha256 = createHash("sha256").update(bytes).digest("hex"),
  identity = "8".repeat(64);
const prepared = await storage.ensureBuckets();
if (!prepared.ok && process.env.LYX_TEST_MINIO === "required")
  throw new Error(`MinIO required: ${prepared.message}`);
if (!prepared.ok)
  process.stderr.write(`[streams.minio] local MinIO not configured: ${prepared.reason}\n`);
const live = prepared.ok ? describe : describe.skip;
afterAll(async () => {
  try {
    const removed = [];
    for (const ref of own) removed.push(await storage.delete(ref));
    expect(removed.every((result) => result.ok)).toBe(true);
    for (const ref of own)
      expect(await storage.head(ref)).toMatchObject({ ok: true, value: { exists: false } });
  } finally {
    await storage.close();
  }
});
const body = async function* (_signal: AbortSignal) {
  yield bytes.slice(0, 7);
  yield bytes.slice(7);
};
const input = (ref: ObjectRef) => ({
  ...ref,
  body,
  size: bytes.length,
  sha256,
  contentIdentity: identity,
  contentType: "video/mp4",
  ifAbsent: true as const,
  signal: new AbortController().signal,
});
live("真实MinIO有限流能力", () => {
  it.each(STORAGE_BUCKETS)(
    "%s fixed own key条件流写→实际HEAD/IfMatch读回→同内容重放",
    async (bucket) => {
      const ref = { bucket, key: `${prefix}/${bucket}.mp4` };
      own.push(ref);
      const consumed = vi.fn(),
        request = input(ref);
      const written = await storage.putStream({
        ...request,
        body: async function* (signal) {
          try {
            yield* body(signal);
          } finally {
            consumed();
          }
        },
      });
      expect(written).toMatchObject({ ok: true, value: { size: bytes.length } });
      expect(consumed).toHaveBeenCalledTimes(2);
      if (!written.ok) throw new Error("actual write failed");
      const chunks: Uint8Array[] = [],
        read = await storage.readTo({
          ...ref,
          expectedSize: bytes.length,
          maxBytes: bytes.length,
          ifMatchEtag: written.value.etag,
          signal: new AbortController().signal,
          sink: async (chunk) => {
            chunks.push(chunk);
            await Promise.resolve();
          },
        });
      expect(read).toEqual({ ok: true, value: { size: bytes.length, sha256 } });
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
      expect(await storage.putStream(request)).toEqual(written);
      expect(
        await storage.putStream({ ...request, contentIdentity: "9".repeat(64) }),
      ).toMatchObject({ ok: false, reason: "rejected" });
    },
  );
  it("真实HEAD预期大小/IfMatch错误拒绝，缺对象不产生完整结果", async () => {
    const ref = { bucket: "media" as const, key: `${prefix}/boundary.mp4` };
    own.push(ref);
    const written = await storage.putStream(input(ref));
    if (!written.ok) throw new Error("actual write");
    const sink = vi.fn(async () => {}),
      read = {
        ...ref,
        expectedSize: bytes.length,
        maxBytes: bytes.length,
        ifMatchEtag: written.value.etag,
        signal: new AbortController().signal,
        sink,
      };
    expect(await storage.readTo({ ...read, expectedSize: bytes.length - 1 })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(await storage.readTo({ ...read, ifMatchEtag: '"wrong"' })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(await storage.readTo({ ...read, key: `${prefix}/absent.mp4` })).toMatchObject({
      ok: false,
      reason: "rejected",
    });
    expect(sink).not.toHaveBeenCalled();
  });
  it("取消源流并等待真实finally，关自己的driver不关兄弟", async () => {
    const one = createMinioStorage(),
      controller = new AbortController();
    let entered!: () => void,
      cleaned = false;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const ref = { bucket: "media" as const, key: `${prefix}/canceled.mp4` };
    own.push(ref);
    const pending = one.putStream({
      ...input(ref),
      signal: controller.signal,
      body: async function* (signal) {
        try {
          entered();
          yield bytes.slice(0, 7);
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          yield bytes.slice(7);
        } finally {
          cleaned = true;
        }
      },
    });
    try {
      await ready;
      await one.close();
      expect(cleaned).toBe(true);
      expect(await pending).toMatchObject({ ok: false });
      expect(await storage.head(ref)).toMatchObject({ ok: true, value: { exists: false } });
    } finally {
      controller.abort();
      await one.close();
      await pending;
    }
  });
});
