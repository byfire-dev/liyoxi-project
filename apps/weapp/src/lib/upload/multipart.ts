import type { Registration } from "./api";
import type { ResumeManifest, ResumeOwner, ResumeStore } from "./resume";
import { ResumeRecordError, sameResumeOwner } from "./resume";
import { hmacSha1, md5, sha1, utf8Bytes } from "./hash";

export interface MultipartFile {
  path: string;
  size: number;
}

export interface CloudRequest {
  url: string;
  method: "GET" | "POST" | "PUT";
  headers: Record<string, string>;
  data?: string | ArrayBuffer;
}
export interface CloudResponse {
  statusCode: number;
  headers: Record<string, string>;
  data: string;
}
export interface CloudTask<T = CloudResponse> {
  done: Promise<T>;
  abort(): void;
}
export interface MultipartDeps {
  owner(): ResumeOwner | null;
  resume: ResumeStore;
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  send(request: CloudRequest): CloudTask;
  refresh(fileId: string): Promise<Registration>;
  now(): number;
}
export type Recovery = "initiate_unknown" | "complete_unknown";
export class MultipartUncertainError extends Error {
  constructor(readonly recovery: Recovery) {
    super(
      recovery === "initiate_unknown"
        ? "初始化回执未确认，请取消原上传后重新选择"
        : "合并回执未确认，可重试查询；仍未找到时请取消原上传",
    );
  }
}
export interface MultipartPort {
  restore(token: string, file: MultipartFile, check: () => void): Promise<ResumeManifest | null>;
  upload(
    ticket: Registration,
    file: MultipartFile,
    token: string,
    confirmKey: string,
    progress: (value: number) => void,
    check: () => void,
  ): CloudTask<void>;
  forget(fileId: string): void;
}

