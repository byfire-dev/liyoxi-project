// 假存储：对象放在内存里，不依赖 MinIO。行为照本地 MinIO 驱动：直传只能落在写入区、
// 复制要对上 etag、读地址有时限。到期与否按替身的时钟判，拨动时钟就能测过期。
// 直传与读取没有真的 HTTP：用 upload() 与 fetch() 代替，返回的是状态码。

import { createHash } from "node:crypto";

import { failed, INCOMING_PREFIX, ok } from "../../providers/types.js";
import type {
  ObjectHead,
  ObjectRef,
  PresignedPost,
  ProviderMethodName,
  ProviderResult,
  StorageBucket,
  StorageProvider,
  BackupTarget,
} from "../../providers/types.js";
import { backupObjectKey, createBackupStorage, validBackupTarget } from "../../providers/index.js";
import type { BackupTransport } from "../../providers/index.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl } from "./base.js";

type Method = ProviderMethodName<StorageProvider>;

export interface FakeStoredObject {
  body: Uint8Array;
  mime: string;
  etag: string;
  contentDisposition?: string;
  contentIdentity?: string;
}

export type FakeFetchResult =
  | { status: 200; body: Uint8Array; mime: string; contentDisposition?: string }
  | { status: 403 | 404 };

export interface FakeStorage extends StorageProvider, FakeControl<Method> {
  /** 可以改：把 sts 置为 false，issueSts 就返回 unsupported（本地 MinIO 的样子） */
  capabilities: { sts: boolean; versioning: boolean };
  /** 全部对象，键是 “桶/对象键” */
  readonly objects: Map<string, FakeStoredObject>;
  /** 仅显式 backup 配置启用；独立物理目标，永不混进四个业务桶对象。 */
  readonly backupObjects: Map<string, FakeStoredObject>;
  /** 不经签名直接放一个对象（造数据用），返回 etag */
  put(ref: ObjectRef, body: Uint8Array, mime: string): string;
  /** 照预签名表单直传。返回状态码：204 成功；400 超过大小；403 表单过期、被改过或不是本替身签的 */
  upload(post: PresignedPost, body: Uint8Array): 204 | 400 | 403;
  /** 照读地址取对象：200 带内容；403 过期或不是本替身签的；404 对象不存在 */
  fetch(url: string): FakeFetchResult;
}

const ORIGIN = "https://fake-storage.invalid";

function etagOf(body: Uint8Array): string {
  return `"${createHash("sha256").update(body).digest("hex").slice(0, 32)}"`;
}

const slot = (ref: ObjectRef) => `${ref.bucket}/${ref.key}`;
const boundedSize = (n: number) => Number.isSafeInteger(n) && n > 0 && n <= 2 * 1024 ** 3;

