import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import type { S3Client } from "@aws-sdk/client-s3";
import { failed } from "../types.js";
import type { BackupTarget, StorageBucket } from "../types.js";
import {
  backupObjectKey,
  BackupStorageError,
  createBackupStorage,
  validBackupTarget,
} from "./backup-stream.js";
import type { BackupTransport } from "./backup-stream.js";

const status = (error: unknown): number | undefined => {
  if (!error || typeof error !== "object" || !("$metadata" in error)) return undefined;
  const metadata = error.$metadata;
  return metadata &&
    typeof metadata === "object" &&
    "httpStatusCode" in metadata &&
    typeof metadata.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : undefined;
};
/** 借用原 transferClient；不创建客户端/备份桶，关闭在途由 MinIO 原生命周期负责。 */
export function createMinioBackup(
  input: {
    readonly backup?: BackupTarget;
    readonly buckets: Readonly<Record<StorageBucket, string>>;
  },
  client: S3Client,
) {
  const target = input.backup;
  if (!target) return createBackupStorage();
  if (!validBackupTarget(target, input.buckets)) {
    const rejected = async () => failed("rejected", "备份目标配置不合法");
    return { putBackupStream: rejected, headBackup: rejected, copyBackup: rejected };
  }
  const object = (key: string) => ({ Bucket: target.bucket, Key: backupObjectKey(target, key) });
  const protocol = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new BackupStorageError(
        [409, 412].includes(status(error) ?? 0) ? "rejected" : "unavailable",
      );
    }
  };
  const transport: BackupTransport = {
    begin: (key, signal) =>
      protocol(async () => {
        const result = await client.send(
          new CreateMultipartUploadCommand({
            ...object(key),
            ContentType: "application/octet-stream",
          }),
          { abortSignal: signal },
        );
        if (!result.UploadId) throw new BackupStorageError();
        return { uploadId: result.UploadId };
      }),
    part: (input) =>
      protocol(async () => {
        const result = await client.send(
          new UploadPartCommand({
            ...object(input.key),
            UploadId: input.uploadId,
            PartNumber: input.partNumber,
            Body: input.body,
            ContentLength: input.body.length,
          }),
          { abortSignal: input.signal },
        );
        if (!result.ETag) throw new BackupStorageError();
        return { etag: result.ETag };
      }),
    complete: (input) =>
      protocol(async () => {
        const result = await client.send(
          new CompleteMultipartUploadCommand({
            ...object(input.key),
            UploadId: input.uploadId,
            MultipartUpload: {
              Parts: input.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
            },
          }),
          { abortSignal: input.signal },
        );
        if (!result.ETag) throw new BackupStorageError();
        return { etag: result.ETag };
      }),
    abort: (input) =>
      protocol(async () => {
        await client.send(
          new AbortMultipartUploadCommand({ ...object(input.key), UploadId: input.uploadId }),
          { abortSignal: input.signal },
        );
      }),
    head: async (input) => {
      try {
        const result = await client.send(
          new HeadObjectCommand({ ...object(input.key), IfMatch: input.ifMatchEtag }),
          { abortSignal: input.signal },
        );
        if (result.ContentLength === undefined || !result.ETag) throw new BackupStorageError();
        return {
          exists: true,
          size: result.ContentLength,
          etag: result.ETag,
          ...(result.Metadata?.sha256 ? { sha256: result.Metadata.sha256 } : {}),
        };
      } catch (error) {
        if (status(error) === 404) return { exists: false, size: 0 };
        throw new BackupStorageError(status(error) === 412 ? "rejected" : "unavailable");
      }
    },
    copy: (input) =>
      protocol(async () => {
        const key = backupObjectKey(target, input.srcKey)
          .split("/")
          .map(encodeURIComponent)
          .join("/");
        const result = await client.send(
          new CopyObjectCommand({
            ...object(input.dstKey),
            CopySource: `${target.bucket}/${key}`,
            CopySourceIfMatch: input.ifMatchEtag,
            MetadataDirective: "COPY",
          }),
          { abortSignal: input.signal },
        );
        if (!result.CopyObjectResult?.ETag) throw new BackupStorageError();
        return { etag: result.CopyObjectResult.ETag };
      }),
  };
  return createBackupStorage(transport);
}
