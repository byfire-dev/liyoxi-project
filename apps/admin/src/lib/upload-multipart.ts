import { FileRegistrationSchema, type FileRegistration } from "@liyoxi/contract";
import type { paths as AdminPaths } from "@liyoxi/contract/types/admin";
import type { AdminApi } from "./api";
import { newIdempotencyKey } from "./idempotency";

export interface MultipartUploadPorts {
  register(file: File, clientToken: string): Promise<FileRegistration>;
  refresh(fileId: string): Promise<FileRegistration>;
  complete(fileId: string, idempotencyKey?: string): Promise<{ fileId: string; status: string }>;
  get(fileId: string): Promise<{ fileId: string; status: string }>;
  cancel(fileId: string, idempotencyKey?: string): Promise<unknown>;
}
export interface MultipartUploadOptions {
  readonly ports: MultipartUploadPorts;
  readonly fetchImpl?: typeof fetch;
  readonly crypto?: Crypto;
  readonly now?: () => number;
  readonly wait?: (ms: number) => Promise<void>;
}
type Session = {
  token: string;
  completeKey: string;
  cancelKey: string;
  cancelRequested?: boolean;
  grant?: FileRegistration;
  uploadId?: string;
  generation: number;
  controller: AbortController;
  refresh?: Promise<FileRegistration>;
  registering?: Promise<FileRegistration>;
  running: boolean;
  completed?: boolean;
  completionAttempted?: boolean;
  confirmOnly?: boolean;
};
class MissingMultipartUpload extends Error {
  constructor() {
    super("直传失败，请重试");
  }
}
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const xml = (value: string) =>
  value.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
const field = (text: string, tag: string) => {
  if (/<!/u.test(text)) throw new Error("上传响应不合格");
  const matches = [...text.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, "g"))];
  if (matches.length !== 1) throw new Error("上传响应不合格");
  return matches[0]![1]!.replace(
    /&(?:amp|lt|gt|quot|apos);/g,
    (s) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" })[s]!,
  );
};
const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((n) => n.toString(16).padStart(2, "0")).join("");

