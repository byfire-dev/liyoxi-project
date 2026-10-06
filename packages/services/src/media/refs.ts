import { UPLOAD_CATEGORIES } from "@liyoxi/shared/uploads";
import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { BoundMediaDeps, LinkInput, ReleaseInput } from "./context.js";
import { categoryOf } from "./access.js";
const unusable = (
  fileId: string,
  reason: "not_stored" | "blocked" | "category_mismatch" | "scope_mismatch",
) => new AppError("FILE_NOT_USABLE", { details: { fileIds: [fileId], reason } });
export async function link(deps: BoundMediaDeps, tx: Tx, input: LinkInput): Promise<void> {
  const role = deps.refTypes.get(input.refType)?.roles[input.role];
  if (!role) throw new TypeError(`未登记文件引用：${input.refType}/${input.role}`);
  if (
    input.released &&
    (role.retentionDays === null || (role.canRelease && !(await role.canRelease(tx, input.refId))))
  )
    throw new AppError("STATE_NOT_ALLOWED");
  await lockRows(tx, "file_object", [input.fileId]);
  const file = await tx.fileObject.findUnique({ where: { id: input.fileId } });
  if (!file || file.status !== "stored") throw unusable(input.fileId, "not_stored");
  if (file.moderationState === "block") throw unusable(input.fileId, "blocked");
  if (!role.categories.includes(categoryOf(file)))
    throw unusable(input.fileId, "category_mismatch");
  const category = UPLOAD_CATEGORIES[categoryOf(file)];
  if (
    file.scopeType !== "platform" &&
    (file.entityId !== input.entityId ||
      (file.scopeType === "store" && !category.crossStore && file.storeId !== input.storeId))
  )
    throw unusable(input.fileId, "scope_mismatch");
  const now = deps.clock.now();
  const key = { fileId: file.id, refType: input.refType, refId: input.refId, role: input.role };
  const old = await tx.fileRef.findUnique({ where: { fileId_refType_refId_role: key } });
  // released 是 zip/导出等初建引用形态，不是释放既有 live 引用的旁路。
  if (input.released && old?.state === "live") throw new AppError("STATE_NOT_ALLOWED");
  const keepUntil =
    input.released && input.keepUntil
      ? new Date(
          Math.max(
            now.getTime() + Math.max(role.retentionDays ?? 0, category.minKeepDays) * 86_400_000,
            input.keepUntil.getTime(),
            old?.keepUntil?.getTime() ?? 0,
          ),
        )
      : null;
  if (input.released && !keepUntil) throw new TypeError("建立已释放引用须给 keepUntil");
  await tx.fileRef.upsert({
    where: { fileId_refType_refId_role: key },
    create: {
      id: uuidv7(),
      fileId: file.id,
      refType: input.refType,
      refId: input.refId,
      role: input.role,
      state: input.released ? "released" : "live",
      releasedAt: input.released ? now : null,
      keepUntil,
      createdAt: now,
      updatedAt: now,
    },
    update: {
      state: input.released ? "released" : "live",
      releasedAt: input.released ? (old?.releasedAt ?? now) : null,
      keepUntil,
      updatedAt: now,
    },
  });
  await tx.fileObject.update({
    where: { id: file.id },
    data: { firstLinkedAt: file.firstLinkedAt ?? now, updatedAt: now },
  });
  await updatePurge(tx, file.id);
}
export async function release(deps: BoundMediaDeps, tx: Tx, input: ReleaseInput): Promise<void> {
  const role = deps.refTypes.get(input.refType)?.roles[input.role];
  if (!role) throw new TypeError(`未登记文件引用：${input.refType}/${input.role}`);
  if (role.retentionDays === null || (role.canRelease && !(await role.canRelease(tx, input.refId))))
    throw new AppError("STATE_NOT_ALLOWED");
  await lockRows(tx, "file_object", [input.fileId]);
  const file = await tx.fileObject.findUnique({ where: { id: input.fileId } });
  if (!file) throw new AppError("FILE_NOT_AVAILABLE");
  if (
    file.scopeType !== "platform" &&
    (file.entityId !== input.entityId ||
      (file.scopeType === "store" &&
        !UPLOAD_CATEGORIES[categoryOf(file)].crossStore &&
        file.storeId !== input.storeId))
  )
    throw new AppError("FILE_NOT_AVAILABLE");
  const now = deps.clock.now();
  const min = new Date(
    now.getTime() +
      Math.max(role.retentionDays, UPLOAD_CATEGORIES[categoryOf(file)].minKeepDays) * 86_400_000,
  );
  const old = await tx.fileRef.findUnique({
    where: {
      fileId_refType_refId_role: {
        fileId: input.fileId,
        refType: input.refType,
        refId: input.refId,
        role: input.role,
      },
    },
  });
  if (!old) return;
  const keepUntil = new Date(
    Math.max(min.getTime(), input.keepUntil.getTime(), old.keepUntil?.getTime() ?? 0),
  );
  await tx.fileRef.update({
    where: { id: old.id },
    data: { state: "released", releasedAt: old.releasedAt ?? now, keepUntil, updatedAt: now },
  });
  await updatePurge(tx, file.id);
}
async function updatePurge(tx: Tx, fileId: string) {
  const refs = await tx.fileRef.findMany({
    where: { fileId },
    select: { state: true, keepUntil: true },
  });
  const purgeAfter = refs.some((ref) => ref.state === "live")
    ? null
    : new Date(Math.max(...refs.map((ref) => ref.keepUntil?.getTime() ?? 0)));
  await tx.fileObject.update({ where: { id: fileId }, data: { purgeAfter } });
}
