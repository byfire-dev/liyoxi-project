import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";
const root = mkdtempSync(join(tmpdir(), "lyx-w303-env-"));
const file = (name: string, text: string) => {
  const path = join(root, name);
  writeFileSync(path, text);
  return path;
};
const keyFile = file("callback", "public-fake-ci-callback-key-with-32-bytes");
const worker = file(
  "worker",
  JSON.stringify({ secretId: "public-fake-id", secretKey: "public-fake-key" }),
);
const base = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@localhost:5442/liyoxi",
  REDIS_URL: "redis://localhost:6389/0",
};
const callback = {
  CI_CALLBACK_KEY_FILE: keyFile,
  CI_CALLBACK_ORIGIN: "https://callback.example.invalid",
};
const common = {
  CI_REGION: "ap-beijing",
  CI_BUCKET_SECURE: "test-secure-1250000000",
  CI_BUCKET_ASSET: "test-asset-1250000000",
  CI_BUCKET_MEDIA: "test-media-1250000000",
  CI_BUCKET_PUB: "test-pub-1250000000",
  CI_WORKER_KEYS_FILE: worker,
};
afterAll(() => rmSync(root, { recursive: true, force: true }));
describe("CI FILE配置", () => {
  it("未配/纯API callback/完整worker组合分别明确，不从环境找凭据", () => {
    expect(loadEnv(base).CI).toBeUndefined();
    expect(loadEnv({ ...base, ...callback }).CI).toHaveProperty("callback");
    expect(loadEnv({ ...base, ...callback }).CI).not.toHaveProperty("worker");
    expect(loadEnv({ ...base, ...callback, ...common }).CI).toMatchObject({
      worker: { region: "ap-beijing", secretId: "public-fake-id" },
    });
  });
  it("半配/明文/非HTTPS/错账号/额外凭据属性受控拒绝且不泄露", () => {
    for (const extra of [
      { CI_CALLBACK_KEY_FILE: keyFile },
      { ...common },
      { ...common, ...callback, CI_WORKER_KEYS: "fictional-sensitive" },
      { ...common, ...callback, CI_BUCKET_PUB: "test-pub-4444444444" },
      { ...callback, CI_CALLBACK_ORIGIN: "http://callback.example.invalid" },
      {
        ...callback,
        ...common,
        CI_WORKER_KEYS_FILE: file(
          "extra",
          JSON.stringify({ secretId: "fictional-sensitive", secretKey: "public-key", extra: true }),
        ),
      },
    ]) {
      let error: unknown;
      try {
        loadEnv({ ...base, ...extra });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(String(error)).not.toContain("fictional-sensitive");
      expect(String(error)).not.toContain(root);
    }
  });
});
