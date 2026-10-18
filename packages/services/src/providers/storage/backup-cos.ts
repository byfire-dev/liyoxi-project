import type { BackupTarget, StorageBucket } from "../types.js";
import { backupObjectKey, validBackupTarget } from "./backup-stream.js";
import type { BackupTransport } from "./backup-stream.js";
import { cosAuthorization, cosEncode, xmlEscape, xmlField } from "./cos-signature.js";
import type { CosKey } from "./cos-signature.js";

export interface CosBackupTarget extends BackupTarget {
  readonly region?: string;
  readonly key?: CosKey;
}
type Reply = { status: number; headers: Headers; text: string };
type Request = (url: string, init: RequestInit, cleanup: boolean) => Promise<Reply>;
const regionPattern = /^[a-z]+(?:-[a-z0-9]+){1,4}$/;
const etagPattern = /^"[A-Za-z0-9-]{1,128}"$/;
const uploadPattern = /^[A-Za-z0-9_-]{1,512}$/;
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
const objectPath = (key: string) => `/${key.split("/").map(cosEncode).join("/")}`;
function rejected(): never {
  throw new Error("COS备份未取得可验证结果");
}
function result(reply: Reply, name: string) {
  if (
    reply.status !== 200 ||
    /<(?:[A-Za-z0-9_]+:)?Error(?:\s|>)/u.test(reply.text) ||
    !new RegExp(
      `^\\s*(?:<\\?xml[^?]*\\?>\\s*)?<${name}(?:\\s+xmlns="[^"]*")?>[\\s\\S]*</${name}>\\s*$`,
      "u",
    ).test(reply.text)
  )
    rejected();
}
function etag(value: string | null | undefined) {
  if (!value || !etagPattern.test(value)) rejected();
  return value;
}

/** 物理目标仅来自显式配置；备份专用密钥也不能赋权给只有signer的API实例。 */
export function cosBackupTransport(
  config: {
    readonly region: string;
    readonly buckets: Readonly<Record<StorageBucket, string>>;
    readonly worker?: CosKey;
    readonly backup?: CosBackupTarget;
  },
  context: { readonly now: () => Date; readonly request: Request },
): BackupTransport | undefined {
  if (!config.backup) return undefined;
  const target = config.backup;
  const region = target.region ?? config.region;
  if (
    !validBackupTarget(target, config.buckets) ||
    !/^[a-z0-9][a-z0-9-]{1,50}-[0-9]{5,20}$/u.test(target.bucket) ||
    !regionPattern.test(region)
  )
    throw new TypeError("COS备份目标配置不合格");
  if (!config.worker) return undefined;
  const credential = target.key ?? config.worker;
  const hostname = `${target.bucket}.cos.${region}.myqcloud.com`;

  function request(
    logicalKey: string,
    method: string,
    signal: AbortSignal,
    query: Record<string, string> = {},
    headers: Record<string, string> = {},
    body?: RequestInit["body"],
    cleanup = false,
  ) {
    const key = backupObjectKey(target, logicalKey);
    const start = Math.floor(context.now().getTime() / 1000);
    const authorization = cosAuthorization({
      key: credential,
      method,
      pathname: `/${key}`,
      headers: { ...headers, host: hostname },
      query,
      start,
      end: start + 600,
    });
    const params = new URLSearchParams(query).toString();
    return context.request(
      `https://${hostname}${objectPath(key)}${params ? `?${params}` : ""}`,
      {
        method,
        headers: { ...headers, Authorization: authorization },
        signal,
        ...(body === undefined ? {} : { body }),
      },
      cleanup,
    );
  }
  function uploadId(value: string) {
    if (!uploadPattern.test(value)) rejected();
    return value;
  }
  return {
    async begin(key, signal) {
      const reply = await request(
        key,
        "POST",
        signal,
        { uploads: "" },
        {
          "Content-Type": "application/octet-stream",
        },
      );
      result(reply, "InitiateMultipartUploadResult");
      const id = xmlField(reply.text, "UploadId");
      if (!id) rejected();
      return { uploadId: uploadId(id) };
    },
    async part(input) {
      const reply = await request(
        input.key,
        "PUT",
        input.signal,
        { uploadId: uploadId(input.uploadId), partNumber: String(input.partNumber) },
        { "Content-Length": String(input.body.byteLength) },
        new Uint8Array(input.body),
      );
      if (reply.status !== 200 || reply.text.trim()) rejected();
      return { etag: etag(reply.headers.get("etag")) };
    },
    async complete(input) {
      const parts = input.parts
        .map(
          (part) =>
            `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${xmlEscape(etag(part.etag))}</ETag></Part>`,
        )
        .join("");
      const reply = await request(
        input.key,
        "POST",
        input.signal,
        { uploadId: uploadId(input.uploadId) },
        { "Content-Type": "application/xml" },
        `<CompleteMultipartUpload>${parts}</CompleteMultipartUpload>`,
      );
      result(reply, "CompleteMultipartUploadResult");
      return { etag: etag(xmlField(reply.text, "ETag")) };
    },
    async abort(input) {
      const reply = await request(
        input.key,
        "DELETE",
        input.signal,
        { uploadId: uploadId(input.uploadId) },
        {},
        undefined,
        true,
      );
      if (![200, 204, 404].includes(reply.status) || /<Error(?:\s|>)/u.test(reply.text)) rejected();
    },
    async head(input) {
      const reply = await request(
        input.key,
        "HEAD",
        input.signal,
        {},
        input.ifMatchEtag === undefined ? {} : { "If-Match": etag(input.ifMatchEtag) },
      );
      if (reply.status === 404) return { exists: false, size: 0 };
      const length = reply.headers.get("content-length");
      if (reply.status !== 200 || !length || !/^[0-9]+$/u.test(length)) rejected();
      const size = Number(length);
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_BYTES) rejected();
      const identity = etag(reply.headers.get("etag"));
      if (input.ifMatchEtag !== undefined && identity !== input.ifMatchEtag) rejected();
      const digest = reply.headers.get("x-cos-meta-lyx-sha256");
      if (digest !== null && !/^[0-9a-f]{64}$/u.test(digest)) rejected();
      return {
        exists: true,
        size,
        etag: identity,
        ...(digest === null ? {} : { sha256: digest }),
      };
    },
    async copy(input) {
      const reply = await request(
        input.dstKey,
        "PUT",
        input.signal,
        {},
        {
          "x-cos-copy-source": `${hostname}${objectPath(backupObjectKey(target, input.srcKey))}`,
          "x-cos-copy-source-if-match": etag(input.ifMatchEtag),
          "x-cos-metadata-directive": "Copy",
        },
      );
      result(reply, "CopyObjectResult");
      return { etag: etag(xmlField(reply.text, "ETag")) };
    },
  };
}
