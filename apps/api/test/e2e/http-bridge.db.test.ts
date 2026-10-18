// One selected-source network/attachment proof; this is not the old/new four-step drill.
import { randomUUID } from "node:crypto";
import { DeleteBucketCommand, DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { expect, it, vi } from "vitest";
import { staff } from "@liyoxi/services";
import { createM1RealClock, createM1Support } from "@liyoxi/services/testing";
import type { M1Attachment } from "@liyoxi/services/testing";
import { createM1HttpBridge } from "./http-bridge.js";
import { bootstrapM1Admin, loginM1Staff } from "./m1-auth.js";
import { createM1Caller } from "./runner-api.js";

it("同源码两次真实HTTP装配保留同库与MinIO，错归属拒绝且每次重新登录/MFA", async () => {
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
  let first: Awaited<ReturnType<typeof createM1HttpBridge>> | undefined;
  let second: Awaited<ReturnType<typeof createM1HttpBridge>> | undefined;
  const key = `incoming/${randomUUID()}.txt`,
    bytes = new TextEncoder().encode("owned mixed bridge IO");
  const io = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    forcePathStyle: true,
    credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey },
  });
  const errors: unknown[] = [];
  const cleanup = async (action: () => unknown | Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  const removeObject = async () => {
    try {
      await io.send(new DeleteObjectCommand({ Bucket: storage.buckets.asset, Key: key }), {
        abortSignal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      if (!(error instanceof Error) || !["NoSuchBucket", "NoSuchKey"].includes(error.name))
        throw error;
    }
  };
  const removeBucket = async (bucket: string) => {
    try {
      await io.send(new DeleteBucketCommand({ Bucket: bucket }), {
        abortSignal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "NoSuchBucket") throw error;
    }
  };
  try {
    vi.stubEnv("APP_ENV", "local");
    const attach: M1Attachment = {
      scope,
      chainId: "firstround",
      version: "selected-source-a",
      storage,
    };
    await expect(
      createM1Support({ attach: { ...attach, scope: { ...scope, ownerToken: "b".repeat(32) } } }),
    ).rejects.toThrow("自有Redis能力");
    first = await createM1HttpBridge({ attach });
    const admin = await bootstrapM1Admin(first.api);
    const call = createM1Caller(first.api);
    expect(
      (await call("admin.staff.get", admin.headers, { params: { staffId: admin.staffId } }))
        .staffId,
    ).toBe(admin.staffId);
    const provider = first.support.runtime.providers.storage;
    const post = await provider.presignPost({
      bucket: "asset",
      key,
      mime: "text/plain",
      maxBytes: bytes.length,
      expiresSec: 60,
    });
    expect(post.ok).toBe(true);
    if (!post.ok || !first.support.httpIO) throw new Error("本轮真实对象表单缺失");
    expect(await first.support.httpIO.upload(post.value, bytes)).toBe(204);
    expect(await provider.head({ bucket: "asset", key })).toMatchObject({
      ok: true,
      value: { exists: true, size: bytes.length },
    });
    await first.close();
    second = await createM1HttpBridge({
      attach: { ...attach, chainId: "secondround", version: "selected-source-b" },
    });
    const usedStep = await second.support.readStaffTotpStep(admin.staffId);
    expect(usedStep).not.toBeNull();
    // 真实跨过已消费步后，新 HTTP 登录不应再无条件空等一个周期。
    await second.api.waitUntil!(new Date((usedStep! + 1) * 30_000));
    const waits = vi.spyOn(second.api, "waitUntil");
    const signedIn = await loginM1Staff(second.api, admin);
    expect(waits).not.toHaveBeenCalled();
    expect(signedIn.staffId).toBe(admin.staffId);
    expect(signedIn.headers.cookie).not.toBe(admin.headers.cookie);
    const currentStep = await second.support.readStaffTotpStep(admin.staffId);
    expect(currentStep).toBe(staff.totpStep(second.support.clock.now()));
    expect(currentStep!).toBeGreaterThan(usedStep!);
    // 同一步再重登必须等真实下一步；仍由正式 verify-mfa 消费，不改库或复用会话。
    const sameStep = await loginM1Staff(second.api, admin);
    expect(waits).toHaveBeenCalledExactlyOnceWith(new Date((currentStep! + 1) * 30_000));
    expect(sameStep.headers.cookie).not.toBe(signedIn.headers.cookie);
    expect(await second.support.readStaffTotpStep(admin.staffId)).toBeGreaterThan(currentStep!);
    const reread = await createM1Caller(second.api)("admin.staff.get", signedIn.headers, {
      params: { staffId: admin.staffId },
    });
    expect(reread.staffId).toBe(admin.staffId);
    const signed = await second.support.runtime.providers.storage.presignGet({
      bucket: "asset",
      key,
      expiresSec: 60,
    });
    if (!signed.ok || !second.support.httpIO) throw new Error("本轮真实签读缺失");
    const actual = await second.support.httpIO.readSigned(signed.value.url);
    expect(actual.status).toBe(200);
    if (actual.status !== 200) throw new Error("本轮实际字节不可读");
    expect(actual.body).toEqual(bytes);
    expect(await second.drain()).toMatchObject({ consumed: expect.any(Number) });
    expect(owner.sharedScope()).toEqual(scope); // Attach close did not remove the owner's capability.
  } catch (error) {
    errors.push(error);
  } finally {
    await cleanup(() => second?.close());
    await cleanup(() => first?.close());
    // Exact one owned object and four random owned buckets; no shared/local business bucket cleanup.
    await cleanup(removeObject);
    for (const bucket of Object.values(storage.buckets)) await cleanup(() => removeBucket(bucket));
    await cleanup(() => io.destroy());
    await cleanup(() => owner.close());
    await cleanup(() => vi.unstubAllEnvs());
  }
  if (errors.length) throw new AggregateError(errors, "M1 HTTP 桥目标或自有资源清理失败");
}, 120_000);
