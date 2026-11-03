import { failed, ok } from "../types.js";
import type { MediaProvider, MediaZipPreview, MediaZipResult } from "../types.js";
import { cosEncode } from "../storage/cos-signature.js";
import type { CiConfig, createCiHttp } from "./http.js";
import { ciChild, ciText, parseCiXml } from "./xml.js";
import type { CiXml } from "./xml.js";

const invalid = () => new TypeError("CI压缩结果或目录不完整");
const bad = () => failed("rejected", "CI压缩对象或目录不合法");
const key = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value) <= 1024 &&
  !/[\p{Cc}\p{Cs}]/u.test(value) &&
  !value.startsWith("/") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");

export const validZipEntryName = (value: unknown): value is string =>
  key(value) && !/[\\:]/.test(value);

function count(value: string | undefined, maximum: number): number {
  if (value === undefined || !/^(?:0|[1-9]\d{0,3})$/.test(value)) throw invalid();
  const parsed = Number(value);
  if (parsed > maximum) throw invalid();
  return parsed;
}

/** Only successful FileCompress jobs carry installable, configuration-bound output facts. */
export function parseCiFileCompressResult(
  job: CiXml,
  config: Pick<CiConfig, "region" | "buckets">,
): MediaZipResult | undefined {
  const operation = ciChild(job, "Operation"),
    result = operation ? ciChild(operation, "FileCompressResult") : undefined,
    tag = ciText(job, "Tag");
  if (result && tag !== "FileCompress") throw invalid();
  if (tag !== "FileCompress" || ciText(job, "State") !== "Success") return undefined;
  if (!operation || !result) throw invalid();
  const output = ciChild(operation, "Output"),
    objectKey = ciText(result, "Object");
  if (
    !key(objectKey) ||
    ciText(result, "Region") !== config.region ||
    ciText(result, "Bucket") !== config.buckets.media ||
    !output ||
    ciText(output, "Region") !== config.region ||
    ciText(output, "Bucket") !== config.buckets.media ||
    ciText(output, "Object") !== objectKey
  )
    throw invalid();
  const fileCount = count(ciText(result, "CompressFileCount"), 1000),
    errors = ciChild(result, "ErrorDetail"),
    errorCount = errors ? count(ciText(errors, "ErrorCount"), 1000) : 0;
  if (
    fileCount === 0 ||
    errorCount !== 0 ||
    errors?.children.some((one) => one.name === "ErrorFile")
  )
    throw invalid();
  return { dst: { bucket: "media", key: objectKey }, fileCount, errorCount };
}

function preview(body: string): MediaZipPreview {
  const root = parseCiXml(body);
  if (root.name !== "Response" || ciText(root, "IsTruncated") !== "false") throw invalid();
  const fileCount = count(ciText(root, "FileNumber"), 999),
    members = root.children.filter((one) => one.name === "Contents");
  if (fileCount === 0 || members.length !== fileCount) throw invalid();
  const names = new Set<string>();
  const entries = members.map((member) => {
    const name = ciText(member, "Key"),
      size = ciText(member, "UncompressedSize");
    if (
      !validZipEntryName(name) ||
      names.has(name) ||
      size === undefined ||
      !/^(?:0|[1-9]\d{0,19})$/.test(size) ||
      BigInt(size) > 18446744073709551615n
    )
      throw invalid();
    names.add(name);
    return { name, sizeBytes: size };
  });
  return { fileCount, truncated: false, entries };
}

// Official zippreview regions; unsupported deployments must use the existing per-episode fallback.
const previewRegions = new Set([
  "ap-beijing",
  "ap-shanghai",
  "ap-guangzhou",
  "ap-chengdu",
  "ap-nanjing",
  "ap-chongqing",
  "ap-hongkong",
  "ap-singapore",
  "na-siliconvalley",
]);

export function createCiZipPreview(
  http: Pick<ReturnType<typeof createCiHttp>, "request">,
  config: Pick<CiConfig, "region">,
): Pick<MediaProvider, "previewZip"> {
  return {
    async previewZip(input) {
      if (input.src?.bucket !== "media" || !key(input.src.key)) return bad();
      if (!previewRegions.has(config.region))
        return failed("unsupported", "当前地域未在CI压缩包预览支持范围内");
      const response = await http.request({
        bucket: "media",
        cos: true,
        method: "GET",
        path: `/${input.src.key.split("/").map(cosEncode).join("/")}`,
        query: { "ci-process": "zippreview" },
        signal: input.signal,
      });
      if (!response.ok) return response;
      try {
        return ok(preview(response.value));
      } catch {
        return bad();
      }
    },
  };
}
