import { UPLOAD_CATEGORIES } from "@liyoxi/shared/uploads";
import { AppError, lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { categoryOf } from "./access.js";

const ids = (values: readonly string[]) => [...new Set(values)].sort();

/** Owner-only read for the caller's complete lock graph; never creates a cache. */
export async function readCancelZipTargets(tx: Tx, releaseIds: readonly string[]) {
  const bundles = await tx.zipBundle.findMany({
    where: { ownerType: "delivery_release", ownerId: { in: [...releaseIds] } },
    orderBy: { id: "asc" },
    select: { id: true, ownerId: true, zipGen: true, zipFileId: true, publishListFileId: true },
  });
  const refs = await tx.fileRef.findMany({
    where: {
      OR: [
        { refType: "delivery_release", refId: { in: [...releaseIds] }, role: "ep" },
        { refType: "zip_bundle", refId: { in: bundles.map((b) => b.id) } },
      ],
    },
    orderBy: { id: "asc" },
    select: { id: true, fileId: true, refType: true, refId: true, role: true },
  });
  return {
    releaseIds: ids(releaseIds),
    bundles,
    refs,
    zipBundleIds: bundles.map((b) => b.id),
    fileObjectIds: ids([
      ...bundles.flatMap((b) => [b.zipFileId, b.publishListFileId].filter((v): v is string => !!v)),
      ...refs.map((r) => r.fileId),
    ]),
  };
}
export type CancelZipTargets = Awaited<ReturnType<typeof readCancelZipTargets>>;

/** Called before the account lock, after the complete zip/file union has been locked. */
export async function invalidateZipBundles(tx: Tx, targets: CancelZipTargets, now: Date) {
  if (
    JSON.stringify(targets) !== JSON.stringify(await readCancelZipTargets(tx, targets.releaseIds))
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "取消文件锁图已变化" });
  await lockRows(tx, "zip_bundle", targets.zipBundleIds);
  await lockRows(tx, "file_object", targets.fileObjectIds);
  for (const bundle of targets.bundles)
    await tx.zipBundle.update({
      where: { id: bundle.id },
      data: {
        zipState: "none",
        zipGen: { increment: 1 },
        zipFileId: null,
        publishListFileId: null,
        updatedAt: now,
      },
    });
  for (const ref of targets.refs) {
    const old = await tx.fileRef.findUniqueOrThrow({ where: { id: ref.id } });
    const file = await tx.fileObject.findUniqueOrThrow({ where: { id: ref.fileId } });
    // Release snapshots keep their evidence for at least 90 days. Cancelling a
    // cache never shortens an explicit retention deadline already on its reference.
    const keepUntil =
      ref.refType === "delivery_release"
        ? new Date(
            Math.max(
              now.getTime() +
                Math.max(90, UPLOAD_CATEGORIES[categoryOf(file)].minKeepDays) * 86_400_000,
              old.keepUntil?.getTime() ?? 0,
            ),
          )
        : new Date(Math.max(now.getTime(), old.keepUntil?.getTime() ?? 0));
    await tx.fileRef.update({
      where: { id: old.id },
      data: { state: "released", releasedAt: old.releasedAt ?? now, keepUntil, updatedAt: now },
    });
  }
  for (const id of targets.fileObjectIds) {
    const refs = await tx.fileRef.findMany({
      where: { fileId: id },
      select: { state: true, keepUntil: true },
    });
    await tx.fileObject.update({
      where: { id },
      data: {
        purgeAfter: refs.some((r) => r.state === "live")
          ? null
          : new Date(Math.max(now.getTime(), ...refs.map((r) => r.keepUntil?.getTime() ?? 0))),
        updatedAt: now,
      },
    });
  }
  return { invalidated: targets.bundles.length };
}
