// 本地 MinIO 驱动：S3 兼容，只限 local、test（01 第 9 节“未配置时：本地用 MinIO 走小文件通道”）。
//
// 只提供存储原语（03 第 5.2 节）：预签名表单直传到写入区 incoming/、读对象头、条件复制到正式区、
// 签发读地址、删除。文件登记、入库、引用不在这里（W1-07）。没有临时密钥、没有版本控制：
// 分块上传、续传在 MinIO 上测不到，真实驱动在 G3-A。
// 四个桶在第一次用到时建好（已有的不动），所以工厂构建时不连网：MinIO 没起来也不影响启动，
// 调用时返回 unavailable。
// AWS SDK 只在本文件引入（任务书 第 11 节第 2 项）。

import { createHash } from "node:crypto";
import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { failed, INCOMING_PREFIX, ok, STORAGE_BUCKETS } from "../types.js";
import type {
  ObjectHead,
  ProviderFailure,
  ProviderResult,
  StorageBucket,
  StorageProvider,
} from "../types.js";

export interface MinioConfig {
  /** 服务端读写用的内部地址 */
  endpoint: string;
  /** 客户端直传和签读用的地址；不配时沿用 endpoint */
  publicEndpoint?: string;
  region: string;
  accessKey: string;
  secretKey: string;
  /** 四个桶各自的桶名 */
  buckets: Readonly<Record<StorageBucket, string>>;
}

/**
 * 本地那套共享容器的连接参数（infra/compose/local.yml）。账号与口令是固定的开发值，只对本机这套容器有效，
 * 不是密钥；与 compose 文件是否一致由 minio.test.ts 核对。桶名按任务书 第 11 节第 4 项。
 */
export const LOCAL_MINIO: MinioConfig = {
  endpoint: "http://127.0.0.1:9100",
  region: "us-east-1",
  accessKey: "liyoxi",
  secretKey: "lyx-local-dev",
  buckets: {
    secure: "lyx-local-secure",
    asset: "lyx-local-asset",
    media: "lyx-local-media",
    pub: "lyx-local-pub",
  },
};

export interface MinioStorage extends StorageProvider {
  /** 建四个桶，已有的不动。各方法第一次用到时会自己调；露出来给初始化脚本与用例用 */
  ensureBuckets(): Promise<ProviderResult<{ created: StorageBucket[] }>>;
  /** 关掉连接 */
  close(): void;
}

function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) return undefined;
  const metadata = (error as { $metadata?: { httpStatusCode?: number } }).$metadata;
  return metadata?.httpStatusCode;
}

/** 只带错误的名字，不带它的 message：message 里可能有地址 */
function toFailure(error: unknown, what: string): ProviderFailure {
  const status = httpStatusOf(error);
  const name = error instanceof Error ? error.name : "UnknownError";
  if (status !== undefined && status >= 400 && status < 500) {
    return failed("rejected", `${what}被本地 MinIO 拒绝（${status} ${name}）`);
  }
  return failed(
    "unavailable",
    `${what}没办成：本地 MinIO 连不上或出错（${name}）。先跑 pnpm infra:up`,
  );
}

