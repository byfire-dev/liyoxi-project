import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createMinioStorage, LOCAL_MINIO } from "./minio.js";

it("真实MinIO显式secure专用前缀的小流上传、条件HEAD/COPY、实际字节及自身清理", async () => {
  const prefix = `w224-backup-${randomUUID()}/`;
  const storage = createMinioStorage({
    ...LOCAL_MINIO,
    backup: { bucket: LOCAL_MINIO.buckets.secure, prefix },
  });
  const daily = "daily/2026-10-14.dump.age",
    monthly = "monthly/2026-10-14.dump.age";
  const bytes = new TextEncoder().encode(
    "public fixture: encrypted bytes belong to the future age pipeline",
  );
  const signal = new AbortController().signal;
  try {
    expect(await storage.ensureBuckets()).toMatchObject({ ok: true });
    const written = await storage.putBackupStream({
      key: daily,
      maxBytes: bytes.length,
      signal,
      body: async function* () {
        yield bytes.subarray(0, 9);
        yield bytes.subarray(9);
      },
    });
    expect(written).toMatchObject({
      ok: true,
      value: { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    });
    if (!written.ok) throw new Error("真实MinIO备份写入失败");
    expect(
      await storage.headBackup({ key: daily, ifMatchEtag: written.value.etag, signal }),
    ).toMatchObject({
      ok: true,
      value: { exists: true, size: bytes.length, etag: written.value.etag },
    });
    expect(
      await storage.copyBackup({
        srcKey: daily,
        dstKey: monthly,
        ifMatchEtag: '"wrong-etag"',
        signal,
      }),
    ).toMatchObject({ ok: false });
    const copied = await storage.copyBackup({
      srcKey: daily,
      dstKey: monthly,
      ifMatchEtag: written.value.etag,
      signal,
    });
    expect(copied).toMatchObject({ ok: true, value: { size: bytes.length } });
    const read = await storage.readObject({
      bucket: "secure",
      key: `${prefix}${monthly}`,
      maxBytes: bytes.length,
      signal,
    });
    expect(read).toMatchObject({ ok: true });
    if (read.ok) expect(read.value).toEqual(bytes);
  } finally {
    try {
      for (const key of [daily, monthly]) {
        expect(await storage.delete({ bucket: "secure", key: `${prefix}${key}` })).toMatchObject({
          ok: true,
        });
        expect(await storage.headBackup({ key, signal })).toMatchObject({
          ok: true,
          value: { exists: false },
        });
      }
    } finally {
      await storage.close();
    }
  }
});