/** Three files, four chunks/file, no persistent credentials or common component changes. */
export function createMultipartUploadAdapter(options: MultipartUploadOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const cryptoApi = options.crypto ?? globalThis.crypto;
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const sessions = new WeakMap<File, Session>();
  const active = new Set<Session>();
  let closed = false;

  const check = (session: Session, generation: number) => {
    if (closed || session.controller.signal.aborted || session.generation !== generation)
      throw new Error("上传已取消");
  };
  async function grant(session: Session) {
    const current = session.grant!;
    if (new Date(current.expiresAt).getTime() > now() + 10_000) return current;
    session.refresh ??= options.ports
      .refresh(current.fileId)
      .then((value) => {
        if (
          value.fileId !== current.fileId ||
          value.key !== current.key ||
          value.bucket !== current.bucket ||
          value.region !== current.region ||
          value.mode !== current.mode
        )
          throw new Error("上传凭据归属发生变化");
        session.grant = value;
        return value;
      })
      .finally(() => {
        session.refresh = undefined;
      });
    return session.refresh;
  }
  async function hmac(key: string, value: string) {
    const imported = await cryptoApi.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      { name: "HMAC", hash: "SHA-1" },
      false,
      ["sign"],
    );
    return hex(await cryptoApi.subtle.sign("HMAC", imported, new TextEncoder().encode(value)));
  }
  async function authorization(
    current: FileRegistration,
    method: string,
    query: Record<string, string>,
    headers: Record<string, string>,
  ) {
    if (!current.sts) throw new Error("未取得分块凭据");
    const canonical = (values: Record<string, string>) =>
      Object.entries(values)
        .map(([key, value]) => [encode(key).toLowerCase(), encode(value)])
        .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0));
    const params = canonical(query);
    const signedHeaders = canonical(headers);
    const time = `${Math.floor(new Date(current.sts.startTime).getTime() / 1000)};${Math.floor(new Date(current.sts.expiredTime).getTime() / 1000)}`;
    const signKey = await hmac(current.sts.tmpSecretKey, time);
    const string = `${method.toLowerCase()}\n/${current.key}\n${params.map(([k, v]) => `${k}=${v}`).join("&")}\n${signedHeaders.map(([k, v]) => `${k}=${v}`).join("&")}\n`;
    const digest = hex(await cryptoApi.subtle.digest("SHA-1", new TextEncoder().encode(string)));
    return `q-sign-algorithm=sha1&q-ak=${current.sts.tmpSecretId}&q-sign-time=${time}&q-key-time=${time}&q-header-list=${signedHeaders.map(([k]) => k).join(";")}&q-url-param-list=${params.map(([k]) => k).join(";")}&q-signature=${await hmac(signKey, `sha1\n${time}\n${digest}\n`)}`;
  }
  async function read(response: Response) {
    const reader = response.body?.getReader();
    let total = 0;
    const chunks: Uint8Array[] = [];
    try {
      if (reader)
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          total += item.value.byteLength;
          if (total > 64 * 1024) {
            await reader.cancel();
            throw new Error("上传响应超限");
          }
          chunks.push(item.value);
        }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  }
  async function cloud(
    session: Session,
    generation: number,
    method: string,
    query: Record<string, string>,
    body?: BodyInit,
    contentType?: string,
  ) {
    check(session, generation);
    const current = await grant(session);
    check(session, generation);
    if (
      !/^[a-z0-9][a-z0-9-]{1,50}-[0-9]{5,20}$/.test(current.bucket) ||
      !/^[a-z]+(?:-[a-z0-9]+){1,4}$/.test(current.region) ||
      !/^incoming\/[a-z0-9-]+\/[a-z0-9.-]+$/.test(current.key) ||
      !current.sts
    )
      throw new Error("上传目标不合格");
    const hostname = `${current.bucket}.cos.${current.region}.myqcloud.com`;
    const headers = {
      "x-cos-security-token": current.sts.sessionToken,
      ...(contentType ? { "Content-Type": contentType } : {}),
    };
    const auth = await authorization(current, method, query, { ...headers, host: hostname });
    check(session, generation);
    const controller = new AbortController();
    const abort = () => controller.abort();
    session.controller.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, 60_000);
    try {
      if (method === "POST" && query.uploadId && contentType === "application/xml")
        session.completionAttempted = true;
      const response = await fetchImpl(
        `https://${hostname}/${current.key.split("/").map(encode).join("/")}?${new URLSearchParams(query)}`,
        {
          method,
          headers: { ...headers, Authorization: auth },
          ...(body === undefined ? {} : { body }),
          redirect: "error",
          signal: controller.signal,
        },
      );
      const text = await read(response);
      check(session, generation);
      if (!response.ok || /<Error>/u.test(text)) {
        let missing = false;
        if (response.status === 404 && method === "GET" && query.uploadId && query["max-parts"]) {
          try {
            missing = field(text, "Code") === "NoSuchUpload";
          } catch {
            /* Invalid error XML cannot prove absence. */
          }
        }
        if (missing) throw new MissingMultipartUpload();
        throw new Error("直传失败，请重试");
      }
      return { response, text };
    } finally {
      clearTimeout(timer);
      session.controller.signal.removeEventListener("abort", abort);
    }
  }

  async function multipart(
    file: File,
    session: Session,
    generation: number,
    progress: (n: number) => void,
  ) {
    const current = session.grant!;
    if (current.chunkSize !== 8 * 1024 * 1024 || current.chunkParallel !== 4)
      throw new Error("分块参数不合格");
    const count = Math.ceil(file.size / current.chunkSize);
    if (count < 1 || count > 10_000) throw new Error("文件分块数超限");
    const parts = new Map<number, string>();
    if (!session.uploadId) {
      session.uploadId = field(
        (await cloud(session, generation, "POST", { uploads: "" })).text,
        "UploadId",
      );
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(session.uploadId)) throw new Error("上传标识不合格");
    } else {
      let marker = 0;
      for (let page = 0; page < 10; page++) {
        const result = await cloud(session, generation, "GET", {
          uploadId: session.uploadId,
          "max-parts": "1000",
          "part-number-marker": String(marker),
        }).catch((error: unknown) => {
          if (error instanceof MissingMultipartUpload && session.completionAttempted) {
            session.confirmOnly = true;
            return null;
          }
          throw error;
        });
        if (!result) return;
        const listed = [...result.text.matchAll(/<Part>([\s\S]*?)<\/Part>/g)];
        if (listed.length > 1000) throw new Error("上传分块列表超限");
        for (const part of listed) {
          const number = Number(field(part[1]!, "PartNumber"));
          if (!Number.isInteger(number) || number < 1 || number > count || parts.has(number))
            throw new Error("上传分块不合格");
          const etag = field(part[1]!, "ETag");
          if (!/^"?[A-Za-z0-9-]{1,128}"?$/.test(etag)) throw new Error("上传分块校验失败");
          parts.set(number, etag);
        }
        if (field(result.text, "IsTruncated") === "false") break;
        const next = Number(field(result.text, "NextPartNumberMarker"));
        if (!Number.isInteger(next) || next <= marker || next > count || page === 9)
          throw new Error("上传分块游标不合格");
        marker = next;
      }
    }
    let next = 1;
    const work = async () => {
      while (next <= count) {
        const number = next++;
        if (parts.has(number)) continue;
        const result = await cloud(
          session,
          generation,
          "PUT",
          { uploadId: session.uploadId!, partNumber: String(number) },
          file.slice((number - 1) * current.chunkSize!, number * current.chunkSize!),
        );
        const etag = result.response.headers.get("etag");
        if (!etag || !/^"?[A-Za-z0-9-]{1,128}"?$/.test(etag)) throw new Error("上传分块校验失败");
        parts.set(number, etag);
        check(session, generation);
        progress(Math.min(99, Math.floor((parts.size / count) * 99)));
      }
    };
    const results = await Promise.allSettled(Array.from({ length: Math.min(4, count) }, work));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    const body = `<CompleteMultipartUpload>${[...parts]
      .sort(([a], [b]) => a - b)
      .map(
        ([number, etag]) =>
          `<Part><PartNumber>${number}</PartNumber><ETag>${xml(etag)}</ETag></Part>`,
      )
      .join("")}</CompleteMultipartUpload>`;
    const completed = await cloud(
      session,
      generation,
      "POST",
      { uploadId: session.uploadId },
      body,
      "application/xml",
    );
    if (!/^"?[A-Za-z0-9-]{1,128}"?$/.test(field(completed.text, "ETag")))
      throw new Error("上传完成响应不合格");
  }
  return {
    async upload(file: File, hooks: { onProgress: (percent: number) => void }) {
      if (closed || active.size >= 3) throw new Error("最多同时上传3个文件");
      let session = sessions.get(file);
      if (!session) {
        session = {
          token: cryptoApi.randomUUID(),
          completeKey: `complete:${cryptoApi.randomUUID()}`,
          cancelKey: `cancel:${cryptoApi.randomUUID()}`,
          generation: 0,
          controller: new AbortController(),
          running: false,
        };
        sessions.set(file, session);
      }
      if (session.cancelRequested) throw new Error("取消尚未完成，请重试取消");
      if (session.running) throw new Error("该文件正在上传");
      session.running = true;
      session.controller = new AbortController();
      const generation = ++session.generation;
      active.add(session);
      try {
        if (!session.grant) {
          session.registering ??= options.ports.register(file, session.token).finally(() => {
            session.registering = undefined;
          });
          session.grant = await session.registering;
          session.registering = undefined;
        }
        check(session, generation);
        if (!session.completed && !session.confirmOnly && session.grant.mode === "multipart") {
          await multipart(file, session, generation, hooks.onProgress);
          if (!session.confirmOnly) session.completed = true;
        } else if (!session.completed && session.grant.mode === "post" && session.grant.post) {
          session.grant = await grant(session);
          check(session, generation);
          if (!session.grant.post) throw new Error("未取得上传表单");
          const form = new FormData();
          for (const [key, value] of Object.entries(session.grant.post.fields))
            form.set(key, value);
          form.set("file", file);
          const timer = setTimeout(() => session.controller.abort(), 60_000);
          try {
            const response = await fetchImpl(session.grant.post.url, {
              method: "POST",
              body: form,
              redirect: "error",
              signal: session.controller.signal,
            });
            await response.body?.cancel();
            if (!response.ok) throw new Error("直传失败，请重试");
          } finally {
            clearTimeout(timer);
          }
          session.completed = true;
        } else if (!session.completed && !session.confirmOnly) throw new Error("未取得上传通道");
        check(session, generation);
        let status = await options.ports.complete(session.grant.fileId, session.completeKey);
        for (let poll = 0; status.status === "promoting" && poll < 120; poll++) {
          await wait(1000);
          check(session, generation);
          status = await options.ports.get(session.grant.fileId);
        }
        check(session, generation);
        if (status.status !== "stored" || status.fileId !== session.grant.fileId)
          throw new Error("文件尚未成功入库");
        hooks.onProgress(100);
        sessions.delete(file);
        return { fileId: status.fileId };
      } finally {
        session.running = false;
        active.delete(session);
      }
    },
    async cancel(file: File) {
      const session = sessions.get(file);
      if (!session) return;
      session.cancelRequested = true;
      session.generation++;
      session.controller.abort();
      const current =
        session.grant ??
        (await (session.registering ?? options.ports.register(file, session.token)));
      session.grant = current;
      if (current) await options.ports.cancel(current.fileId, session.cancelKey);
      sessions.delete(file);
    },
    close() {
      closed = true;
      for (const session of active) {
        session.generation++;
        session.controller.abort();
      }
    },
  };
}