/** 键按段转义后拼成复制源；斜杠保留 */
function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export function createMinioStorage(config: MinioConfig = LOCAL_MINIO): MinioStorage {
  // 凡是 SDK 会去环境变量与 ~/.aws 下的文件里找缺省值的选项，这里都写明，SDK 就不会去读那些文件
  const createClient = (endpoint: string) =>
    new S3Client({
      endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKey, secretAccessKey: config.secretKey },
      defaultsMode: "standard",
      authSchemePreference: [],
      maxAttempts: 2,
      retryMode: "standard",
      requestHandler: { connectionTimeout: 2_000, requestTimeout: 10_000 },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      disableS3ExpressSessionAuth: true,
      disableClockSkewCorrection: false,
      sigv4aSigningRegionSet: [],
      useArnRegion: false,
      useDualstackEndpoint: false,
      useFipsEndpoint: false,
      userAgentAppId: "lyx-local",
    });
  const client = createClient(config.endpoint);
  // GET 的 Host 参与验签，必须用对外地址签发，不能在签发后改 URL。
  const signingClient =
    config.publicEndpoint && config.publicEndpoint !== config.endpoint
      ? createClient(config.publicEndpoint)
      : client;
  const nameOf = (bucket: StorageBucket) => config.buckets[bucket];

  async function createMissingBuckets(): Promise<ProviderResult<{ created: StorageBucket[] }>> {
    const created: StorageBucket[] = [];
    try {
      for (const bucket of STORAGE_BUCKETS) {
        try {
          await client.send(new HeadBucketCommand({ Bucket: nameOf(bucket) }));
          continue;
        } catch (error) {
          if (httpStatusOf(error) !== 404) throw error;
        }
        try {
          await client.send(new CreateBucketCommand({ Bucket: nameOf(bucket) }));
          created.push(bucket);
        } catch (error) {
          // 别的会话刚好同时建了它：409，算已有
          if (httpStatusOf(error) !== 409) throw error;
        }
      }
      return ok({ created });
    } catch (error) {
      return toFailure(error, "建桶");
    }
  }

  let ready: Promise<ProviderResult<{ created: StorageBucket[] }>> | null = null;
  /** 建桶只做一次；没建成的不记，下次调用再试 */
  function ensureBuckets(): Promise<ProviderResult<{ created: StorageBucket[] }>> {
    ready ??= createMissingBuckets().then((result) => {
      if (!result.ok) ready = null;
      return result;
    });
    return ready;
  }

  async function run<T>(
    what: string,
    action: () => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> {
    const prepared = await ensureBuckets();
    if (!prepared.ok) return prepared;
    try {
      return await action();
    } catch (error) {
      return toFailure(error, what);
    }
  }

  return {
    status: "local",
    configured: true,
    capabilities: { sts: false, versioning: false },
    ensureBuckets,
    close: () => {
      client.destroy();
      if (signingClient !== client) signingClient.destroy();
    },

    async presignPost({ bucket, key, mime, maxBytes, expiresSec }) {
      if (!key.startsWith(INCOMING_PREFIX)) {
        return failed("rejected", `直传只能写到写入区：键要以 ${INCOMING_PREFIX} 开头`);
      }
      return run("签发直传表单", async () => {
        const { url, fields } = await createPresignedPost(signingClient, {
          Bucket: nameOf(bucket),
          Key: key,
          Conditions: [
            ["content-length-range", 0, maxBytes],
            ["eq", "$Content-Type", mime],
          ],
          Fields: { "Content-Type": mime },
          Expires: expiresSec,
        });
        // 签名用的是系统时间，到期时刻也按系统时间给
        return ok({ url, fields, key, expiresAt: new Date(Date.now() + expiresSec * 1000) });
      });
    },

    async issueSts() {
      return failed("unsupported", "本地 MinIO 只走小文件通道，不签发临时密钥");
    },

    async head({ bucket, key }) {
      return run<ObjectHead>("读对象头", async () => {
        try {
          const head = await client.send(
            new HeadObjectCommand({ Bucket: nameOf(bucket), Key: key }),
          );
          return ok({
            exists: true,
            size: head.ContentLength ?? 0,
            mime: head.ContentType,
            etag: head.ETag,
          });
        } catch (error) {
          if (httpStatusOf(error) === 404) return ok({ exists: false, size: 0 });
          throw error;
        }
      });
    },

    async readPrefix({ bucket, key, bytes, ifMatchEtag }) {
      if (!Number.isInteger(bytes) || bytes < 1 || bytes > 4096)
        return failed("rejected", "文件头读取只允许 1–4096 字节");
      return run("读取文件头", async () => {
        const result = await client.send(
          new GetObjectCommand({
            Bucket: nameOf(bucket),
            Key: key,
            Range: `bytes=0-${bytes - 1}`,
            IfMatch: ifMatchEtag,
          }),
        );
        const body = await result.Body?.transformToByteArray();
        return body === undefined || body.byteLength > bytes
          ? failed("rejected", "文件头返回不合格")
          : ok(body);
      });
    },

    async putObject({
      bucket,
      key,
      body,
      contentType,
      contentDisposition,
      ifAbsent,
      contentIdentity,
    }) {
      return run("写入系统文件", async () => {
        const sha256 = createHash("sha256").update(body).digest("hex");
        try {
          const result = await client.send(
            new PutObjectCommand({
              Bucket: nameOf(bucket),
              Key: key,
              Body: body,
              ContentType: contentType,
              ContentDisposition: contentDisposition,
              IfNoneMatch: ifAbsent ? "*" : undefined,
              Metadata: {
                sha256,
                ...(contentIdentity ? { "content-identity": contentIdentity } : {}),
              },
            }),
          );
          return result.ETag
            ? ok({ etag: result.ETag, size: body.byteLength })
            : failed("rejected", "系统文件写入未返回 etag");
        } catch (error) {
          if (!ifAbsent || ![409, 412].includes(httpStatusOf(error) ?? 0)) throw error;
          const existing = await client.send(
            new HeadObjectCommand({ Bucket: nameOf(bucket), Key: key }),
          );
          // 原子条件写保住旧对象；只有同一完整字节与归属指纹才采纳崩溃前的已写对象。
          if (
            !contentIdentity ||
            existing.Metadata?.sha256 !== sha256 ||
            existing.Metadata["content-identity"] !== contentIdentity ||
            existing.ContentLength !== body.byteLength ||
            !existing.ETag
          )
            return failed("rejected", "正式区键已有不同内容或归属的系统文件");
          return ok({ etag: existing.ETag, size: existing.ContentLength });
        }
      });
    },

    async copy({ src, dst, ifMatchEtag, contentType, contentDisposition }) {
      return run("条件复制", async () => {
        const copied = await client.send(
          new CopyObjectCommand({
            Bucket: nameOf(dst.bucket),
            Key: dst.key,
            CopySource: `${nameOf(src.bucket)}/${encodeKey(src.key)}`,
            CopySourceIfMatch: ifMatchEtag,
            MetadataDirective: "REPLACE",
            ContentType: contentType,
            ContentDisposition: contentDisposition,
          }),
        );
        return ok({ etag: copied.CopyObjectResult?.ETag ?? "" });
      });
    },

    async presignGet({ bucket, key, expiresSec, downloadName, disposition: requestedDisposition }) {
      return run("签发读地址", async () => {
        const disposition =
          downloadName === undefined
            ? requestedDisposition
            : `${requestedDisposition ?? "attachment"}; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
        const url = await getSignedUrl(
          signingClient,
          new GetObjectCommand({
            Bucket: nameOf(bucket),
            Key: key,
            ResponseContentDisposition: disposition,
          }),
          { expiresIn: expiresSec },
        );
        return ok({ url, expiresAt: new Date(Date.now() + expiresSec * 1000) });
      });
    },

    async delete({ bucket, key }) {
      return run("删除", async () => {
        await client.send(new DeleteObjectCommand({ Bucket: nameOf(bucket), Key: key }));
        return ok(undefined);
      });
    },
  };
}
