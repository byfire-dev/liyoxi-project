import { AppError, lockRows, uuidv7 } from "../../../kernel/index.js";
import type { Tx } from "../../../kernel/index.js";
import type { BoundMediaDeps, FileRow } from "../../context.js";
import { jobBudget } from "../../jobs/policy.js";
import { queueWechatImageAudit } from "../../wechat-image-audit.js";
import { moderationChannel, needsExtractedText } from "./channels.js";
const source = (file: FileRow) => ({ bucket: file.bucket, key: file.objectKey, etag: file.etag });
async function insert(
  tx: Tx,
  deps: BoundMediaDeps,
  file: FileRow,
  kind: "audit_image" | "audit_video" | "audit_text",
  text?: FileRow,
) {
  const now = deps.clock.now(),
    dedupeKey = `${kind}:${file.id}:${text && text.id !== file.id ? `text:${text.id}` : "v1"}`;
  await tx.mediaJob.createMany({
    data: [
      {
        id: uuidv7(),
        kind,
        provider: deps.moderation!.status,
        mode: kind === "audit_video" ? "remote" : "local",
        subjectType: "file_object",
        subjectId: file.id,
        dedupeKey,
        state: "queued",
        input: {
          src: source(file),
          scenes: ["profile"],
          ...(text
            ? {
                textSource: {
                  fileId: text.id,
                  ...source(text),
                  sizeBytes: text.sizeBytes!.toString(),
                },
              }
            : {}),
        },
        nextRunAt: now,
        deadlineAt: new Date(now.getTime() + jobBudget(kind)!.deadlineMs),
        createdAt: now,
        updatedAt: now,
      },
    ],
    skipDuplicates: true,
  });
  await tx.fileObject.updateMany({
    where: { id: file.id, status: "stored", moderationState: "none" },
    data: { moderationState: "pending", updatedAt: now },
  });
  return (await tx.mediaJob.findUniqueOrThrow({ where: { dedupeKey }, select: { id: true } })).id;
}
export async function queueModeration(
  tx: Tx,
  deps: BoundMediaDeps,
  file: FileRow,
): Promise<string | null> {
  if (file.status !== "stored" || file.moderationState !== "none") return null;
  const kind = moderationChannel(file);
  if (kind === "audit_image_wx" && deps.wechatImage) return queueWechatImageAudit(tx, deps, file);
  if (!kind || !deps.moderation) return null;
  return insert(
    tx,
    deps,
    file,
    kind === "audit_image_wx" ? "audit_image" : kind,
    file.ext === "txt" ? file : undefined,
  );
}
/** Future ASR/doc-extract calls this only after storing its genuine bounded UTF-8 text artifact. */
export async function enqueueExtractedTextAudit(
  deps: BoundMediaDeps,
  tx: Tx,
  input: { fileId: string; textFileId: string },
): Promise<string> {
  if (!deps.moderation) throw new AppError("PROVIDER_UNAVAILABLE");
  await lockRows(tx, "file_object", [...new Set([input.fileId, input.textFileId])].sort());
  const file = await tx.fileObject.findUnique({ where: { id: input.fileId } }),
    text = await tx.fileObject.findUnique({ where: { id: input.textFileId } });
  if (!file || !text) throw new AppError("NOT_FOUND");
  if (
    moderationChannel(file) !== "audit_text" ||
    !needsExtractedText(file.ext) ||
    file.status !== "stored" ||
    !["none", "pending"].includes(file.moderationState) ||
    text.status !== "stored" ||
    text.ext !== "txt" ||
    text.moderationState === "block" ||
    text.entityId !== file.entityId ||
    text.storeId !== file.storeId ||
    text.scopeType !== file.scopeType ||
    !text.etag ||
    text.sizeBytes === null ||
    text.sizeBytes <= 0n ||
    text.sizeBytes > 40000n
  )
    throw new AppError("FILE_NOT_USABLE");
  return insert(tx, deps, file, "audit_text", text);
}
