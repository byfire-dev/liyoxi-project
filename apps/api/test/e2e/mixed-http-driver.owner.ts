import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { createM1Support, M1OwnerNetworkSchema } from "@liyoxi/services/testing";
import type { M1Support } from "@liyoxi/services/testing";
import { z } from "@liyoxi/contract";
import {
  assertMixedSource,
  mixedStorage,
  MixedFailure,
  MixedSource,
  MIXED_PROTOCOL,
} from "./mixed-http-driver.protocol.js";

const Init = z.strictObject({
  source: MixedSource,
  runId: z.string().regex(/^[a-z0-9]{1,12}$/),
  ownerNetwork: M1OwnerNetworkSchema,
});
const absent = (error: unknown) =>
  error instanceof Error && ["NotFound", "NoSuchBucket"].includes(error.name);

export function createMixedOwner(
  source: string,
  signal: AbortSignal,
  diagnosticWrite: (line: string) => void,
) {
  let support: M1Support | undefined, io: S3Client | undefined;
  let started = false,
    closing: Promise<unknown> | undefined;
  const buckets: string[] = [];
  const close = () =>
    (closing ??= (async () => {
      const failures: unknown[] = [];
      const cleanup = async (action: () => unknown) => {
        try {
          await action();
        } catch (error) {
          failures.push(error);
        }
      };
      const cleanupSignal = AbortSignal.timeout(30_000);
      for (const bucket of buckets) {
        await cleanup(async () => {
          let continuation: string | undefined;
          for (let page = 0; page < 16; page++) {
            let listed;
            try {
              listed = await io!.send(
                new ListObjectsV2Command({
                  Bucket: bucket,
                  MaxKeys: 250,
                  ...(continuation ? { ContinuationToken: continuation } : {}),
                }),
                { abortSignal: cleanupSignal },
              );
            } catch (error) {
              if (absent(error)) return;
              throw error;
            }
            const objects = (listed.Contents ?? []).map((row) => {
              if (!row.Key) throw new MixedFailure("cleanup_failed");
              return { Key: row.Key };
            });
            if (objects.length) {
              const removed = await io!.send(
                new DeleteObjectsCommand({
                  Bucket: bucket,
                  Delete: { Objects: objects },
                }),
                { abortSignal: cleanupSignal },
              );
              if (removed.Errors?.length) throw new MixedFailure("cleanup_failed");
            }
            if (listed.IsTruncated === false) return;
            if (listed.IsTruncated !== true || !listed.NextContinuationToken)
              throw new MixedFailure("cleanup_failed");
            continuation = listed.NextContinuationToken;
          }
          throw new MixedFailure("cleanup_failed");
        });
        await cleanup(async () => {
          try {
            await io!.send(new DeleteBucketCommand({ Bucket: bucket }), {
              abortSignal: cleanupSignal,
            });
          } catch (error) {
            if (!absent(error)) throw error;
          }
        });
        await cleanup(async () => {
          try {
            await io!.send(new HeadBucketCommand({ Bucket: bucket }), {
              abortSignal: cleanupSignal,
            });
          } catch (error) {
            if (absent(error)) return;
            throw error;
          }
          throw new MixedFailure("cleanup_failed");
        });
      }
      await cleanup(() => support?.close()); // ownerNetwork close verifies own DB/prefix absence.
      await cleanup(() => io?.destroy());
      if (failures.length) throw new MixedFailure("cleanup_failed");
      return { closed: true, scopeAbsenceVerified: Boolean(support), bucketsAbsent: true };
    })());
  return {
    close,
    async init(raw: unknown) {
      if (started || closing || process.env.APP_ENV !== "test")
        throw new MixedFailure("invalid_state");
      const input = Init.parse(raw);
      assertMixedSource(input.source, source);
      assertMixedSource(input.ownerNetwork.expected.source, source);
      started = true;
      signal.throwIfAborted();
      support = await createM1Support({
        runId: input.runId,
        ownerNetwork: input.ownerNetwork,
        signal,
        diagnosticWrite,
      });
      const scope = support.sharedScope(),
        storage = mixedStorage(scope.runId);
      io = new S3Client({
        endpoint: storage.endpoint,
        region: storage.region,
        forcePathStyle: true,
        credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey },
      });
      for (const bucket of Object.values(storage.buckets)) {
        signal.throwIfAborted();
        try {
          await io.send(new HeadBucketCommand({ Bucket: bucket }), {
            abortSignal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          });
        } catch (error) {
          if (!absent(error)) throw error;
          // Exact fresh name, already proven absent; cleanup also handles unknown create outcomes.
          buckets.push(bucket);
          await io.send(new CreateBucketCommand({ Bucket: bucket }), {
            abortSignal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
          });
          continue;
        }
        throw new MixedFailure("start_failed"); // never adopt an existing bucket
      }
      return { protocol: MIXED_PROTOCOL, source, pid: process.pid, attachBase: { scope, storage } };
    },
  };
}
