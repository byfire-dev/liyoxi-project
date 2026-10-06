import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { FileRow, MediaActor } from "./context.js";
export const statusView = (file: FileRow) => ({
  fileId: file.id,
  category: file.category,
  status: file.status,
  rejectReason: file.rejectReason,
  declaredSizeBytes: file.declaredSize.toString(),
  sizeBytes: file.sizeBytes?.toString() ?? null,
  mime: file.mime,
  moderationState: file.moderationState,
  storedAt: file.storedAt?.toISOString() ?? null,
  uploadExpiresAt: file.uploadExpiresAt?.toISOString() ?? null,
  createdAt: file.createdAt.toISOString(),
});
export function requirePending(file: FileRow, now: Date): void {
  if (file.status === "expired" || (file.uploadExpiresAt !== null && file.uploadExpiresAt <= now))
    throw new AppError("UPLOAD_EXPIRED");
  if (file.status === "rejected")
    throw new AppError("UPLOAD_REJECTED", { details: { rejectReason: file.rejectReason } });
  if (file.status !== "pending") throw new AppError("STATE_NOT_ALLOWED");
}
export function requireStored(file: FileRow): void {
  if (file.status !== "stored" || file.moderationState === "block")
    throw new AppError("FILE_NOT_AVAILABLE", { details: { status: file.status } });
}

export async function adminView(tx: Tx, actor: MediaActor, file: FileRow) {
  const {
    createdAt: _createdAt,
    uploadExpiresAt: _uploadExpiresAt,
    ...adminStatus
  } = statusView(file);
  let label = "系统";
  if (file.uploadActorType === "staff" && file.uploadActorId)
    label =
      (await tx.staff.findUnique({ where: { id: file.uploadActorId }, select: { name: true } }))
        ?.name ?? "员工";
  if (file.uploadActorType === "merchant") label = "商家";
  const liveRefCount = await tx.fileRef.count({ where: { fileId: file.id, state: "live" } });
  return {
    ...adminStatus,
    scopeType: file.scopeType,
    entityId: file.entityId,
    storeId: file.storeId,
    originalName: file.originalName,
    ext: file.ext,
    uploader: {
      actorType: file.uploadActorType,
      actorId: file.uploadActorId,
      client: file.uploadClient,
      label,
    },
    onBehalfStoreId: file.onBehalfStoreId,
    purgeAfter: file.purgeAfter?.toISOString() ?? null,
    deletedAt: file.deletedAt?.toISOString() ?? null,
    erasedAt: file.erasedAt?.toISOString() ?? null,
    restorableUntil:
      file.status === "deleted" && file.deletedAt && !file.erasedAt
        ? new Date(
            file.deletedAt.getTime() + (file.bucket === "secure" ? 90 : 30) * 86_400_000,
          ).toISOString()
        : null,
    liveRefCount,
    production: null,
    check: null,
    actions:
      file.status === "pending" &&
      file.uploadActorType === "staff" &&
      file.uploadActorId === actor.identity.actor.id
        ? ["cancel"]
        : [],
  };
}
