import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  checkedStream,
  validStreamRead,
  validStreamWrite,
  verifyReplay,
  STREAM_TIMEOUT_MS,
} from "./streams.js";
import { failed, INCOMING_PREFIX, ok, STORAGE_BUCKETS } from "../types.js";
import type {
  ObjectRef,
  ObjectHead,
  ProviderResult,
  StorageBucket,
  StorageProvider,
  StsCredential,
} from "../types.js";
import {
  cosAuthorization,
  cosEncode,
  cosPostPolicy,
  stsAuthorization,
  xmlField,
} from "./cos-signature.js";
import type { CosKey } from "./cos-signature.js";

export interface CosConfig {
  readonly region: string;
  readonly buckets: Readonly<Record<StorageBucket, string>>;
  readonly signer?: CosKey;
  readonly stsIssuer?: CosKey;
  readonly worker?: CosKey;
}
export interface CosOptions {
  readonly now: () => Date;
  readonly fetchImpl?: typeof fetch;
}
type HttpReply = { status: number; headers: Headers; bytes: Uint8Array; text: string };
const BAD = () => failed("rejected", "COS 请求参数不合格");
const OFF = () => failed("unsupported", "当前进程未配置该对象存储角色");
const UNAVAILABLE = () => failed("unavailable", "COS 请求未取得可验证结果");
const validKey = (key: string) =>
  key.length > 0 &&
  Buffer.byteLength(key) <= 1024 &&
  !/[\p{Cc}\\]/u.test(key) &&
  !key.split("/").some((part) => part === "." || part === "..");
const validRef = (ref: ObjectRef) => STORAGE_BUCKETS.includes(ref.bucket) && validKey(ref.key);
const validSecret = (key: CosKey | undefined) =>
  key === undefined ||
  (/^[A-Za-z0-9_-]{1,128}$/.test(key.secretId) && /^[\x21-\x7e]{1,256}$/.test(key.secretKey));
const objectPath = (key: string) => `/${key.split("/").map(cosEncode).join("/")}`;
function failure(reply: Pick<HttpReply, "status">) {
  return failed(
    reply.status >= 500 || reply.status === 429 ? "unavailable" : "rejected",
    "COS 已拒绝请求",
  );
}
function textValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 8192 &&
    !/[\p{Cc}]/u.test(value)
  );
}