export function createFakeStorage(
  options: { clock?: FakeClock; backup?: BackupTarget } = {},
): FakeStorage {
  const clock = options.clock ?? systemClock;
  const core = createFakeCore<Method>(clock);
  const objects = new Map<string, FakeStoredObject>();
  const backupObjects = new Map<string, FakeStoredObject>();
  const backupUploads = new Map<string, { key: string; parts: Uint8Array[] }>();
  const backupBuckets = {
    secure: "test-secure-1250000000",
    asset: "test-asset-1250000000",
    media: "test-media-1250000000",
    pub: "test-pub-1250000000",
  };
  if (options.backup && !validBackupTarget(options.backup, backupBuckets))
    throw new TypeError("替身备份目标配置不合法");
  const backupSlot = (key: string) =>
    `${options.backup!.bucket}/${backupObjectKey(options.backup!, key)}`;
  const backupTransport: BackupTransport | undefined = options.backup
    ? {
        async begin(key, signal) {
          signal.throwIfAborted();
          const uploadId = nextToken("backup");
          backupUploads.set(uploadId, { key, parts: [] });
          return { uploadId };
        },
        async part(input) {
          input.signal.throwIfAborted();
          const upload = backupUploads.get(input.uploadId);
          if (!upload || upload.key !== input.key || upload.parts.length + 1 !== input.partNumber)
            throw new Error("替身备份分块归属不一致");
          upload.parts.push(new Uint8Array(input.body));
          return { etag: etagOf(input.body) };
        },
        async complete(input) {
          input.signal.throwIfAborted();
          const upload = backupUploads.get(input.uploadId);
          if (
            !upload ||
            upload.key !== input.key ||
            input.parts.length !== upload.parts.length ||
            input.parts.some(
              (part, index) =>
                part.partNumber !== index + 1 || part.etag !== etagOf(upload.parts[index]!),
            )
          )
            throw new Error("替身备份完成归属不一致");
          // 仅内存替身保存完整虚构字节；生产 transport 始终只持一个 5MiB part。
          const body = new Uint8Array(upload.parts.reduce((sum, part) => sum + part.length, 0));
          let offset = 0;
          for (const part of upload.parts) {
            body.set(part, offset);
            offset += part.length;
          }
          const etag = etagOf(body);
          backupObjects.set(backupSlot(input.key), {
            body,
            etag,
            mime: "application/octet-stream",
          });
          backupUploads.delete(input.uploadId);
          return { etag };
        },
        async abort(input) {
          input.signal.throwIfAborted();
          const upload = backupUploads.get(input.uploadId);
          if (upload && upload.key === input.key) backupUploads.delete(input.uploadId);
        },
        async head(input) {
          input.signal.throwIfAborted();
          const object = backupObjects.get(backupSlot(input.key));
          if (!object) return { exists: false, size: 0 };
          return { exists: true, size: object.body.length, etag: object.etag };
        },
        async copy(input) {
          input.signal.throwIfAborted();
          const source = backupObjects.get(backupSlot(input.srcKey));
          if (!source || source.etag !== input.ifMatchEtag) throw new Error("替身备份源etag不一致");
          const body = new Uint8Array(source.body),
            etag = etagOf(body);
          backupObjects.set(backupSlot(input.dstKey), { body, etag, mime: source.mime });
          return { etag };
        },
      }
    : undefined;
  const backup = createBackupStorage(backupTransport);
  const versions = new Map<string, FakeStoredObject[]>();
  const posts = new Map<
    string,
    { bucket: StorageBucket; key: string; mime: string; maxBytes: number; expiresAt: Date }
  >();
  const reads = new Map<
    string,
    {
      ref: ObjectRef;
      expiresAt: Date;
      downloadName?: string;
      disposition?: "inline" | "attachment";
    }
  >();
  let seq = 0;
  const nextToken = (prefix: string) => `${prefix}-${(seq += 1)}`;
  const expiry = (seconds: number) => new Date(clock.now().getTime() + seconds * 1000);
  const expired = (at: Date) => clock.now().getTime() > at.getTime();

  async function streamRun<T>(
    method: "readTo" | "putStream" | "putBackupStream" | "headBackup" | "copyBackup",
    input: unknown,
    signal: AbortSignal,
    action: () => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    let running: Promise<ProviderResult<T>> | undefined;
    try {
      return await core.run(
        method,
        input,
        () => {
          running = action();
          return running;
        },
        signal,
      );
    } finally {
      // A canceled fake response must not outlive the source/sink's actual finally cleanup.
      if (running) await running.catch(() => {});
    }
  }

  function put(ref: ObjectRef, body: Uint8Array, mime: string): string {
    const previous = objects.get(slot(ref));
    if (fake.capabilities.versioning && previous)
      versions.set(slot(ref), [...(versions.get(slot(ref)) ?? []), previous]);
    const stored = { body: new Uint8Array(body), mime, etag: etagOf(body) };
    objects.set(slot(ref), stored);
    return stored.etag;
  }

  const fake: FakeStorage = {
    status: "fake",
    configured: true,
    backupObjects,
    putBackupStream: (input) =>
      streamRun("putBackupStream", input, input.signal, () => backup.putBackupStream(input)),
    headBackup: (input) =>
      streamRun("headBackup", input, input.signal, () => backup.headBackup(input)),
    copyBackup: (input) =>
      streamRun("copyBackup", input, input.signal, () => backup.copyBackup(input)),
    capabilities: { sts: true, versioning: false },
    uploadLocation: {
      region: "ap-test-1",
      buckets: {
        secure: "test-secure-1250000000",
        asset: "test-asset-1250000000",
        media: "test-media-1250000000",
        pub: "test-pub-1250000000",
      },
    },
    ...core.control,
    objects,
    put,

    upload(post, body) {
      const policy = posts.get(post.fields.policy ?? "");
      if (!policy || expired(policy.expiresAt)) return 403;
      if (post.fields.key !== policy.key || post.fields["Content-Type"] !== policy.mime) return 403;
      if (body.byteLength > policy.maxBytes) return 400;
      put({ bucket: policy.bucket, key: policy.key }, body, policy.mime);
      return 204;
    },

    fetch(url) {
      const grant = reads.get(new URL(url).searchParams.get("token") ?? "");
      if (!grant || expired(grant.expiresAt)) return { status: 403 };
      const stored = objects.get(slot(grant.ref));
      if (!stored) return { status: 404 };
      const contentDisposition =
        grant.downloadName === undefined
          ? (grant.disposition ?? stored.contentDisposition)
          : `${grant.disposition ?? "attachment"}; filename*=UTF-8''${encodeURIComponent(grant.downloadName)}`;
      return {
        status: 200,
        body: new Uint8Array(stored.body),
        mime: stored.mime,
        contentDisposition,
      };
    },

    presignPost: (input) =>
      core.run("presignPost", input, () => {
        if (!input.key.startsWith(INCOMING_PREFIX)) {
          return failed("rejected", `直传只能写到写入区：键要以 ${INCOMING_PREFIX} 开头`);
        }
        const token = nextToken("fake-post");
        const expiresAt = expiry(input.expiresSec);
        posts.set(token, { ...input, expiresAt });
        return ok({
          url: `${ORIGIN}/${input.bucket}`,
          fields: { key: input.key, "Content-Type": input.mime, policy: token },
          key: input.key,
          expiresAt,
        });
      }),

    issueSts: (input) =>
      core.run("issueSts", input, () => {
        if (!fake.capabilities.sts) return failed("unsupported", "替身的临时密钥能力已关掉");
        const token = nextToken("fake-sts");
        return ok({
          accessKeyId: `${token}-id`,
          secretAccessKey: `${token}-secret`,
          sessionToken: `${token}-session`,
          expiresAt: expiry(input.durationSec),
          startTime: clock.now(),
        });
      }),

    head: (input) =>
      core.run(
        "head",
        input,
        (): ProviderResult<ObjectHead> => {
          const stored = objects.get(slot(input));
          if (!stored) return ok({ exists: false, size: 0 });
          return ok({
            exists: true,
            size: stored.body.byteLength,
            mime: stored.mime,
            etag: stored.etag,
          });
        },
        input.signal,
      ),

    readPrefix: (input) =>
      core.run("readPrefix", input, () => {
        if (!Number.isInteger(input.bytes) || input.bytes < 1 || input.bytes > 4096)
          return failed("rejected", "文件头读取只允许 1–4096 字节");
        const stored = objects.get(slot(input));
        if (!stored || (input.ifMatchEtag !== undefined && stored.etag !== input.ifMatchEtag))
          return failed("rejected", "源对象不存在或 etag 对不上");
        return ok(stored.body.slice(0, input.bytes));
      }),
    readObject: (input) =>
      core.run("readObject", input, () => {
        if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1)
          return failed("rejected", "完整对象读取上限必须是有限正整数");
        if (input.signal?.aborted) return failed("rejected", "对象读取已取消");
        const stored = objects.get(slot(input));
        if (!stored || (input.ifMatchEtag !== undefined && stored.etag !== input.ifMatchEtag))
          return failed("rejected", "源对象不存在或 etag 对不上");
        if (stored.body.byteLength > input.maxBytes)
          return failed("rejected", "对象大小超过读取上限");
        return ok(new Uint8Array(stored.body));
      }),
    putObject: (input) =>
      core.run("putObject", input, () => {
        const existing = objects.get(slot(input));
        if (input.ifAbsent && existing) {
          if (
            !input.contentIdentity ||
            existing.contentIdentity !== input.contentIdentity ||
            createHash("sha256").update(existing.body).digest("hex") !==
              createHash("sha256").update(input.body).digest("hex")
          )
            return failed("rejected", "正式区键已有不同内容或归属的系统文件");
          return ok({ etag: existing.etag, size: existing.body.byteLength });
        }
        const etag = put(input, input.body, input.contentType);
        const stored = objects.get(slot(input));
        if (stored) {
          stored.contentDisposition = input.contentDisposition;
          stored.contentIdentity = input.contentIdentity;
        }
        return ok({ etag, size: input.body.byteLength });
      }),

    copy: (input) =>
      core.run(
        "copy",
        input,
        () => {
          const source = objects.get(slot(input.src));
          if (!source) return failed("rejected", "源对象不存在");
          if (source.etag !== input.ifMatchEtag) return failed("rejected", "源对象的 etag 对不上");
          objects.set(slot(input.dst), {
            body: new Uint8Array(source.body),
            mime: input.contentType,
            etag: source.etag,
            contentDisposition: input.contentDisposition,
          });
          return ok({ etag: source.etag });
        },
        input.signal,
      ),

    presignGet: (input) =>
      core.run("presignGet", input, () => {
        const token = nextToken("fake-read");
        const expiresAt = expiry(input.expiresSec);
        reads.set(token, {
          ref: { bucket: input.bucket, key: input.key },
          expiresAt,
          downloadName: input.downloadName,
          disposition: input.disposition,
        });
        const path = input.key.split("/").map(encodeURIComponent).join("/");
        return ok({ url: `${ORIGIN}/${input.bucket}/${path}?token=${token}`, expiresAt });
      }),

    presignVisionGet: (input) =>
      core.run("presignVisionGet", input, () =>
        failed("unsupported", "替身不提供真实视觉处理签名"),
      ),
    delete: (input) =>
      core.run(
        "delete",
        input,
        () => {
          const previous = objects.get(slot(input));
          if (fake.capabilities.versioning && previous)
            versions.set(slot(input), [...(versions.get(slot(input)) ?? []), previous]);
          objects.delete(slot(input));
          return ok(undefined);
        },
        input.signal,
      ),
    restoreVersions: (input) =>
      core.run(
        "restoreVersions",
        input,
        () => {
          if (!fake.capabilities.versioning) return failed("unsupported", "替身桶未启用版本控制");
          if (objects.has(slot(input))) return ok(undefined);
          const previous = versions.get(slot(input))?.at(-1);
          if (!previous) return failed("rejected", "替身对象已无可恢复版本");
          objects.set(slot(input), previous);
          return ok(undefined);
        },
        input.signal,
      ),
    eraseVersions: (input) =>
      core.run(
        "eraseVersions",
        input,
        () => {
          objects.delete(slot(input));
          versions.delete(slot(input));
          return ok(undefined);
        },
        input.signal,
      ),
    abortMultipart: (input) =>
      core.run("abortMultipart", input, () =>
        input.key.startsWith(INCOMING_PREFIX)
          ? ok(undefined)
          : failed("rejected", "中止分块只允许写入区对象"),
      ),
    readTo: (input) =>
      streamRun("readTo", input, input.signal, async () => {
        const stored = objects.get(slot(input));
        if (
          !boundedSize(input.expectedSize) ||
          !boundedSize(input.maxBytes) ||
          input.expectedSize > input.maxBytes ||
          !stored ||
          stored.etag !== input.ifMatchEtag ||
          stored.body.byteLength !== input.expectedSize
        )
          return failed("rejected", "替身对象流与预期不一致");
        for (let i = 0; i < stored.body.length; i += 64 * 1024) {
          if (input.signal.aborted) return failed("unavailable", "替身对象流已取消");
          await input.sink(stored.body.subarray(i, i + 64 * 1024));
        }
        return ok({
          size: stored.body.length,
          sha256: createHash("sha256").update(stored.body).digest("hex"),
        });
      }),
    putStream: (input) =>
      streamRun("putStream", input, input.signal, async () => {
        if (
          !boundedSize(input.size) ||
          !/^[a-f0-9]{64}$/.test(input.sha256) ||
          !/^[a-f0-9]{64}$/.test(input.contentIdentity) ||
          input.ifAbsent !== true ||
          input.key.startsWith(INCOMING_PREFIX)
        )
          return failed("rejected", "替身对象流参数不合格");
        const parts: Uint8Array[] = [],
          hash = createHash("sha256");
        let length = 0;
        for await (const part of input.body(input.signal)) {
          if (input.signal.aborted) return failed("unavailable", "替身对象流已取消");
          if (
            !(part instanceof Uint8Array) ||
            part.byteLength > 1024 ** 2 ||
            length + part.byteLength > input.size
          )
            return failed("rejected", "替身对象流超限");
          length += part.byteLength;
          hash.update(part);
          parts.push(new Uint8Array(part));
        }
        const digest = hash.digest("hex");
        if (input.signal.aborted || length !== input.size)
          return failed("rejected", "替身对象流长度不一致");
        if (digest !== input.sha256) return failed("rejected", "替身对象流hash不一致");
        const existing = objects.get(slot(input));
        if (existing)
          return existing.contentIdentity === input.contentIdentity &&
            existing.body.byteLength === input.size &&
            createHash("sha256").update(existing.body).digest("hex") === input.sha256
            ? ok({ etag: existing.etag, size: input.size })
            : failed("rejected", "替身目标归属不一致");
        const body = new Uint8Array(input.size);
        let offset = 0;
        for (const part of parts) {
          body.set(part, offset);
          offset += part.length;
        }
        const etag = put(input, body, input.contentType);
        objects.get(slot(input))!.contentIdentity = input.contentIdentity;
        return ok({ etag, size: input.size });
      }),
  };
  return fake;
}
