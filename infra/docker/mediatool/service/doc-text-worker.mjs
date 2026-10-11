// No network or credentials: this process runs only inside the mediatool sandbox.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { DOC_LIMITS as L } from "./doc-text.mjs";
import { inputFile, RequestError } from "./paths.mjs";
import { validateDocxZip } from "./doc-text-zip.mjs";

const fail = (code) => {
  throw new RequestError(code, "文档解析失败");
};
async function load(relative) {
  const file = await inputFile(relative);
  const handle = await open(file.abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.sizeBytes) fail("invalid_document");
    if (stat.size > L.fileBytes) fail("too_large");
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const read = await handle.read(bytes, size, bytes.length - size, size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== stat.size) fail("invalid_document");
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}
function collector() {
  const parts = [];
  let count = 0;
  return {
    add(text) {
      count += Array.from(text).length;
      if (count > L.codepoints) fail("too_large");
      parts.push(text);
    },
    text: () => parts.join(""),
  };
}
async function word(bytes) {
  await validateDocxZip(bytes);
  const mammoth = (await import("mammoth")).default;
  const output = collector();
  await mammoth.convertToHtml(
    { buffer: bytes },
    {
      externalFileAccess: false,
      includeEmbeddedStyleMap: false,
      convertImage: mammoth.images.imgElement(async () => ({ src: "" })),
      transformDocument(document) {
        const stack = [document];
        while (stack.length) {
          const item = stack.pop();
          if (typeof item === "string") {
            output.add(item);
            continue;
          }
          if (!item || item.type === "table") continue;
          if (item.type === "text") output.add(item.value);
          if (item.type === "break") output.add("\n");
          if (item.type === "paragraph") stack.push("\n");
          if (Array.isArray(item.children))
            for (let i = item.children.length - 1; i >= 0; i--) stack.push(item.children[i]);
        }
        return document;
      },
    },
  );
  return { text: output.text() };
}
async function pdf(bytes) {
  if (bytes.subarray(0, 5).toString() !== "%PDF-") fail("invalid_document");
  await import("@napi-rs/canvas");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: Uint8Array.from(bytes),
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
  try {
    const doc = await task.promise;
    if (doc.numPages > L.pages) fail("too_large");
    const output = collector();
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const reader = page.streamTextContent().getReader();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          for (const item of part.value.items)
            if ("str" in item) {
              output.add(item.str);
              if (item.hasEOL) output.add("\n");
            }
        }
      } finally {
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          /* Original error survives. */
        }
        reader.releaseLock();
        page.cleanup();
      }
      if (n < doc.numPages) output.add("\n");
    }
    return { text: output.text(), pageCount: doc.numPages };
  } finally {
    await task.destroy();
  }
}
async function extract() {
  const [, , relative, ext, limit] = process.argv;
  const maxChars = Number(limit);
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > L.codepoints)
    fail("invalid_document");
  const bytes = await load(relative);
  let facts;
  if (ext === "pdf") facts = await pdf(bytes);
  else if (ext === "docx") facts = await word(bytes);
  else if (ext === "txt") {
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      try {
        text = new TextDecoder("gbk", { fatal: true }).decode(bytes);
      } catch {
        fail("bad_encoding");
      }
    }
    facts = { text };
  } else fail("unsupported_document");
  if (!facts.text.trim()) fail("no_text");
  const points = Array.from(facts.text);
  if (points.length > L.codepoints) fail("too_large");
  return {
    ok: true,
    ...facts,
    text: points.slice(0, maxChars).join(""),
    truncated: points.length > maxChars,
    charCount: points.length,
  };
}
try {
  process.stdout.write(JSON.stringify(await extract()));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      reason: error instanceof RequestError ? error.code : "invalid_document",
    }),
  );
}
