import { expect, it } from "vitest";
import { EnvError, loadEnv } from "./env.js";
const base = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://a:a@localhost/test",
  REDIS_URL: "redis://localhost",
};
const config = {
  ESIGN_SSM_REGION: "ap-guangzhou",
  ESIGN_SSM_SECRET_NAME: "test-cert",
  ESIGN_SSM_VERSION_ID: "immutable-v1",
  ESIGN_SSM_STS_CREDENTIALS_FILE: "/does-not-exist/worker-only.json",
  LYX_PDF_FONT_DIR: "/does-not-exist/fonts",
};
it("仅解析worker身份与字体路径描述，绝不急切打开不存在的文件", () => {
  expect(loadEnv(base)).not.toHaveProperty("ESIGN_SSM");
  const env = loadEnv({ ...base, ...config });
  expect(env.ESIGN_SSM).toEqual({
    region: "ap-guangzhou",
    secretName: "test-cert",
    versionId: "immutable-v1",
    stsCredentialsFile: config.ESIGN_SSM_STS_CREDENTIALS_FILE,
  });
  expect(Object.isFrozen(env.ESIGN_SSM)).toBe(true);
  expect(env.LYX_PDF_FONT_DIR).toBe(config.LYX_PDF_FONT_DIR);
  expect(loadEnv(base)).not.toHaveProperty("LYX_PDF_FONT_DIR");
});
it("拒绝半配、移动别名与非规范路径，错误不含值", () => {
  for (const invalid of [
    { ESIGN_SSM_REGION: "ap-guangzhou" },
    { ...config, ESIGN_SSM_VERSION_ID: "SSM_Current" },
    { ...config, ESIGN_SSM_STS_CREDENTIALS_FILE: "relative/private.json" },
    { ...config, ESIGN_SSM_STS_CREDENTIALS_FILE: "/private/../credential.json" },
    { ...config, LYX_PDF_FONT_DIR: "relative-font" },
  ]) {
    expect(() => loadEnv({ ...base, ...invalid })).toThrow(EnvError);
    try {
      loadEnv({ ...base, ...invalid });
    } catch (error) {
      expect(String(error)).not.toContain("private.json");
      expect(String(error)).not.toContain("SSM_Current");
    }
  }
});
