// L4组合叶：docs只声明纯port，权限和引用实际走media公开口。
import { createHash } from "node:crypto";
import type { AgreementFileClaim, AgreementFileInput, AgreementFilePort } from "../docs/index.js";
import { AppError } from "../kernel/index.js";
import type { DocumentConverter, Tx, TxRunner } from "../kernel/index.js";
import type { Media } from "../media/index.js";
import type { StorageProvider } from "../providers/types.js";
import type { FileObject } from "@liyoxi/db";
const MAX = 20 * 1024 * 1024;
const claim = (f: FileObject): AgreementFileClaim => ({
  id: f.id,
  bucket: f.bucket,
  objectKey: f.objectKey,
  etag: f.etag,
  sizeBytes: f.sizeBytes?.toString() ?? null,
  sha256: f.sha256,
});
function usable(f: FileObject, ext: "docx" | "pdf") {
  const reason =
    f.status !== "stored" || f.moderationState === "block"
      ? "not_stored"
      : f.category !== "legal_doc" ||
          f.scopeType !== "platform" ||
          f.entityId !== null ||
          f.storeId !== null
        ? "category_mismatch"
        : f.ext !== ext
          ? "ext_mismatch"
          : null;
  if (reason) throw new AppError("FILE_NOT_USABLE", { details: { reason } });
  if (
    f.bucket !== "secure" ||
    f.sizeBytes === null ||
    f.sizeBytes < 0n ||
    f.sizeBytes > BigInt(MAX)
  )
    throw new AppError("FILE_NOT_AVAILABLE");
}
export function createDocsFiles(deps: {
  tx: TxRunner;
  media: Media;
  storage: StorageProvider;
  converter: DocumentConverter | null;
}): AgreementFilePort {
  const inspect = async (tx: Tx, input: AgreementFileInput) => {
    const files: FileObject[] = [];
    for (const [id, ext] of [
      [input.sourceFileId, "docx"],
      [input.pdfFileId, "pdf"],
    ] as const) {
      if (!id) continue;
      const file = await deps.media.assertOwned(
        tx,
        { identity: input.identity, staff: input.staff },
        id,
      );
      usable(file, ext);
      files.push(file);
    }
    return files;
  };
  return {
    async assertFiles(tx, input, claims) {
      const files = await inspect(tx, input);
      if (
        claims &&
        (claims.length !== files.length ||
          files.some((f) => {
            const old = claims.find((c) => c.id === f.id);
            const current = claim(f);
            return (
              !old ||
              old.bucket !== current.bucket ||
              old.objectKey !== current.objectKey ||
              old.etag !== current.etag ||
              old.sizeBytes !== current.sizeBytes ||
              old.sha256 !== current.sha256
            );
          }))
      )
        throw new AppError("FILE_NOT_AVAILABLE");
    },
    link: async (tx, input) => {
      await deps.media.link(tx, {
        fileId: input.fileId,
        refType: "agreement_version",
        refId: input.versionId,
        role: input.role,
        entityId: null,
        storeId: null,
      });
    },
    release: async (tx, input) => {
      await deps.media.release(tx, {
        fileId: input.fileId,
        refType: "agreement_version",
        refId: input.versionId,
        role: input.role,
        keepUntil: input.keepUntil,
        entityId: null,
        storeId: null,
      });
    },
    signPdf: (input) =>
      deps.media.signRead({ fileId: input.fileId, disposition: "inline", audience: "merchant" }),
    async prepare(input) {
      if (!input.sourceFileId && !input.pdfFileId)
        return {
          sourceFileId: null,
          pdfFileId: null,
          contentHtml: null,
          htmlSha256: null,
          contentSha256: null,
          similarityBp: null,
          claims: [],
        };
      if (!deps.converter) throw new AppError("FILE_NOT_AVAILABLE");
      let claims: AgreementFileClaim[] = [];
      const converted = await deps.converter.convert({
        load: async (signal) => {
          const files = await deps.tx.run((tx) => inspect(tx, input));
          claims = files.map(claim);
          const read = async (id: string | null) => {
            if (!id) return null;
            const file = files.find((f) => f.id === id);
            if (!file) throw new AppError("NOT_FOUND");
            // readObject在真实HEAD后将GET绑定同etag，取消会等待socket收尾。
            const result = await deps.storage.readObject({
              bucket: "secure",
              key: file.objectKey,
              maxBytes: MAX,
              signal,
              ...(file.etag ? { ifMatchEtag: file.etag } : {}),
            });
            if (!result.ok || result.value.byteLength !== Number(file.sizeBytes))
              throw new AppError("FILE_NOT_AVAILABLE");
            if (
              file.sha256 &&
              createHash("sha256").update(result.value).digest("hex") !== file.sha256
            )
              throw new AppError("FILE_NOT_AVAILABLE");
            return result.value;
          };
          // 逐个有界读取，不在准入前保留40MiB输入。
          const sourceBytes = await read(input.sourceFileId);
          const pdfBytes = await read(input.pdfFileId);
          return { sourceBytes, pdfBytes };
        },
      });
      if (!converted.ok) {
        if (
          converted.role === "source" &&
          ["invalid_document", "unsupported_document"].includes(converted.reason)
        )
          throw new AppError("AGREEMENT_CONTENT_CONVERT_FAILED");
        throw new AppError("FILE_NOT_AVAILABLE");
      }
      return {
        sourceFileId: input.sourceFileId,
        pdfFileId: input.pdfFileId,
        contentHtml: converted.value.contentHtml,
        htmlSha256: converted.value.htmlSha256,
        contentSha256: converted.value.pdfSha256,
        similarityBp: converted.value.similarityBp,
        claims,
      };
    },
  };
}