const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const xmlEscape = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
const invalid = () => new Error("对象存储响应不合格，请取消原上传后重试");
const hasControl = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32);
interface XmlNode {
  name: string;
  text: string;
  children: XmlNode[];
}
function xmlDecode(value: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/u.test(value)) throw invalid();
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
    const named = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (Object.hasOwn(named, entity)) return named[entity as keyof typeof named];
    const n = entity.startsWith("&#x")
      ? parseInt(entity.slice(3, -1), 16)
      : Number(entity.slice(2, -1));
    if (!Number.isInteger(n) || n < 32 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff))
      throw invalid();
    return String.fromCodePoint(n);
  });
}
/** 不接受 DTD、实体声明、命名空间前缀或嵌套同名字段；字段只从直接子节点读。 */
function parseXml(input: string): XmlNode {
  if (input.length > 64 * 1024) throw invalid();
  const value = input
    .replace(/^\uFEFF?\s*<\?xml\s+version="1\.0"(?:\s+encoding="UTF-8")?\s*\?>/iu, "")
    .trim();
  const container: XmlNode = { name: "", text: "", children: [] };
  const stack = [container];
  const tokens = /<\/?[A-Za-z][A-Za-z0-9]*(?:\s+xmlns="[^"]+")?\s*>|[^<]+/g;
  let end = 0;
  for (const match of value.matchAll(tokens)) {
    if (match.index !== end) throw invalid();
    end += match[0].length;
    const raw = match[0],
      parent = stack[stack.length - 1]!;
    if (!raw.startsWith("<")) {
      parent.text += xmlDecode(raw);
      continue;
    }
    const tag = /^<(\/?)([A-Za-z][A-Za-z0-9]*)(\s+xmlns="[^"]+")?\s*>$/u.exec(raw);
    if (!tag || (tag[3] && (stack.length !== 1 || tag[1]))) throw invalid();
    if (tag[1]) {
      if (stack.length === 1 || parent.name !== tag[2]) throw invalid();
      stack.pop();
    } else {
      if (stack.length > 5 || parent.children.length > 1000) throw invalid();
      const child = { name: tag[2]!, text: "", children: [] };
      parent.children.push(child);
      stack.push(child);
    }
  }
  if (
    end !== value.length ||
    stack.length !== 1 ||
    container.children.length !== 1 ||
    container.text.trim()
  )
    throw invalid();
  return container.children[0]!;
}
function field(node: XmlNode, name: string): string {
  const found = node.children.filter((child) => child.name === name);
  if (found.length !== 1 || found[0]!.children.length) throw invalid();
  return found[0]!.text;
}
function expectRoot(node: XmlNode, name: string, ticket: Registration) {
  if (
    node.name !== name ||
    node.text.trim() ||
    field(node, "Bucket") !== ticket.bucket ||
    field(node, "Key") !== ticket.key
  )
    throw invalid();
}
const etag = (value: string) => {
  const match = /^(?:"([a-fA-F0-9]{32})"|([a-fA-F0-9]{32}))$/u.exec(value);
  if (!match) throw invalid();
  return (match[1] ?? match[2])!.toLowerCase();
};
function base64Digest(hex: string): string {
  const bytes = Uint8Array.from(hex.match(/../g)!, (part) => parseInt(part, 16));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    result += alphabet[(n >>> 18) & 63]! + alphabet[(n >>> 12) & 63]!;
    result += i + 1 < bytes.length ? alphabet[(n >>> 6) & 63]! : "=";
    result += i + 2 < bytes.length ? alphabet[n & 63]! : "=";
  }
  return result;
}
function authorization(
  ticket: Registration,
  method: string,
  query: Record<string, string>,
  headers: Record<string, string>,
): string {
  if (!ticket.sts) throw new Error("没有取得分块凭证");
  const canonical = (values: Record<string, string>) =>
    Object.entries(values)
      .map(([key, value]) => [encode(key).toLowerCase(), encode(value)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const params = canonical(query),
    signed = canonical(headers);
  const start = Math.floor(Date.parse(ticket.sts.startTime) / 1000);
  const end = Math.floor(Date.parse(ticket.sts.expiredTime) / 1000);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw invalid();
  const time = `${start};${end}`;
  const mac = (key: string, data: string) => hmacSha1(utf8Bytes(key), utf8Bytes(data));
  const signKey = mac(ticket.sts.tmpSecretKey, time);
  const http = `${method.toLowerCase()}\n/${ticket.key}\n${params.map(([k, v]) => `${k}=${v}`).join("&")}\n${signed.map(([k, v]) => `${k}=${v}`).join("&")}\n`;
  const signature = mac(signKey, `sha1\n${time}\n${sha1(http)}\n`);
  return `q-sign-algorithm=sha1&q-ak=${ticket.sts.tmpSecretId}&q-sign-time=${time}&q-key-time=${time}&q-header-list=${signed.map(([k]) => k).join(";")}&q-url-param-list=${params.map(([k]) => k).join(";")}&q-signature=${signature}`;
}
class MissingUpload extends Error {}
function bound(record: ResumeManifest, ticket: Registration) {
  return (
    record.fileId === ticket.fileId &&
    record.key === ticket.key &&
    record.bucket === ticket.bucket &&
    record.region === ticket.region &&
    record.chunkSize === ticket.chunkSize &&
    ticket.mode === "multipart"
  );
}
function chunks(file: MultipartFile, chunkSize: number): number {
  if (
    !Number.isSafeInteger(file.size) ||
    file.size <= 0 ||
    !Number.isSafeInteger(chunkSize) ||
    chunkSize <= 0
  )
    throw invalid();
  const count = Math.ceil(file.size / chunkSize);
  if (count > 10000) throw new Error("文件分块过多，请联系服务经理代传");
  return count;
}

/** 原生网络/文件端口无 SDK；只处理服务端已经授予的精确对象。 */
export function createMultipartPort(deps: MultipartDeps): MultipartPort {
  const owner = deps.owner();
  const current = () => {
    const actual = deps.owner();
    if (!owner || !actual || !sameResumeOwner(owner, actual))
      throw new Error("上传归属已变化，请重新选择");
    return owner;
  };
  async function digests(file: MultipartFile, chunkSize: number, check: () => void) {
    const result: string[] = [];
    for (let part = 0; part < chunks(file, chunkSize); part++) {
      check();
      current();
      const length = Math.min(chunkSize, file.size - part * chunkSize);
      const bytes = await deps.read(file.path, part * chunkSize, length);
      check();
      current();
      if (bytes.byteLength !== length) throw new Error("文件读取不完整，请重新选择");
      result.push(md5(bytes));
    }
    return result;
  }
  async function restore(token: string, file: MultipartFile, check: () => void) {
    check();
    if (!owner && !deps.owner()) return null;
    const record = deps.resume.load(current(), token);
    if (!record) return null;
    try {
      if (record.size !== file.size) throw new Error("重选文件与原上传不一致，请取消原上传");
      const actual = await digests(file, record.chunkSize, check);
      check();
      current();
      if (actual.some((value, i) => value !== record.digests[i]))
        throw new Error("重选文件与原上传不一致，请取消原上传");
    } catch (error) {
      check();
      current();
      throw new ResumeRecordError(
        error instanceof Error ? error.message : "文件无法验证，请重新选择",
        record.fileId,
      );
    }
    return record;
  }
  function upload(
    initial: Registration,
    file: MultipartFile,
    token: string,
    confirmKey: string,
    progress: (value: number) => void,
    outer: () => void,
  ): CloudTask<void> {
    const active = new Set<CloudTask>();
    let stopped = false,
      ticket = initial,
      refreshing: Promise<Registration> | null = null;
    const check = () => {
      outer();
      current();
      if (stopped) throw new Error("上传已停止");
    };
    const abort = () => {
      stopped = true;
      for (const task of active) task.abort();
    };
    const save = (record: ResumeManifest) => {
      check();
      deps.resume.save(record);
      check();
    };
    async function grant() {
      check();
      if (
        Date.parse(ticket.expiresAt) > deps.now() + 10_000 &&
        ticket.sts &&
        Date.parse(ticket.sts.expiredTime) > deps.now() + 10_000
      )
        return ticket;
      refreshing ??= deps.refresh(ticket.fileId);
      const fresh = await refreshing;
      check();
      if (
        fresh.fileId !== initial.fileId ||
        fresh.key !== initial.key ||
        fresh.bucket !== initial.bucket ||
        fresh.region !== initial.region ||
        fresh.chunkSize !== initial.chunkSize ||
        fresh.mode !== "multipart"
      )
        throw invalid();
      ticket = fresh;
      refreshing = null;
      return ticket;
    }
    async function cloud(
      method: CloudRequest["method"],
      query: Record<string, string>,
      data?: string | ArrayBuffer,
      extra: Record<string, string> = {},
    ) {
      const g = await grant();
      check();
      if (
        !g.sts ||
        !/^[a-z0-9][a-z0-9-]*-\d+$/u.test(g.bucket) ||
        !/^[a-z0-9-]+$/u.test(g.region) ||
        !g.key.startsWith(`incoming/${g.fileId}/`) ||
        hasControl(g.key)
      )
        throw invalid();
      const host = `${g.bucket}.cos.${g.region}.myqcloud.com`;
      const headers = {
        "content-type": "application/octet-stream",
        "x-cos-security-token": g.sts.sessionToken,
        ...extra,
      };
      const signedHeaders = { host, ...headers };
      const url = `https://${host}/${g.key.split("/").map(encode).join("/")}?${Object.entries(query)
        .map(([k, v]) => `${encode(k)}=${encode(v)}`)
        .join("&")}`;
      const task = deps.send({
        url,
        method,
        headers: { ...headers, Authorization: authorization(g, method, query, signedHeaders) },
        ...(data === undefined ? {} : { data }),
      });
      active.add(task);
      try {
        const response = await task.done;
        check();
        if (response.data.length > 64 * 1024) throw invalid();
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const node = parseXml(response.data);
          if (node.name === "Error" && field(node, "Code") === "NoSuchUpload")
            throw new MissingUpload();
          throw new Error("对象存储请求失败，请重试");
        }
        return response;
      } finally {
        active.delete(task);
      }
    }
    async function parts(record: ResumeManifest): Promise<Map<number, string>> {
      const found = new Map<number, string>();
      let marker = 0;
      for (;;) {
        check();
        const response = await cloud("GET", {
          uploadId: record.uploadId!,
          "max-parts": "100",
          ...(marker ? { "part-number-marker": String(marker) } : {}),
        });
        check();
        const node = parseXml(response.data);
        expectRoot(node, "ListPartsResult", ticket);
        if (field(node, "UploadId") !== record.uploadId) throw invalid();
        const values = node.children.filter((child) => child.name === "Part");
        if (values.length > 100) throw invalid();
        let previous = marker;
        for (const part of values) {
          if (part.text.trim()) throw invalid();
          const raw = field(part, "PartNumber"),
            rawSize = field(part, "Size");
          if (!/^[1-9]\d*$/u.test(raw) || !/^[1-9]\d*$/u.test(rawSize)) throw invalid();
          const n = Number(raw),
            size = Number(rawSize),
            digest = etag(field(part, "ETag"));
          if (
            n <= previous ||
            n > record.digests.length ||
            found.has(n) ||
            size !== Math.min(record.chunkSize, file.size - (n - 1) * record.chunkSize) ||
            digest !== record.digests[n - 1]
          )
            throw invalid();
          previous = n;
          found.set(n, digest);
        }
        const truncated = field(node, "IsTruncated");
        if (truncated === "false") return found;
        if (truncated !== "true" || !values.length) throw invalid();
        const next = field(node, "NextPartNumberMarker");
        if (!/^[1-9]\d*$/u.test(next) || Number(next) !== previous || previous <= marker)
          throw invalid();
        marker = previous;
      }
    }
    const done = (async () => {
      try {
        check();
        if (
          initial.mode !== "multipart" ||
          !initial.chunkSize ||
          !initial.chunkParallel ||
          !Number.isSafeInteger(initial.chunkParallel) ||
          initial.chunkParallel < 1
        )
          throw invalid();
        let record = await restore(token, file, check);
        check();
        if (record && !bound(record, initial)) throw invalid();
        if (!record) {
          const hashes = await digests(file, initial.chunkSize, check);
          check();
          record = {
            version: 1,
            owner: current(),
            token,
            fileId: initial.fileId,
            bucket: initial.bucket,
            region: initial.region,
            key: initial.key,
            size: file.size,
            chunkSize: initial.chunkSize,
            digests: hashes,
            uploadId: null,
            phase: "initiating",
            confirmKey,
            expiresAt: Math.min(
              Date.parse(initial.uploadExpiresAt),
              deps.now() + 24 * 60 * 60 * 1000,
            ),
          };
          save(record);
          try {
            const response = await cloud("POST", { uploads: "" });
            check();
            const node = parseXml(response.data);
            expectRoot(node, "InitiateMultipartUploadResult", ticket);
            const id = field(node, "UploadId");
            if (!id || id.length > 2048 || hasControl(id)) throw invalid();
            record = { ...record, uploadId: id, phase: "uploading" };
            save(record);
          } catch (error) {
            check();
            throw error instanceof MultipartUncertainError
              ? error
              : new MultipartUncertainError("initiate_unknown");
          }
        } else if (record.phase === "initiating")
          throw new MultipartUncertainError("initiate_unknown");
        if (record.phase === "uploaded") {
          check();
          progress(100);
          return;
        }
        let remote: Map<number, string>;
        try {
          remote = await parts(record);
        } catch (error) {
          check();
          if (error instanceof MissingUpload && record.phase === "completing") return;
          throw error;
        }
        let confirmed = [...remote.keys()].reduce(
          (sum, n) => sum + Math.min(record!.chunkSize, file.size - (n - 1) * record!.chunkSize),
          0,
        );
        check();
        progress(Math.floor((confirmed / file.size) * 100));
        const pending = record.digests.map((_, i) => i + 1).filter((n) => !remote.has(n));
        if (record.phase === "completing" && pending.length)
          throw new MultipartUncertainError("complete_unknown");
        let next = 0;
        async function worker() {
          while (next < pending.length) {
            check();
            const n = pending[next++]!,
              length = Math.min(record!.chunkSize, file.size - (n - 1) * record!.chunkSize);
            const bytes = await deps.read(file.path, (n - 1) * record!.chunkSize, length);
            check();
            const digest = record!.digests[n - 1]!;
            if (bytes.byteLength !== length || md5(bytes) !== digest)
              throw new Error("文件已变化，请取消原上传后重新选择");
            const exact = new Uint8Array(bytes.byteLength);
            exact.set(bytes);
            const response = await cloud(
              "PUT",
              { uploadId: record!.uploadId!, partNumber: String(n) },
              exact.buffer,
              { "content-md5": base64Digest(digest) },
            );
            check();
            const tags = Object.entries(response.headers).filter(
              ([key]) => key.toLowerCase() === "etag",
            );
            if (tags.length !== 1 || etag(tags[0]![1]) !== digest) throw invalid();
            confirmed += length;
            check();
            progress(Math.floor((confirmed / file.size) * 100));
          }
        }
        const workers = Array.from(
          { length: Math.min(initial.chunkParallel, 2, Math.max(pending.length, 1)) },
          worker,
        );
        try {
          await Promise.all(workers);
        } catch (error) {
          abort();
          await Promise.allSettled(workers);
          throw error;
        }
        check();
        remote = await parts(record);
        check();
        if (remote.size !== record.digests.length) throw invalid();
        const body = `<CompleteMultipartUpload>${record.digests.map((digest, i) => `<Part><PartNumber>${i + 1}</PartNumber><ETag>${xmlEscape(`"${digest}"`)}</ETag></Part>`).join("")}</CompleteMultipartUpload>`;
        record = { ...record, phase: "completing" };
        save(record);
        try {
          const response = await cloud("POST", { uploadId: record.uploadId! }, body, {
            "content-type": "application/xml",
          });
          check();
          const node = parseXml(response.data);
          expectRoot(node, "CompleteMultipartUploadResult", ticket);
          if (!/^"?[a-fA-F0-9]{32}(?:-[1-9]\d*)?"?$/u.test(field(node, "ETag"))) throw invalid();
          record = { ...record, phase: "uploaded" };
          save(record);
        } catch {
          check();
          throw new MultipartUncertainError("complete_unknown");
        }
      } finally {
        for (const task of active) task.abort();
        await Promise.allSettled([...active].map((task) => task.done));
      }
    })();
    return { done, abort };
  }
  return { restore, upload, forget: (fileId) => deps.resume.remove(current(), fileId) };
}
