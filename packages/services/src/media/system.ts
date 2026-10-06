import { createHash } from "node:crypto";
import {
  extensionOf,
  MIME_BY_EXT,
  matchesMagic,
  maxUploadBytes,
  UPLOAD_CATEGORIES,
} from "@liyoxi/shared/uploads";
import { AppError, createIdentityContext, uuidv7 } from "../kernel/index.js";
import type { BoundMediaDeps, SystemFileInput } from "./context.js";
import { emitFile, providerValue } from "./upload.js";
export async function putSystemFile(deps: BoundMediaDeps, input: SystemFileInput) {
  const definition = UPLOAD_CATEGORIES[input.category];
  if (input.storeId !== null || (input.category !== "legal_doc" && input.entityId !== null))
    throw new AppError("VALIDATION_FAILED");
  if (!definition.system) throw new AppError("FILE_CATEGORY_NOT_ALLOWED");
  if (
    !/^[a-z0-9][a-z0-9_./-]{0,511}$/.test(input.objectKey) ||
    input.objectKey.includes("..") ||
    input.objectKey.startsWith("incoming/")
  )
    throw new TypeError("系统文件键须为正式区全小写 ASCII 键");
  const ext = extensionOf(input.fileName);
  if (!ext || !definition.exts.includes(ext) || !matchesMagic(ext, input.body.slice(0, 4096)))
    throw new AppError("FILE_TYPE_NOT_ALLOWED", { details: { allowedExts: definition.exts } });
  const sha256 = createHash("sha256").update(input.body).digest("hex");
  const maxBytes = maxUploadBytes(input.category, ext, "admin");
  if (BigInt(input.body.byteLength) > maxBytes)
    throw new AppError("FILE_TOO_LARGE", {
      details: { maxBytes: maxBytes.toString(), canDelegate: false },
    });
  const existing = await deps.tx.run((tx) =>
    tx.fileObject.findUnique({
      where: { bucket_objectKey: { bucket: definition.bucket, objectKey: input.objectKey } },
    }),
  );
  if (existing) {
    if (
      existing.category !== input.category ||
      existing.entityId !== input.entityId ||
      existing.storeId !== input.storeId ||
      existing.sha256 !== sha256 ||
      existing.status !== "stored"
    )
      throw new AppError("VALIDATION_FAILED");
    return { fileId: existing.id, sha256, created: false };
  }
  const contentType = MIME_BY_EXT[ext]!;
  const contentIdentity = createHash("sha256")
    .update(JSON.stringify([input.category, input.entityId, input.storeId, sha256]))
    .digest("hex");
  const put = await deps.storage.putObject({
    bucket: definition.bucket,
    key: input.objectKey,
    body: input.body,
    contentType,
    contentDisposition: "attachment",
    ifAbsent: true,
    contentIdentity,
  });
  if (!put.ok && put.reason === "rejected")
    throw new AppError("VALIDATION_FAILED", {
      details: {
        fieldErrors: [{ path: "objectKey", message: "正式区键已有不同内容或归属的系统文件" }],
      },
    });
  const written = providerValue(put);
  if (!written.etag || written.size !== input.body.byteLength)
    throw new AppError("PROVIDER_UNAVAILABLE");
  const head = providerValue(
    await deps.storage.head({ bucket: definition.bucket, key: input.objectKey }),
  );
  if (!head.exists || head.size !== input.body.byteLength || head.etag !== written.etag)
    throw new AppError("PROVIDER_UNAVAILABLE");
  return deps.tx.run(async (tx) => {
    const now = deps.clock.now();
    const id = uuidv7();
    const inserted = await tx.fileObject.createMany({
      data: [
        {
          id,
          bucket: definition.bucket,
          objectKey: input.objectKey,
          category: input.category,
          scopeType: input.storeId ? "store" : input.entityId ? "entity" : "platform",
          entityId: input.entityId,
          storeId: input.storeId,
          uploadActorType: "system",
          status: "stored",
          uploadMode: "server",
          declaredSize: input.body.byteLength,
          declaredMime: contentType,
          ext,
          originalName: null,
          sizeBytes: input.body.byteLength,
          mime: contentType,
          etag: written.etag,
          sha256,
          storedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
      skipDuplicates: true,
    });
    const file = await tx.fileObject.findUniqueOrThrow({
      where: { bucket_objectKey: { bucket: definition.bucket, objectKey: input.objectKey } },
    });
    if (
      file.sha256 !== sha256 ||
      file.category !== input.category ||
      file.entityId !== input.entityId ||
      file.storeId !== input.storeId
    )
      throw new AppError("VALIDATION_FAILED");
    if (inserted.count === 1)
      await emitFile(
        tx,
        deps,
        {
          identity: createIdentityContext({ actor: { type: "system", job: "media.system_file" } }),
        },
        file,
        "file.stored",
      );
    return { fileId: file.id, sha256, created: inserted.count === 1 };
  });
}
