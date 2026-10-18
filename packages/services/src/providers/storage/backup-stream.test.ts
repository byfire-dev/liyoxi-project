import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { BACKUP_PART_BYTES, createBackupStorage } from "./backup-stream.js";
import type { BackupTransport } from "./backup-stream.js";

const key = "daily/2026-10-14.dump.age";
const signal = () => new AbortController().signal;
function transport() {
  let total = 0;
  const parts: Uint8Array[] = [];
  const wire = {
    begin: vi.fn(async () => ({ uploadId: "own-upload" })),
    part: vi.fn(async (input: Parameters<BackupTransport["part"]>[0]) => {
      total += input.body.byteLength;
      parts.push(input.body.slice());
      return { etag: `"part-${input.partNumber}"` };
    }),
    complete: vi.fn(async (_input: Parameters<BackupTransport["complete"]>[0]) => ({
      etag: '"done"',
    })),
    abort: vi.fn(async (_input: Parameters<BackupTransport["abort"]>[0]) => {}),
    head: vi.fn(async () => ({ exists: true as const, size: total, etag: '"done"' })),
    copy: vi.fn(async () => ({ etag: '"done"' })),
  } satisfies BackupTransport;
  return { wire, parts, storage: createBackupStorage(wire) };
}

it("备份未知长度源只读一次，分块串行背压并核最终HEAD、实际SHA", async () => {
  const { wire, parts, storage } = transport();
  const chunk = new Uint8Array(1024 * 1024).fill(7),
    tail = new Uint8Array([8, 9]);
  const digest = createHash("sha256");
  for (let n = 0; n < 5; n++) digest.update(chunk);
  digest.update(tail);
  let closed = 0,
    opened = 0;
  const result = await storage.putBackupStream({
    key,
    maxBytes: BACKUP_PART_BYTES + 2,
    signal: signal(),
    body: async function* () {
      opened++;
      try {
        for (let n = 0; n < 5; n++) yield chunk;
        // 第六块不能先行消耗；5MiB的part已经完全发完。
        expect(wire.part).toHaveBeenCalledTimes(1);
        yield tail;
      } finally {
        closed++;
      }
    },
  });
  expect(result).toEqual({
    ok: true,
    value: { etag: '"done"', size: BACKUP_PART_BYTES + 2, sha256: digest.digest("hex") },
  });
  expect([opened, closed]).toEqual([1, 1]);
  expect(parts.map((part) => part.length)).toEqual([BACKUP_PART_BYTES, 2]);
  expect(Buffer.compare(parts[0]!, new Uint8Array(BACKUP_PART_BYTES).fill(7))).toBe(0);
  expect(parts[1]).toEqual(tail);
  expect(wire.complete.mock.calls[0]?.[0].parts).toEqual([
    { partNumber: 1, etag: '"part-1"' },
    { partNumber: 2, etag: '"part-2"' },
  ]);
  expect(wire.abort).not.toHaveBeenCalled();
});

it("超限与未知完成均失败并回收自己的上传，不重发complete或猜成功", async () => {
  for (const mode of ["over-limit", "unknown-complete", "wrong-head"] as const) {
    const { wire, storage } = transport();
    let cleaned = false;
    if (mode === "unknown-complete")
      wire.complete.mockRejectedValueOnce(new Error("private-upstream"));
    if (mode === "wrong-head")
      wire.head.mockResolvedValueOnce({ exists: true, size: 2, etag: '"other"' });
    const result = await storage.putBackupStream({
      key,
      maxBytes: mode === "over-limit" ? 1 : 2,
      signal: signal(),
      body: async function* () {
        try {
          yield new Uint8Array([1, 2]);
        } finally {
          cleaned = true;
        }
      },
    });
    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("private-upstream");
    expect(cleaned).toBe(true);
    expect(wire.complete).toHaveBeenCalledTimes(mode === "over-limit" ? 0 : 1);
    expect(wire.head).toHaveBeenCalledTimes(mode === "wrong-head" ? 1 : 0);
    expect(wire.abort).toHaveBeenCalledTimes(1);
    expect(wire.abort.mock.calls[0]?.[0]).toMatchObject({ key, uploadId: "own-upload" });
    expect(wire.abort.mock.calls[0]?.[0].signal.aborted).toBe(false);
  }
});
