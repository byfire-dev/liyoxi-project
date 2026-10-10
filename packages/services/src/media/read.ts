import { readUrlExpiry, UPLOAD_CATEGORIES } from "@liyoxi/shared/uploads";
import { record } from "../audit/index.js";
import type { AuditRequestMeta } from "../audit/index.js";
import type { Tx } from "../kernel/index.js";
import { AppError } from "../kernel/index.js";
import { categoryOf, owned, readableByStaff } from "./access.js";
import type {
  BoundMediaDeps,
  FileRow,
  MediaActor,
  MediaOptions,
  ReadSignInput,
} from "./context.js";
import { providerValue } from "./upload.js";
import { adminView, requireStored, statusView } from "./views.js";
export const getMerchant = (deps: BoundMediaDeps, actor: MediaActor, fileId: string) =>
  deps.tx.run(async (tx) => statusView(await owned(tx, actor, fileId)));
export async function getAdmin(deps: BoundMediaDeps, actor: MediaActor, fileId: string) {
  if (!actor.staff) throw new AppError("NOT_FOUND");
  return deps.tx.run(async (tx) => {
    let file: FileRow;
    try {
      file = await owned(tx, actor, fileId);
    } catch (error) {
      if (!(error instanceof AppError) || error.error !== "NOT_FOUND") throw error;
      file = await readableByStaff(tx, actor.staff!, fileId, deps);
    }
    return adminView(tx, actor, file);
  });
}
type DeliveryDownloadIntent = {
  readonly kind: "delivery-download";
  readonly fileName: string;
};
export function createSigner(deps: BoundMediaDeps) {
  const windows = new Map<string, Promise<{ url: string; expiresAt: string }>>();
  return async (input: ReadSignInput, intent?: DeliveryDownloadIntent) => {
    const file = await deps.tx.run(async (tx) => {
      const found = await tx.fileObject.findUnique({ where: { id: input.fileId } });
      if (!found) throw new AppError("FILE_NOT_AVAILABLE");
      if (found.category === "portrait_auth" && input.audience === "merchant")
        throw new AppError("FILE_NOT_USABLE");
      requireStored(found);
      return found;
    });
    const now = deps.clock.now();
    const expiresAt = intent
      ? new Date(now.getTime() + 900_000)
      : readUrlExpiry(categoryOf(file), file.ext, now, input.audience);
    const urlTtlSec = Math.ceil((expiresAt.getTime() - now.getTime()) / 1000);
    const disposition = intent ? "attachment" : (input.disposition ?? "inline");
    const downloadName = intent
      ? intent.fileName
      : disposition === "attachment" && file.originalName
        ? file.originalName
        : undefined;
    const stable = file.bucket !== "secure" && ["jpg", "jpeg", "png"].includes(file.ext);
    const key = `${file.id}:${disposition}:${encodeURIComponent(downloadName ?? "")}:${expiresAt.getTime()}`;
    for (const old of windows.keys())
      if (Number(old.split(":").at(-1)) <= now.getTime()) windows.delete(old);
    let result = stable ? windows.get(key) : undefined;
    if (!result) {
      result = (async () => {
        const signed = providerValue(
          await deps.storage.presignGet({
            bucket: UPLOAD_CATEGORIES[categoryOf(file)].bucket,
            key: file.objectKey,
            expiresSec: urlTtlSec,
            disposition,
            ...(downloadName === undefined ? {} : { downloadName }),
          }),
        );
        return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
      })();
      if (stable) {
        windows.set(key, result);
        void result.catch(() => windows.delete(key));
      }
    }
    const signed = await result;
    await deps.tx.run(async (tx) => {
      const current = await tx.fileObject.findUnique({ where: { id: file.id } });
      if (!current || current.objectKey !== file.objectKey || current.etag !== file.etag)
        throw new AppError("FILE_NOT_AVAILABLE");
      requireStored(current);
    });
    return { signed, urlTtlSec };
  };
}
export async function downloadUrls(
  deps: BoundMediaDeps,
  signRead: ReturnType<typeof createSigner>,
  actor: MediaActor,
  input: ReadSignInput & { readonly purpose?: string },
  meta: AuditRequestMeta,
  options: MediaOptions = {},
) {
  if (!actor.staff) throw new AppError("NOT_FOUND");
  const file = await deps.tx.run(async (tx) => {
    const file = await readableByStaff(tx, actor.staff!, input.fileId, deps);
    requireStored(file);
    return file;
  }, options);
  const { signed, urlTtlSec } = await signRead(input);
  if (file.bucket === "secure" || ["sample_video", "final_episode"].includes(file.category)) {
    await deps.tx.run(async (tx) => {
      const current = await readableByStaff(tx, actor.staff!, input.fileId, deps);
      requireStored(current);
      await record(tx, actor.identity.actor, meta, {
        stream: "access",
        category: "file_access",
        action: "files.url.sign",
        summary: "签发文件读地址",
        target: { type: "file_object", id: file.id },
        ...(file.entityId === null
          ? { entityId: null, storeId: null }
          : { entityId: file.entityId, storeId: file.storeId }),
        meta: { fileCategory: file.category, urlTtlSec, purpose: input.purpose ?? null },
      });
    });
  }
  return signed;
}

/** Future vision/LLM consumers must call this in their current claim TX before model IO. */
export async function assertUsableForModel(tx: Tx, fileId: string) {
  const file = await tx.fileObject.findUnique({ where: { id: fileId } });
  if (!file) throw new AppError("FILE_NOT_AVAILABLE");
  requireStored(file);
  return {
    fileId: file.id,
    bucket: file.bucket,
    key: file.objectKey,
    etag: file.etag,
    sizeBytes: file.sizeBytes,
  };
}
