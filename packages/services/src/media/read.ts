import { readUrlExpiry, UPLOAD_CATEGORIES } from "@liyoxi/shared/uploads";
import { record } from "../audit/index.js";
import type { AuditRequestMeta } from "../audit/index.js";
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
      file = await readableByStaff(tx, actor.staff!, fileId);
    }
    return adminView(tx, actor, file);
  });
}
export function createSigner(deps: BoundMediaDeps) {
  const windows = new Map<string, Promise<{ url: string; expiresAt: string }>>();
  return async (input: ReadSignInput) => {
    const file = await deps.tx.run(async (tx) => {
      const found = await tx.fileObject.findUnique({ where: { id: input.fileId } });
      if (!found) throw new AppError("FILE_NOT_AVAILABLE");
      requireStored(found);
      return found;
    });
    const now = deps.clock.now();
    const expiresAt = readUrlExpiry(categoryOf(file), file.ext, now, input.audience);
    const stable = file.bucket !== "secure" && ["jpg", "jpeg", "png"].includes(file.ext);
    const key = `${file.id}:${input.disposition ?? "inline"}:${expiresAt.getTime()}`;
    for (const old of windows.keys())
      if (Number(old.split(":").at(-1)) <= now.getTime()) windows.delete(old);
    let result = stable ? windows.get(key) : undefined;
    if (!result) {
      result = (async () => {
        const signed = providerValue(
          await deps.storage.presignGet({
            bucket: UPLOAD_CATEGORIES[categoryOf(file)].bucket,
            key: file.objectKey,
            expiresSec: Math.ceil((expiresAt.getTime() - now.getTime()) / 1000),
            disposition: input.disposition ?? "inline",
            ...(input.disposition === "attachment" && file.originalName
              ? { downloadName: file.originalName }
              : {}),
          }),
        );
        return { url: signed.url, expiresAt: expiresAt.toISOString() };
      })();
      if (stable) {
        windows.set(key, result);
        void result.catch(() => windows.delete(key));
      }
    }
    return result;
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
    const file = await readableByStaff(tx, actor.staff!, input.fileId);
    requireStored(file);
    return file;
  }, options);
  const signed = await signRead(input);
  if (file.bucket === "secure" || ["sample_video", "final_episode"].includes(file.category)) {
    await deps.tx.run(async (tx) => {
      const current = await readableByStaff(tx, actor.staff!, input.fileId);
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
        meta: { purpose: input.purpose ?? null },
      });
    });
  }
  return signed;
}
