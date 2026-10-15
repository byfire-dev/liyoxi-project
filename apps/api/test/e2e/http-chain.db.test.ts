// One complete selected-source HTTP chain; not the two-version four-step drill.
import { execFileSync } from "node:child_process";
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { expect, it, vi } from "vitest";
import { createM1RealClock, createM1Support } from "@liyoxi/services/testing";
import type { M1Attachment } from "@liyoxi/services/testing";
import { createM1HttpBridge } from "./http-bridge.js";

it("M1 完整七段经真实HTTP与本轮MinIO：二十集交付上线、正式运输及全量不变量", async () => {
  const started = performance.now();
  const version = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  expect(version).toMatch(/^[a-f0-9]{40}$/);
  vi.stubEnv("APP_ENV", "test");
  const owner = await createM1Support({ clock: createM1RealClock() });
  const scope = owner.sharedScope();
  const storage: M1Attachment["storage"] = {
    endpoint: "http://127.0.0.1:9100",
    region: "us-east-1",
    accessKey: "liyoxi",
    secretKey: "lyx-local-dev",
    buckets: {
      secure: `lyx-test-mixed-${scope.runId}-secure`,
      asset: `lyx-test-mixed-${scope.runId}-asset`,
      media: `lyx-test-mixed-${scope.runId}-media`,
      pub: `lyx-test-mixed-${scope.runId}-pub`,
    },
  };
  const io = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    forcePathStyle: true,
    credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey },
  });
  process.stdout.write(
    `M1HTTP隔离资源：${JSON.stringify({
      databaseName: scope.databaseName,
      redisPrefix: scope.redisPrefix,
      buckets: Object.values(storage.buckets),
    })}\n`,
  );
  let bridge: Awaited<ReturnType<typeof createM1HttpBridge>> | undefined;
  const ownedBuckets: string[] = [];
  const errors: unknown[] = [];
  const cleanup = async (action: () => unknown | Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  const absent = (error: unknown) =>
    error instanceof Error && ["NotFound", "NoSuchBucket"].includes(error.name);
  try {
    // Never adopt an existing bucket, even if a random name were to collide.
    for (const bucket of Object.values(storage.buckets)) {
      try {
        await io.send(new HeadBucketCommand({ Bucket: bucket }), {
          abortSignal: AbortSignal.timeout(5000),
        });
      } catch (error) {
        if (!absent(error)) throw error;
        ownedBuckets.push(bucket);
        continue;
      }
      throw new Error("M1 HTTP 本轮桶已存在，拒绝接管");
    }
    vi.stubEnv("APP_ENV", "local");
    bridge = await createM1HttpBridge({
      attach: { scope, chainId: "httpfull", version, storage },
      signal: AbortSignal.timeout(150_000),
    });
    expect(bridge.support.runtime.providers.storage.uploadLocation).toEqual({
      region: storage.region,
      buckets: storage.buckets,
    });
    expect(bridge.support.runtime.providers.storage.capabilities).toEqual({
      sts: false,
      versioning: false,
    });
    const result = await bridge.runChain();
    expect(result.initialization).toBe("bootstrap");
    expect(result.report.episodeCount).toBe(20);
    expect(result.report.final).toEqual({
      order: "live",
      item: "live",
      ticket: "in_service",
      isLive: true,
    });
    expect(result.report.invariants).toMatchObject({
      status: "succeeded",
      violationsFound: 0,
      errors: 0,
    });
    expect(result.report.invariants.checksRun).toBeGreaterThan(0);
    expect(result.observedReads.length).toBeGreaterThan(0);
    expect(await bridge.drain()).toMatchObject({ consumed: expect.any(Number) });
    process.stdout.write(`M1HTTP主链：${JSON.stringify(result.report)}\n`);
  } catch (error) {
    errors.push(error);
  } finally {
    await cleanup(() => bridge?.close());
    const cleanupSignal = AbortSignal.timeout(30_000);
    // These exact fresh buckets are created without versioning by the existing local provider.
    for (const bucket of ownedBuckets) {
      await cleanup(async () => {
        let continuation: string | undefined;
        for (let page = 0; page < 16; page++) {
          let listed;
          try {
            listed = await io.send(
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
          const objects = (listed.Contents ?? []).map((object) => {
            if (!object.Key) throw new Error("M1 HTTP 清理清单缺少对象编号");
            return { Key: object.Key };
          });
          if (objects.length) {
            const removed = await io.send(
              new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
              { abortSignal: cleanupSignal },
            );
            if (removed.Errors?.length) throw new Error("M1 HTTP 自有对象未完整删除");
          }
          if (listed.IsTruncated === false) return;
          if (listed.IsTruncated !== true || !listed.NextContinuationToken)
            throw new Error("M1 HTTP 清理分页结果不完整");
          continuation = listed.NextContinuationToken;
        }
        throw new Error("M1 HTTP 自有桶清理超过有界分页");
      });
      await cleanup(async () => {
        try {
          await io.send(new DeleteBucketCommand({ Bucket: bucket }), {
            abortSignal: cleanupSignal,
          });
        } catch (error) {
          if (!absent(error)) throw error;
        }
      });
    }
    await cleanup(() => io.destroy());
    await cleanup(() => owner.close());
    await cleanup(() => vi.unstubAllEnvs());
  }
  if (errors.length) throw new AggregateError(errors, "M1 HTTP 七段主链或自有资源清理失败");
  expect(performance.now() - started, "迁移、真实HTTP主链与精确清理总墙钟").toBeLessThanOrEqual(
    180_000,
  );
}, 180_000);
