import { createHash } from "node:crypto";
import { DOCUMENT_LIMITS as L } from "./limits.js";
import { textSimilarityBp } from "./similarity.js";
import { documentFailure, DocumentFailure } from "./types.js";
import type { DocumentConversionResult, DocumentInput } from "./types.js";
import { validateDocxZip } from "./zip.js";
import { sanitizeConvertedHtml } from "./html.js";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
function wordText(node: unknown): string {
  const stack: unknown[] = [node],
    parts: string[] = [];
  let count = 0;
  while (stack.length) {
    const current = stack.pop();
    if (typeof current !== "object" || current === null) continue;
    const item = current as { type?: unknown; value?: unknown; children?: unknown };
    if (item.type === "text" && typeof item.value === "string") {
      count += [...item.value].length;
      if (count > L.codepoints) throw new DocumentFailure("too_large", "source");
      parts.push(item.value);
    }
    if (Array.isArray(item.children))
      for (let i = item.children.length - 1; i >= 0; i--) stack.push(item.children[i]);
  }
  return parts.join("");
}
async function word(bytes: Uint8Array): Promise<{ html: string; text: string }> {
  await validateDocxZip(bytes);
  // Dynamic imports keep native and parser initialization out of the parent process/bundled barrels.
  const mammoth = (await import("mammoth")).default;
  let text = "";
  const converted = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
      transformDocument: (document: unknown) => {
        text = wordText(document);
        return document;
      },
    },
  );
  const html = await sanitizeConvertedHtml(converted.value);
  return { html, text };
}
async function pdfText(bytes: Uint8Array): Promise<string> {
  if (
    Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(5, bytes.byteLength)).toString() !==
    "%PDF-"
  )
    throw new DocumentFailure("invalid_document", "pdf");
  await import("@napi-rs/canvas");
  const pdf = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loading = pdf.getDocument({
    data: bytes,
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
    useWorkerFetch: false,
    useWasm: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableAutoFetch: true,
    stopAtErrors: true,
  });
  let budgetFailure: DocumentFailure | undefined;
  try {
    const document = await loading.promise;
    if (document.numPages > L.pages) throw new DocumentFailure("too_large", "pdf");
    const parts: string[] = [];
    let count = 0;
    for (let i = 1; i <= document.numPages; i++) {
      const page = await document.getPage(i);
      const reader = page.streamTextContent({ disableNormalization: true }).getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          for (const item of result.value.items)
            if ("str" in item) {
              count += [...item.str].length;
              if (count > L.codepoints) throw new DocumentFailure("too_large", "pdf");
              parts.push(item.str);
            }
        }
      } catch (error) {
        if (error instanceof DocumentFailure) {
          if (error.reason === "too_large") budgetFailure = error;
          throw error;
        }
        if (error instanceof Error && error.name === "FormatError")
          throw new DocumentFailure("unsupported_document", "pdf");
        throw error;
      } finally {
        await reader.cancel(new Error("document text extraction ended"));
        reader.releaseLock();
        page.cleanup();
      }
    }
    return parts.join("");
  } catch (error) {
    if (budgetFailure) throw budgetFailure;
    if (error instanceof DocumentFailure) {
      if (error.reason === "too_large") budgetFailure = error;
      throw error;
    }
    if (error instanceof RangeError) {
      budgetFailure = new DocumentFailure("too_large", "pdf");
      throw budgetFailure;
    }
    if (error instanceof Error && error.name === "PasswordException")
      throw new DocumentFailure("unsupported_document", "pdf");
    if (
      error instanceof Error &&
      ["InvalidPDFException", "MissingPDFException"].includes(error.name)
    )
      throw new DocumentFailure("invalid_document", "pdf");
    if (error instanceof Error && error.name === "FormatError")
      throw new DocumentFailure("unsupported_document", "pdf");
    throw error;
  } finally {
    await loading.destroy().catch((error: unknown) => Promise.reject(budgetFailure ?? error));
  }
}
export async function convertDocumentBytes(
  input: DocumentInput,
): Promise<DocumentConversionResult> {
  let processingRole: "source" | "pdf" | null = null;
  try {
    for (const role of ["source", "pdf"] as const) {
      const bytes = input[`${role}Bytes`];
      if (bytes !== null && !(bytes instanceof Uint8Array))
        throw new DocumentFailure("invalid_document", role);
      if (bytes && bytes.byteLength > L.fileBytes) throw new DocumentFailure("too_large", role);
    }
    const sourceSha256 = input.sourceBytes ? hash(input.sourceBytes) : null;
    const pdfSha256 = input.pdfBytes ? hash(input.pdfBytes) : null;
    processingRole = "source";
    const source = input.sourceBytes ? await word(input.sourceBytes) : null;
    let text: string | null = null;
    let pdfTextIssue: "invalid_document" | "unsupported_document" | "no_text" | null = null;
    // Formal a09: PDF-only is opaque bounded bytes + hash, including encrypted/non-extractable PDFs.
    if (input.pdfBytes && source) {
      processingRole = "pdf";
      try {
        text = await pdfText(input.pdfBytes);
        if (!text.trim()) pdfTextIssue = "no_text";
      } catch (error) {
        if (
          !(error instanceof DocumentFailure) ||
          error.role !== "pdf" ||
          !["invalid_document", "unsupported_document"].includes(error.reason)
        )
          throw error;
        pdfTextIssue = error.reason as "invalid_document" | "unsupported_document";
        text = "";
      }
    }
    return {
      ok: true,
      value: {
        sourceSha256,
        pdfSha256,
        contentHtml: source?.html ?? null,
        htmlSha256: source ? hash(source.html) : null,
        similarityBp: source && text !== null ? textSimilarityBp(source.text, text) : null,
        pdfTextIssue,
      },
    };
  } catch (error) {
    return documentFailure(error, processingRole);
  }
}
