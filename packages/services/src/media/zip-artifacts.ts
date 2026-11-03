import { createHash } from "node:crypto";
import type { MediaJob } from "@liyoxi/db";
import { lockRows, uuidv7 } from "../kernel/index.js";
import type { BoundMediaDeps } from "./context.js";
import type { ZipJobInput } from "./zip-types.js";
import { zipKeys } from "./zip-types.js";
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
  },
) {
  return deps.tx.run(async (tx) => {
    await lockRows(tx, "zip_bundle", [input.zipBundleId]);
    await lockRows(tx, "media_job", [job.id]);
    const now = deps.clock.now(),
      category = artifact.role === "zip" ? "package_zip" : "publish_list";
    await tx.fileObject.createMany({
      data: [
        {
          id: uuidv7(),
          bucket: "media",
          objectKey: artifact.key,
          category,
          scopeType: "store",
          entityId: input.entityId,
          storeId: input.storeId,
          uploadActorType: "system",
          status: "stored",
          uploadMode: "server",
          declaredSize: artifact.size,
          declaredMime: artifact.role === "zip" ? "application/zip" : "text/plain",
          ext: artifact.role === "zip" ? "zip" : "txt",
          originalName: null,
          sizeBytes: artifact.size,
          mime: artifact.role === "zip" ? "application/zip" : "text/plain",
          etag: artifact.etag,
          crc64: artifact.crc64 ?? null,
          sha256: artifact.sha256 ?? null,
          storedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    const file = await tx.fileObject.findUniqueOrThrow({
      where: {
        bucket_objectKey: { bucket: "media", objectKey: artifact.key },
      },
    });
    if (
      file.category !== category ||
      file.entityId !== input.entityId ||
      file.storeId !== input.storeId ||
      file.etag !== artifact.etag ||
      file.sizeBytes !== BigInt(artifact.size) ||
      file.status !== "stored" ||
      (artifact.sha256 && file.sha256 !== artifact.sha256) ||
      (artifact.crc64 && file.crc64 !== artifact.crc64)
    )
      throw new Error("ZIP artifact identity changed");
    await lockRows(tx, "file_object", [file.id]);
    // Register late ZIPs with an immediately expired ref; current results are linked at settlement.
    // Lists retain the original unreferenced 24-hour protection until the job finishes.
    const active = await tx.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
    const bundle = await tx.zipBundle.findUniqueOrThrow({ where: { id: input.zipBundleId } });
    const current =
      active.attemptNo === job.attemptNo &&
      active.leaseOwner === job.leaseOwner &&
      active.state === job.state &&
      bundle.zipState === "building" &&
      bundle.zipGen === input.zipGen;
    if (artifact.role === "zip" && !current)
      await link(deps, tx, {
        fileId: file.id,
        refType: "zip_bundle",
        refId: input.zipBundleId,
        role: "zip",
        entityId: input.entityId,
        storeId: input.storeId,
        released: true,
        keepUntil: now,
      });
    if (artifact.role === "list")
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
  if (!result.ok) return { ok: false as const, retryable: result.reason === "unavailable" };
  const head = await deps.storage.head({ bucket: "media", key, signal });
  if (
    !head.ok ||
    !head.value.exists ||
    head.value.size !== body.length ||
    result.value.size !== body.length ||
    !head.value.etag ||
    head.value.etag !== result.value.etag
  )
    return { ok: false as const, retryable: !head.ok && head.reason === "unavailable" };
  const file = await registerZipArtifact(deps, job, input, {
    role: "list",
    key,
    size: body.length,
    etag: head.value.etag,
    ...(head.value.crc64 ? { crc64: head.value.crc64 } : {}),
    sha256,
  });
  return { ok: true as const, fileId: file.id };
}