/** No credential discovery, construction requests, retries or borrowed connection ownership. */
export function createCosStorage(
  config: CosConfig,
  options: CosOptions,
): StorageProvider & { close(): Promise<void> } {
  if (
    !/^[a-z]+(?:-[a-z0-9]+){1,4}$/.test(config.region) ||
    STORAGE_BUCKETS.some(
      (bucket) => !/^[a-z0-9][a-z0-9-]{1,50}-[0-9]{5,20}$/.test(config.buckets[bucket]),
    ) ||
    ![config.signer, config.stsIssuer, config.worker].every(validSecret) ||
    (!config.signer && !config.worker)
  )
    throw new TypeError("COS 配置形状不合格");
  const accounts = new Set(
    STORAGE_BUCKETS.map((bucket) => config.buckets[bucket].split("-").at(-1)),
  );
  if (accounts.size !== 1) throw new TypeError("COS 四桶账号后缀不一致");
  const account = [...accounts][0]!;
  const fetchImpl = options.fetchImpl ?? fetch;
  const active = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  const host = (bucket: StorageBucket) =>
    `${config.buckets[bucket]}.cos.${config.region}.myqcloud.com`;
  const readKey = config.signer ?? config.worker!;

  async function request(
    url: string,
    init: RequestInit,
    maxBytes = 64 * 1024,
    deadline?: number,
  ): Promise<HttpReply> {
    if (closed || init.signal?.aborted || (deadline !== undefined && deadline <= Date.now()))
      throw new Error("COS 已关闭或到期");
    const controller = new AbortController();
    const abort = () => controller.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    active.add(controller);
    const timer = setTimeout(
      () => controller.abort(),
      deadline === undefined ? 10_000 : Math.min(10_000, deadline - Date.now()),
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      const length = response.headers.get("content-length");
      if (
        init.method !== "HEAD" &&
        length !== null &&
        (!/^[0-9]+$/.test(length) || Number(length) > maxBytes)
      ) {
        await response.body?.cancel();
        throw new Error("COS 正文超限");
      }
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader)
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          total += chunk.value.byteLength;
          if (total > maxBytes) {
            controller.abort();
            await reader.cancel();
            throw new Error("COS 正文超限");
          }
          chunks.push(chunk.value);
        }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        status: response.status,
        headers: response.headers,
        bytes,
        text: maxBytes <= 4096 ? "" : new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } finally {
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      clearTimeout(timer);
      active.delete(controller);
      init.signal?.removeEventListener("abort", abort);
    }
  }
  async function run<T>(action: () => Promise<ProviderResult<T>>): Promise<ProviderResult<T>> {
    const promise = action().catch(() => UNAVAILABLE());
    pending.add(promise);
    try {
      return await promise;
    } finally {
      pending.delete(promise);
    }
  }
  function signed(
    input: ObjectRef,
    method: string,
    key: CosKey,
    headers: Record<string, string> = {},
    query: Record<string, string> = {},
    body?: RequestInit["body"],
    maxBytes?: number,
    deadline?: number,
    signal?: AbortSignal,
  ) {
    const hostname = host(input.bucket);
    const start = Math.floor(options.now().getTime() / 1000);
    const signedHeaders = { ...headers, host: hostname };
    const authorization = cosAuthorization({
      key,
      method,
      pathname: `/${input.key}`,
      query,
      headers: signedHeaders,
      start,
      end: start + 600,
    });
    const params = new URLSearchParams(query).toString();
    return request(
      `https://${hostname}${objectPath(input.key)}${params ? `?${params}` : ""}`,
      {
        method,
        headers: { ...headers, Authorization: authorization },
        ...(body === undefined ? {} : { body }),
        signal,
      },
      maxBytes,
      deadline,
    );
  }
  async function transfer<T>(
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    if (closed || signal.aborted) return UNAVAILABLE();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener("abort", abort, { once: true });
    active.add(controller);
    const timer = setTimeout(abort, STREAM_TIMEOUT_MS);
    try {
      return await action(controller.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      active.delete(controller);
    }
  }
  function streamFetch(
    input: ObjectRef,
    method: string,
    key: CosKey,
    headers: Record<string, string>,
    signal: AbortSignal,
    body?: Readable,
  ) {
    const hostname = host(input.bucket),
      start = Math.floor(options.now().getTime() / 1000);
    const authorization = cosAuthorization({
      key,
      method,
      pathname: `/${input.key}`,
      query: {},
      headers: { ...headers, host: hostname },
      start,
      end: start + 600,
    });
    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers: { ...headers, Authorization: authorization },
      signal,
      redirect: "error",
    };
    if (body) {
      init.body = Readable.toWeb(body) as ReadableStream<Uint8Array>;
      init.duplex = "half";
    }
    return fetchImpl(`https://${hostname}${objectPath(input.key)}`, init);
  }
  async function grant(
    bucket: StorageBucket,
    keyPrefix: string,
    durationSec: number,
    abortOnly = false,
    deadline?: number,
  ): Promise<ProviderResult<StsCredential>> {
    if (!config.stsIssuer) return OFF();
    const resource = `qcs::cos:${config.region}:uid/${account}:${config.buckets[bucket]}/${keyPrefix}${abortOnly ? "" : "*"}`;
    const policy = {
      version: "2.0",
      statement: [
        {
          effect: "allow",
          action: abortOnly
            ? ["name/cos:AbortMultipartUpload"]
            : [
                "name/cos:InitiateMultipartUpload",
                "name/cos:UploadPart",
                "name/cos:ListParts",
                "name/cos:CompleteMultipartUpload",
                "name/cos:AbortMultipartUpload",
              ],
          resource: [resource],
        },
        ...(abortOnly || /^incoming\/b[0-9a-f-]{36}\/$/.test(keyPrefix)
          ? [
              {
                effect: "allow",
                action: ["name/cos:ListMultipartUploads"],
                resource: [`qcs::cos:${config.region}:uid/${account}:${config.buckets[bucket]}/*`],
                condition: { string_equal: { "cos:prefix": keyPrefix } },
              },
            ]
          : []),
      ],
    };
    const body = JSON.stringify({
      Name: "lyx-upload",
      Policy: cosEncode(JSON.stringify(policy)),
      DurationSeconds: durationSec,
    });
    const timestamp = Math.floor(options.now().getTime() / 1000);
    const reply = await request(
      "https://sts.tencentcloudapi.com/",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: stsAuthorization(config.stsIssuer, body, timestamp),
          "X-TC-Action": "GetFederationToken",
          "X-TC-Version": "2018-08-13",
          "X-TC-Timestamp": String(timestamp),
          "X-TC-Region": config.region,
        },
        body,
      },
      undefined,
      deadline,
    );
    if (reply.status !== 200) return failure(reply);
    const parsed = JSON.parse(reply.text) as {
      Response?: {
        Error?: { Code?: string };
        Credentials?: { TmpSecretId?: unknown; TmpSecretKey?: unknown; Token?: unknown };
        ExpiredTime?: unknown;
        StartTime?: unknown;
      };
    };
    const response = parsed.Response;
    if (response?.Error)
      return failed(
        response.Error.Code?.startsWith("InternalError") ||
          response.Error.Code === "RequestLimitExceeded"
          ? "unavailable"
          : "rejected",
        "STS 未签发凭据",
      );
    const credentials = response?.Credentials;
    const expiry = response?.ExpiredTime;
    const startTime = response?.StartTime ?? timestamp;
    if (
      !credentials ||
      !textValue(credentials.TmpSecretId) ||
      !textValue(credentials.TmpSecretKey) ||
      !textValue(credentials.Token) ||
      !Number.isSafeInteger(expiry) ||
      !Number.isSafeInteger(startTime) ||
      Number(startTime) > timestamp + 300 ||
      Number(expiry) <= timestamp ||
      Number(expiry) > timestamp + durationSec + 300
    )
      return UNAVAILABLE();
    return ok({
      accessKeyId: credentials.TmpSecretId,
      secretAccessKey: credentials.TmpSecretKey,
      sessionToken: credentials.Token,
      startTime: new Date(Number(startTime) * 1000),
      expiresAt: new Date(Number(expiry) * 1000),
    });
  }
  async function readTo(
    input: Parameters<StorageProvider["readTo"]>[0],
    signal: AbortSignal,
  ): ReturnType<StorageProvider["readTo"]> {
    if (!validRef(input) || !validStreamRead(input)) return BAD();
    const head = await signed(
      input,
      "HEAD",
      readKey,
      {},
      {},
      undefined,
      undefined,
      undefined,
      signal,
    );
    if (head.status !== 200) return failure(head);
    if (
      head.headers.get("etag") !== input.ifMatchEtag ||
      head.headers.get("content-length") !== String(input.expectedSize)
    )
      return failed("rejected", "COS对象头与预期不一致");
    const response = await streamFetch(
      input,
      "GET",
      readKey,
      { "If-Match": input.ifMatchEtag },
      signal,
    );
    const reader = response.body?.getReader();
    const abort = () => {
      void reader?.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (response.status !== 200) return failure(response);
      if (
        !reader ||
        response.headers.get("etag") !== input.ifMatchEtag ||
        response.headers.get("content-length") !== String(input.expectedSize)
      )
        return failed("rejected", "COS对象流声明不一致");
      const source = {
        async *[Symbol.asyncIterator]() {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) return;
            yield chunk.value;
          }
        },
      };
      let digest = "";
      for await (const chunk of checkedStream(source, input.expectedSize, signal, (value) => {
        digest = value;
      }))
        await input.sink(chunk);
      return ok({ size: input.expectedSize, sha256: digest });
    } finally {
      signal.removeEventListener("abort", abort);
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
    }
  }

  return {
    status: "cos",
    configured: true,
    // Bucket versioning is not inferred from a key being configured; E4 verifies it separately.
    capabilities: { sts: config.stsIssuer !== undefined, versioning: false },
    uploadLocation: { region: config.region, buckets: config.buckets },
    async close() {
      closed = true;
      for (const controller of active) controller.abort();
      await Promise.allSettled([...pending]);
    },
    async presignPost(input) {
      if (
        !validRef(input) ||
        !input.key.startsWith(INCOMING_PREFIX) ||
        !Number.isSafeInteger(input.maxBytes) ||
        input.maxBytes < 1 ||
        input.maxBytes > 20 * 1024 * 1024 ||
        !Number.isInteger(input.expiresSec) ||
        input.expiresSec < 1 ||
        input.expiresSec > 600 ||
        !textValue(input.mime)
      )
        return BAD();
      if (!config.signer || closed) return OFF();
      const start = Math.floor(options.now().getTime() / 1000);
      const expiresAt = new Date((start + input.expiresSec) * 1000);
      const policy = JSON.stringify({
        expiration: expiresAt.toISOString(),
        conditions: [
          { "q-sign-algorithm": "sha1" },
          { "q-ak": config.signer.secretId },
          { "q-sign-time": `${start};${start + input.expiresSec}` },
          { bucket: config.buckets[input.bucket] },
          { key: input.key },
          { "Content-Type": input.mime },
          ["content-length-range", 1, input.maxBytes],
        ],
      });
      return ok({
        url: `https://${host(input.bucket)}/`,
        fields: {
          key: input.key,
          "Content-Type": input.mime,
          ...cosPostPolicy(config.signer, policy, start, start + input.expiresSec),
        },
        key: input.key,
        expiresAt,
      });
    },
    issueSts: (input) =>
      run(async () => {
        if (
          !validRef({ bucket: input.bucket, key: input.keyPrefix }) ||
          !/^incoming\/[a-z0-9-]+\/$/.test(input.keyPrefix) ||
          !Number.isInteger(input.durationSec) ||
          input.durationSec < 1 ||
          input.durationSec > 1800
        )
          return BAD();
        return grant(input.bucket, input.keyPrefix, input.durationSec);
      }),
    head: (input) =>
      run<ObjectHead>(async () => {
        if (!validRef(input)) return BAD();
        const reply = await signed(
          input,
          "HEAD",
          readKey,
          {},
          {},
          undefined,
          undefined,
          undefined,
          input.signal,
        );
        if (reply.status === 404) return ok({ exists: false, size: 0 });
        if (reply.status !== 200) return failure(reply);
        const length = reply.headers.get("content-length");
        const etag = reply.headers.get("etag");
        const crc64 = reply.headers.get("x-cos-hash-crc64ecma");
        const versionId = reply.headers.get("x-cos-version-id");
        if (versionId !== null && !/^[\x21-\x7e]{1,1024}$/.test(versionId)) return UNAVAILABLE();
        if (
          !length ||
          !/^[0-9]+$/.test(length) ||
          !Number.isSafeInteger(Number(length)) ||
          !etag ||
          !textValue(etag) ||
          (crc64 !== null &&
            (!/^[0-9]{1,20}$/.test(crc64) || BigInt(crc64) > 18446744073709551615n))
        )
          return UNAVAILABLE();
        return ok({
          exists: true,
          size: Number(length),
          etag,
          ...(reply.headers.get("content-type")
            ? { mime: reply.headers.get("content-type")! }
            : {}),
          ...(crc64 ? { crc64 } : {}),
          ...(versionId ? { versionId } : {}),
        });
      }),
    readPrefix: (input) =>
      run(async () => {
        if (
          !validRef(input) ||
          !Number.isInteger(input.bytes) ||
          input.bytes < 1 ||
          input.bytes > 4096 ||
          (input.ifMatchEtag !== undefined && !textValue(input.ifMatchEtag))
        )
          return BAD();
        const reply = await signed(
          input,
          "GET",
          readKey,
          {
            Range: `bytes=0-${input.bytes - 1}`,
            ...(input.ifMatchEtag ? { "If-Match": input.ifMatchEtag } : {}),
          },
          {},
          undefined,
          input.bytes,
        );
        if (reply.status !== 200 && reply.status !== 206) return failure(reply);
        if (input.ifMatchEtag && reply.headers.get("etag") !== input.ifMatchEtag)
          return failed("rejected", "COS 对象已变更");
        return ok(reply.bytes);
      }),
    readTo: (input) => run(() => transfer(input.signal, (signal) => readTo(input, signal))),
    putStream: (input) =>
      run(() =>
        transfer(input.signal, async (signal) => {
          if (
            !validRef(input) ||
            !validStreamWrite(input) ||
            input.key.startsWith(INCOMING_PREFIX) ||
            !textValue(input.contentType) ||
            input.ifAbsent !== true
          )
            return BAD();
          if (!config.worker) return OFF();
          let digest = "";
          for await (const _chunk of checkedStream(
            input.body(signal),
            input.size,
            signal,
            (value) => {
              digest = value;
            },
          )) {
            /* bounded actual hash */
          }
          if (digest !== input.sha256) return failed("rejected", "COS流实际hash不一致");
          const versioning = await signed(
            { bucket: input.bucket, key: "" },
            "GET",
            config.worker,
            {},
            { versioning: "" },
            undefined,
            undefined,
            undefined,
            signal,
          );
          if (
            versioning.status !== 200 ||
            !/^\s*(?:<\?xml[^?]*\?>\s*)?<VersioningConfiguration(?:\s+xmlns="[^"]*")?\s*(?:\/>|>\s*<\/VersioningConfiguration>)\s*$/.test(
              versioning.text,
            )
          )
            return failed("unsupported", "COS未确认该桶允许原子防覆盖");
          let sentDigest = "";
          const sourceController = new AbortController(),
            bodySignal = AbortSignal.any([signal, sourceController.signal]);
          const body = Readable.from(
            checkedStream(input.body(bodySignal), input.size, bodySignal, (value) => {
              if (value !== input.sha256) throw new Error("COS流内容已变更");
              sentDigest = value;
            }),
          );
          const abort = () => {
            sourceController.abort();
            body.destroy(new Error("COS流写入取消"));
          };
          signal.addEventListener("abort", abort, { once: true });
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
          try {
            const response = await streamFetch(
              input,
              "PUT",
              config.worker,
              {
                "Content-Type": input.contentType,
                "Content-Length": String(input.size),
                "x-cos-meta-lyx-sha256": input.sha256,
                "x-cos-meta-lyx-content-identity": input.contentIdentity,
                "x-cos-forbid-overwrite": "true",
              },
              signal,
              body,
            );
            reader = response.body?.getReader();
            const parts: Uint8Array[] = [];
            let length = 0;
            if (reader)
              while (true) {
                const chunk = await reader.read();
                if (chunk.done) break;
                length += chunk.value.byteLength;
                if (length > 64 * 1024) return UNAVAILABLE();
                parts.push(chunk.value);
              }
            const text = Buffer.concat(parts).toString("utf8");
            if (response.status === 409 && xmlField(text, "Code") === "FileAlreadyExists") {
              sourceController.abort();
              body.destroy();
              await finished(body).catch(() => undefined);
              const existing = await signed(
                input,
                "HEAD",
                config.worker,
                {},
                {},
                undefined,
                undefined,
                undefined,
                signal,
              );
              return existing.status === 200 &&
                existing.headers.get("content-length") === String(input.size) &&
                existing.headers.get("x-cos-meta-lyx-sha256") === input.sha256 &&
                existing.headers.get("x-cos-meta-lyx-content-identity") === input.contentIdentity &&
                existing.headers.get("etag")
                ? verifyReplay(input, existing.headers.get("etag")!, signal, readTo)
                : failed("rejected", "COS目标hash/归属不一致");
            }
            if (response.status === 200) await finished(body);
            if (response.status !== 200) return failure(response);
            return sentDigest === input.sha256 && response.headers.get("etag")
              ? ok({ etag: response.headers.get("etag")!, size: input.size })
              : UNAVAILABLE();
          } finally {
            signal.removeEventListener("abort", abort);
            sourceController.abort();
            await reader?.cancel().catch(() => undefined);
            reader?.releaseLock();
            body.destroy();
            await finished(body).catch(() => undefined);
          }
        }),
      ),
    putObject: (input) =>
      run(async () => {
        if (
          !validRef(input) ||
          input.key.startsWith(INCOMING_PREFIX) ||
          !textValue(input.contentType) ||
          !(input.body instanceof Uint8Array)
        )
          return BAD();
        if (!config.worker) return OFF();
        if (input.ifAbsent) {
          const versioning = await signed(
            { bucket: input.bucket, key: "" },
            "GET",
            config.worker,
            {},
            { versioning: "" },
          );
          if (
            versioning.status !== 200 ||
            !/^\s*(?:<\?xml[^?]*\?>\s*)?<VersioningConfiguration(?:\s+xmlns="[^"]*")?\s*(?:\/>|>\s*<\/VersioningConfiguration>)\s*$/.test(
              versioning.text,
            )
          )
            return failed("unsupported", "COS 未确认该桶允许原子防覆盖");
        }
        const digest = createHash("sha256").update(input.body).digest("hex");
        const headers = {
          "Content-Type": input.contentType,
          "x-cos-meta-lyx-sha256": digest,
          ...(input.contentDisposition ? { "Content-Disposition": input.contentDisposition } : {}),
          ...(input.contentIdentity
            ? { "x-cos-meta-lyx-content-identity": input.contentIdentity }
            : {}),
          ...(input.ifAbsent ? { "x-cos-forbid-overwrite": "true" } : {}),
        };
        const reply = await signed(
          input,
          "PUT",
          config.worker,
          headers,
          {},
          new Uint8Array(input.body),
        );
        if (
          reply.status === 409 &&
          xmlField(reply.text, "Code") === "FileAlreadyExists" &&
          input.ifAbsent &&
          input.contentIdentity
        ) {
          const existing = await signed(input, "HEAD", config.worker);
          if (
            existing.status === 200 &&
            existing.headers.get("x-cos-meta-lyx-sha256") === digest &&
            existing.headers.get("x-cos-meta-lyx-content-identity") === input.contentIdentity &&
            existing.headers.get("content-length") === String(input.body.byteLength) &&
            existing.headers.get("etag")
          )
            return ok({ etag: existing.headers.get("etag")!, size: input.body.byteLength });
          return failed("rejected", "正式区键已有不同内容或归属");
        }
        if (reply.status !== 200 || !reply.headers.get("etag")) return failure(reply);
        return ok({ etag: reply.headers.get("etag")!, size: input.body.byteLength });
      }),
    copy: (input) =>
      run(async () => {
        if (
          !validRef(input.src) ||
          !validRef(input.dst) ||
          !textValue(input.ifMatchEtag) ||
          !textValue(input.contentType)
        )
          return BAD();
        if (!config.worker) return OFF();
        const reply = await signed(
          input.dst,
          "PUT",
          config.worker,
          {
            "x-cos-copy-source": `${host(input.src.bucket)}${objectPath(input.src.key)}`,
            "x-cos-copy-source-if-match": input.ifMatchEtag,
            "x-cos-metadata-directive": "Replaced",
            "Content-Type": input.contentType,
            ...(input.contentDisposition
              ? { "Content-Disposition": input.contentDisposition }
              : {}),
          },
          {},
          undefined,
          undefined,
          undefined,
          input.signal,
        );
        if (reply.status !== 200) return failure(reply);
        const etag = xmlField(reply.text, "ETag");
        if (!etag || !textValue(etag) || /<Error>/u.test(reply.text)) return UNAVAILABLE();
        return ok({ etag });
      }),
    async presignGet(input) {
      if (
        !validRef(input) ||
        !Number.isInteger(input.expiresSec) ||
        input.expiresSec < 1 ||
        input.expiresSec > 3600 ||
        closed
      )
        return BAD();
      const start = Math.floor(options.now().getTime() / 1000);
      const disposition = input.downloadName
        ? `${input.disposition ?? "attachment"}; filename*=UTF-8''${cosEncode(input.downloadName)}`
        : input.disposition;
      const query: Record<string, string> = disposition
        ? { "response-content-disposition": disposition }
        : {};
      const auth = cosAuthorization({
        key: readKey,
        method: "GET",
        pathname: `/${input.key}`,
        query,
        headers: { host: host(input.bucket) },
        start,
        end: start + input.expiresSec,
      });
      const params = new URLSearchParams(query);
      for (const [key, value] of new URLSearchParams(auth)) params.set(key, value);
      return ok({
        url: `https://${host(input.bucket)}${objectPath(input.key)}?${params}`,
        expiresAt: new Date((start + input.expiresSec) * 1000),
      });
    },
    delete: (input) =>
      run(async () => {
        if (!validRef(input)) return BAD();
        if (!config.worker) return OFF();
        const reply = await signed(input, "DELETE", config.worker);
        return reply.status === 204 || reply.status === 200 || reply.status === 404
          ? ok(undefined)
          : failure(reply);
      }),
    abortMultipart: (input) =>
      run(async () => {
        if (!validRef(input) || !/^incoming\/[a-z0-9-]+\/[a-z0-9.-]+$/.test(input.key))
          return BAD();
        const deadline = Date.now() + 10_000;
        const credential = await grant(input.bucket, input.key, 300, true, deadline);
        if (!credential.ok) return credential;
        const key = {
          secretId: credential.value.accessKeyId,
          secretKey: credential.value.secretAccessKey,
        };
        let marker = "";
        let uploadMarker = "";
        for (let page = 0; page < 10; page++) {
          const query = {
            uploads: "",
            prefix: input.key,
            "max-uploads": "100",
            ...(marker ? { "key-marker": marker, "upload-id-marker": uploadMarker } : {}),
          };
          const reply = await signed(
            { ...input, key: "" },
            "GET",
            key,
            { "x-cos-security-token": credential.value.sessionToken },
            query,
            undefined,
            undefined,
            deadline,
          );
          if (reply.status !== 200) return failure(reply);
          const uploads = [...reply.text.matchAll(/<Upload>([\s\S]*?)<\/Upload>/g)];
          if (uploads.length > 100) return UNAVAILABLE();
          for (const upload of uploads) {
            if (xmlField(upload[1]!, "Key") !== input.key) continue;
            const uploadId = xmlField(upload[1]!, "UploadId");
            if (!uploadId || !/^[A-Za-z0-9_-]{1,512}$/.test(uploadId)) return UNAVAILABLE();
            const aborted = await signed(
              input,
              "DELETE",
              key,
              { "x-cos-security-token": credential.value.sessionToken },
              { uploadId },
              undefined,
              undefined,
              deadline,
            );
            if (![200, 204, 404].includes(aborted.status)) return failure(aborted);
          }
          if (xmlField(reply.text, "IsTruncated") === "false") return ok(undefined);
          const next = xmlField(reply.text, "NextKeyMarker");
          const nextUpload = xmlField(reply.text, "NextUploadIdMarker");
          if (
            !next ||
            !nextUpload ||
            next !== input.key ||
            (next === marker && nextUpload === uploadMarker)
          )
            return UNAVAILABLE();
          marker = next;
          uploadMarker = nextUpload;
        }
        return UNAVAILABLE();
      }),
  };
}
