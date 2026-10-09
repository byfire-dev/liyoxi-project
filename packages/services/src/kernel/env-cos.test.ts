import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";
import { createProviders } from "../providers/index.js";
import { createRecordingLogger } from "../testing/index.js";

const root = mkdtempSync(join(tmpdir(), "lyx-w301-env-"));
const file = (name: string, body: unknown) => {
  const path = join(root, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
};
const pair = { secretId: "publicfakeid", secretKey: "never-private-fixture" };
const signer = file("signer", pair);
const issuer = file("issuer", pair);
const worker = file("worker", pair);
const base = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@localhost:5442/liyoxi",
  REDIS_URL: "redis://localhost:6389/0",
};
const common = {
  COS_REGION: "ap-beijing",
  COS_BUCKET_SECURE: "test-secure-1250000000",
  COS_BUCKET_ASSET: "test-asset-1250000000",
  COS_BUCKET_MEDIA: "test-media-1250000000",
  COS_BUCKET_PUB: "test-pub-1250000000",
};
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("COS FILE组与角色", () => {
  it("未配无COS；API signer/issuer与worker配置各自完整", () => {
    expect(loadEnv(base).COS).toBeUndefined();
    expect(
      loadEnv({
        ...base,
        ...common,
        COS_SIGNER_KEYS_FILE: signer,
        COS_STS_ISSUER_KEYS_FILE: issuer,
      }).COS,
    ).toMatchObject({ region: "ap-beijing", signer: pair, stsIssuer: pair });
    expect(loadEnv({ ...base, ...common, COS_WORKER_KEYS_FILE: worker }).COS).toMatchObject({
      worker: pair,
    });
  });
  it("半配/明文/错账号/端点混配均拒绝且不泄露原值", () => {
    for (const source of [
      { ...base, ...common, COS_SIGNER_KEYS_FILE: signer },
      { ...base, COS_WORKER_KEYS_FILE: worker },
      { ...base, ...common, COS_WORKER_KEYS_FILE: worker, COS_SIGNER_KEYS: "sensitive-plaintext" },
      { ...base, ...common, COS_WORKER_KEYS_FILE: worker, COS_BUCKET_PUB: "test-pub-5555555555" },
      { ...base, ...common, COS_WORKER_KEYS_FILE: worker, MINIO_ENDPOINT: "http://localhost:9100" },
      {
        ...base,
        ...common,
        COS_WORKER_KEYS_FILE: file("extra", { ...pair, extra: "sensitive-extra" }),
      },
    ]) {
      try {
        loadEnv(source);
        throw new Error("accepted bad config");
      } catch (error) {
        expect(error).not.toHaveProperty("message", "accepted bad config");
        expect(String(error)).not.toContain("sensitive-");
        expect(String(error)).not.toContain(root);
      }
    }
  });
  it("官方工厂无发现链/构建外呼，关闭只登记自有COS", async () => {
    let calls = 0;
    const closers: Array<() => Promise<void>> = [];
    const env = loadEnv({
      ...base,
      ...common,
      COS_SIGNER_KEYS_FILE: signer,
      COS_STS_ISSUER_KEYS_FILE: issuer,
    });
    const providers = createProviders({
      appEnv: "test",
      logger: createRecordingLogger(),
      settings: { storage: { driver: "cos", cos: env.COS! } },
      storage: {
        now: () => new Date("2026-01-01"),
        registerClose: (close) => closers.push(close),
        fetchImpl: async () => {
          calls++;
          throw new Error("unexpected request");
        },
      },
    });
    expect(providers.storage.status).toBe("cos");
    expect(calls).toBe(0);
    expect(closers).toHaveLength(1);
    await closers[0]!();
    expect(await providers.storage.head({ bucket: "asset", key: "a" })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(calls).toBe(0);
  });
});
