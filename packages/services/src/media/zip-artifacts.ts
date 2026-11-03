import { createHash } from "node:crypto";
import type { MediaJob } from "@liyoxi/db";
import { lockRows } from "../kernel/index.js";
import type { BoundMediaDeps } from "./context.js";
import type { ZipJobInput } from "./zip-types.js";
import { ZipInputSchema, zipKeys } from "./zip-types.js";
import { changeZipIntent, readZipIntent, zipAttemptActive } from "./zip-intents.js";
import { link } from "./refs.js";

export async function registerZipArtifact(
  deps: BoundMediaDeps,
  job: MediaJob,
  input: ZipJobInput,
  artifact: {
    readonly role: "zip" | "list";
    readonly key: string;
    readonly size: number;
    readonly etag: string;
    readonly crc64?: string;
    readonly sha256?: string;
    readonly cleanup?: boolean;
  },
) {
  return deps.tx.run(async (tx) => {
    await lockRows(tx, "zip_bundle", [input.zipBundleId]);
    await lockRows(tx, "media_job", [job.id]);
    const active = await tx.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
    const intent = ZipInputSchema.parse(active.input).artifactIntents?.find(
      (one) => one.attemptNo === job.attemptNo,
    );
    const fileId = artifact.role === "zip" ? intent?.zipFileId : intent?.publishListFileId;
    if (!fileId) throw new Error("ZIP artifact was not reserved before IO");
    await lockRows(tx, "file_object", [fileId]);
    let file = await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } });
    const now = deps.clock.now(),
      category = artifact.role === "zip" ? "package_zip" : "publish_list";
    const keys = zipKeys(input, job);
    if (
      artifact.key !== (artifact.role === "zip" ? keys.zip : keys.list) ||
      file.objectKey !== artifact.key ||
      file.bucket !== "media" ||
      file.category !== category ||
      file.entityId !== input.entityId ||
      file.storeId !== input.storeId ||
      !["pending", "stored"].includes(file.status) ||
      (file.status === "stored" &&
        (file.etag !== artifact.etag ||
          file.sizeBytes !== BigInt(artifact.size) ||
          (artifact.sha256 && file.sha256 && file.sha256 !== artifact.sha256) ||
          (artifact.crc64 && file.crc64 && file.crc64 !== artifact.crc64)))
    )
      throw new Error("ZIP artifact identity changed");
    if (artifact.cleanup && zipAttemptActive(active, job.attemptNo, now))
      throw new Error("ZIP cleanup attempt is active");
    file = await tx.fileObject.update({
      where: { id: file.id },
      data: {
        status: "stored",
        declaredSize: artifact.size,
        sizeBytes: artifact.size,
        mime: artifact.role === "zip" ? "application/zip" : "text/plain",
        etag: artifact.etag,
        ...(artifact.crc64 ? { crc64: artifact.crc64 } : {}),
        ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
        storedAt: file.storedAt ?? now,
        updatedAt: now,
      },
    });
    const bundle = await tx.zipBundle.findUniqueOrThrow({ where: { id: input.zipBundleId } });
    const needed =
      zipAttemptActive(active, job.attemptNo, now) &&
      bundle.zipState === "building" &&
      bundle.zipGen === input.zipGen;
    if (artifact.cleanup || !needed)
      await link(deps, tx, {
        fileId: file.id,
        refType: "zip_bundle",
        refId: input.zipBundleId,
        role: artifact.role,
        entityId: input.entityId,
        storeId: input.storeId,
        released: true,
        keepUntil: now,
      });
    if (artifact.role === "list" && !artifact.cleanup)
      await tx.mediaJob.updateMany({
        where: {
          id: job.id,
          attemptNo: job.attemptNo,
          leaseOwner: job.leaseOwner,
          state: job.state,
        },
        data: { output: { publishListFileId: file.id } },
      });
    return file;
  });
}

export async function uploadZipList(
  deps: BoundMediaDeps,
  job: MediaJob,
  input: ZipJobInput,
  signal: AbortSignal,
) {
  if (!input.publishListText) return { ok: true as const, fileId: null };
  const body = Buffer.from(input.publishListText, "utf8"),
    key = zipKeys(input, job).list;
  const sha256 = createHash("sha256").update(body).digest("hex");
  const intent = await readZipIntent(deps, job);
  if (!intent) throw new Error("ZIP list intent missing");
  if (intent.listWrite === "reserved") {
    const claimed = await changeZipIntent(
      deps,
      job,
      (one) => ({ ...one, listWrite: "unknown" }),
      "list",
    );
    if (!claimed) return { ok: false as const, retryable: false };
    const result = await deps.storage.putStream({
      bucket: "media",
      key,
      body: async function* (active) {
        active.throwIfAborted();
        yield body;
      },
      size: body.length,
      sha256,
      contentType: "text/plain; charset=utf-8",
      ifAbsent: true,
      contentIdentity: createHash("sha256")
        .update(JSON.stringify([input.zipBundleId, input.zipGen, job.id, job.attemptNo, sha256]))
        .digest("hex"),
      signal,
    });
    if (!result.ok) {
      if (result.reason !== "unavailable")
        await changeZipIntent(deps, job, (one) => ({ ...one, listWrite: "rejected" }));
      return { ok: false as const, retryable: result.reason === "unavailable" };
    }
  }
  // Each attempt performs at most one PUT. A lost response is recovered by observing its key.
  const head = await deps.storage.head({ bucket: "media", key, signal });
  if (
    !head.ok ||
    !head.value.exists ||
    !head.value.etag ||
    !Number.isSafeInteger(head.value.size) ||
    head.value.size < 0
  )
    return { ok: false as const, retryable: !head.ok && head.reason === "unavailable" };
  const file = await registerZipArtifact(deps, job, input, {
    role: "list",
    key,
    size: head.value.size,
    etag: head.value.etag,
    ...(head.value.crc64 ? { crc64: head.value.crc64 } : {}),
  });
  if (head.value.size !== body.length) return { ok: false as const, retryable: false };
  const read = await deps.storage.readObject({
    bucket: "media",
    key,
    maxBytes: body.length,
    ifMatchEtag: head.value.etag,
    signal,
  });
  if (!read.ok) return { ok: false as const, retryable: read.reason === "unavailable" };
  if (createHash("sha256").update(read.value).digest("hex") !== sha256)
    return { ok: false as const, retryable: false };
  await registerZipArtifact(deps, job, input, {
    role: "list",
    key,
    size: body.length,
    etag: head.value.etag,
    ...(head.value.crc64 ? { crc64: head.value.crc64 } : {}),
    sha256,
  });
  await changeZipIntent(deps, job, (one) => ({ ...one, listWrite: "verified" }));
  return { ok: true as const, fileId: file.id };
}
