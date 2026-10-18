// Container-only operation; never imports a host parser or receives a URL.
import { fileURLToPath } from "node:url";
import { inputFile, RequestError } from "./paths.mjs";
import { run } from "./run.mjs";

export const DOC_LIMITS = {
  fileBytes: 20 * 1024 * 1024,
  expandedBytes: 32 * 1024 * 1024,
  entryBytes: 8 * 1024 * 1024,
  entries: 256,
  ratio: 100,
  pages: 100,
  codepoints: 250_000,
  deadlineMs: 10_000,
};
const EXTENSIONS = ["pdf", "docx", "txt"];
const FAILURES = new Set([
  "invalid_document",
  "unsupported_document",
  "too_large",
  "no_text",
  "bad_encoding",
]);

/** @param {any} body @param {AbortSignal} [signal] */
export async function docText(body, signal) {
  const started = performance.now();
  if (signal?.aborted) throw new RequestError("killed", "调用已取消", 503);
  if (
    Object.keys(body).some((key) => !["path", "ext", "maxChars", "timeoutMs"].includes(key)) ||
    !EXTENSIONS.includes(body.ext) ||
    !Number.isInteger(body.maxChars) ||
    body.maxChars < 1 ||
    body.maxChars > DOC_LIMITS.codepoints ||
    (body.timeoutMs !== undefined &&
      (!Number.isSafeInteger(body.timeoutMs) || body.timeoutMs < 1000))
  )
    throw new RequestError("bad_request", "文档参数不合规");
  const timeout = Math.min(body.timeoutMs ?? DOC_LIMITS.deadlineMs, DOC_LIMITS.deadlineMs);
  const file = await inputFile(body.path);
  if (file.sizeBytes > DOC_LIMITS.fileBytes)
    throw new RequestError("too_large", "文档超过20MiB", 413);
  const remaining = timeout - (performance.now() - started);
  if (remaining <= 0) throw new RequestError("timeout", "文档解析超过硬期限", 504);
  const result = await run(
    process.execPath,
    [
      "--max-old-space-size=128",
      "--stack-size=4096",
      fileURLToPath(new URL("./doc-text-worker.mjs", import.meta.url)),
      body.path,
      body.ext,
      String(body.maxChars),
    ],
    { timeoutMs: remaining, maxStdoutBytes: 4 * 1024 * 1024, signal },
  );
  if (result.aborted) throw new RequestError("killed", "文档解析已取消并回收", 503);
  if (result.timedOut) throw new RequestError("timeout", "文档解析超过硬期限", 504);
  if (result.overflow) throw new RequestError("output_too_large", "文档输出超过上限", 422);
  if (result.code !== 0) throw new RequestError("killed", "文档解析进程未正常退出", 503);
  let value;
  try {
    value = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new RequestError("invalid_document", "文档解析结果不合法", 422);
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RequestError("invalid_document", "文档解析结果不合法", 422);
  if (value.ok === false && FAILURES.has(value.reason))
    throw new RequestError(
      value.reason,
      "未能提取文档文字",
      value.reason === "too_large" ? 413 : 422,
    );
  if (
    value.ok !== true ||
    typeof value.text !== "string" ||
    typeof value.truncated !== "boolean" ||
    !Number.isInteger(value.charCount) ||
    value.charCount < 1 ||
    value.charCount > DOC_LIMITS.codepoints ||
    Array.from(value.text).length !== Math.min(body.maxChars, value.charCount) ||
    value.truncated !== value.charCount > body.maxChars ||
    (body.ext === "pdf"
      ? !Number.isInteger(value.pageCount) ||
        value.pageCount < 1 ||
        value.pageCount > DOC_LIMITS.pages
      : value.pageCount !== undefined)
  )
    throw new RequestError("invalid_document", "文档解析结果不合法", 422);
  const { ok: _, ...facts } = value;
  return facts;
}