/** Bind the public adapter to the existing typed central API, including its authentication and retry policy. */
export function createAdminMultipartUploadPorts(
  client: AdminApi<AdminPaths>["client"],
  context: Omit<
    AdminPaths["/api/v1/admin/files"]["post"]["requestBody"]["content"]["application/json"],
    "fileName" | "sizeBytes" | "clientToken"
  >,
): MultipartUploadPorts {
  return {
    async register(file, clientToken) {
      const result = await client.POST("/api/v1/admin/files", {
        body: { ...context, fileName: file.name, sizeBytes: String(file.size), clientToken },
      });
      if (!result.data) throw new Error("上传登记失败");
      return FileRegistrationSchema.parse(result.data.data);
    },
    async refresh(fileId) {
      const result = await client.POST("/api/v1/admin/files/{fileId}/refresh-credentials", {
        params: { path: { fileId } },
      });
      if (!result.data) throw new Error("上传续签失败");
      return FileRegistrationSchema.parse(result.data.data);
    },
    async complete(fileId, idempotencyKey = newIdempotencyKey("uploadcomplete")) {
      const result = await client.POST("/api/v1/admin/files/{fileId}/complete", {
        params: { path: { fileId } },
        headers: { "Idempotency-Key": idempotencyKey },
      });
      if (!result.data) throw new Error("上传确认失败");
      if (typeof result.data.data.status !== "string") throw new Error("上传状态不合格");
      return { fileId: result.data.data.fileId, status: result.data.data.status };
    },
    async get(fileId) {
      const result = await client.GET("/api/v1/admin/files/{fileId}", {
        params: { path: { fileId } },
      });
      if (!result.data) throw new Error("上传状态读取失败");
      if (typeof result.data.data.status !== "string") throw new Error("上传状态不合格");
      return { fileId: result.data.data.fileId, status: result.data.data.status };
    },
    async cancel(fileId, idempotencyKey = newIdempotencyKey("uploadcancel")) {
      const result = await client.POST("/api/v1/admin/files/{fileId}/cancel", {
        params: { path: { fileId } },
        headers: { "Idempotency-Key": idempotencyKey },
      });
      if (!result.data) throw new Error("上传取消失败");
      return result.data.data;
    },
  };
}
