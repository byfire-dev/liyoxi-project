import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { merchantCertificateForTest } from "../testing/index.js";
import { EnvError, loadEnv } from "./env.js";

// 全部密钥和自签证书现场生成，仅本测试自有临时目录，无真实账号/文件。
const directory = mkdtempSync(join(tmpdir(), "lyx-wechatpay-cert-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const identity = merchantCertificateForTest();
const other = merchantCertificateForTest();
const base = {
  APP_ENV: "test",
  DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@127.0.0.1:5442/liyoxi",
  REDIS_URL: "redis://127.0.0.1:6389/0",
};
const config = {
  mchid: "1900000109",
  merchantSerialNo: identity.serial,
  merchantPrivateKeyPem: identity.privateKeyPem,
  apiV3Key: "public-fake-apiv3-key".padEnd(32, "0"),
  publicKeyId: "PUB_KEY_ID_PUBLICTEST",
  // 这是微信支付平台公钥，特意与商户证书公钥不同。
  publicKeyPem: other.publicKeyPem,
  appid: "wx0000000000000000",
  notifyUrl: "https://example.invalid/api/v1/hooks/wechatpay/transactions",
};
let sequence = 0;
function load(value: object) {
  const path = join(directory, `pay-${sequence++}.json`);
  writeFileSync(path, JSON.stringify(value));
  return loadEnv({ ...base, WECHAT_PAY_FILE: path }).WECHAT_PAY;
}

it("旧WECHAT_PAY_FILE无证书仍原输出；全未配置不造期限事实", () => {
  expect(loadEnv(base).WECHAT_PAY).toBeUndefined();
  const legacy = load(config);
  expect(legacy).toEqual(config);
  expect(legacy).not.toHaveProperty("merchantCertificateExpiresAt");
  expect(() => loadEnv({ ...base, WECHAT_PAY: JSON.stringify(config) })).toThrow(EnvError);
});

it("真实X509规范化serial并绑定商户私钥，仅派生证书自身validTo", () => {
  const actual = load({
    ...config,
    merchantSerialNo: `00${identity.serial.toLowerCase()}`,
    merchantCertificatePem: identity.certificatePem,
  });
  expect(actual).toEqual({
    ...config,
    merchantSerialNo: `00${identity.serial.toLowerCase()}`,
    merchantCertificateExpiresAt: "2046-01-01T00:00:00.000Z",
  });
  expect(actual).not.toHaveProperty("merchantCertificatePem");
  expect(JSON.stringify(actual)).not.toContain("BEGIN CERTIFICATE");
});

it("错误证书/serial/私钥或伪填派生字段拒绝，错误不回显配置内容", () => {
  for (const patch of [
    { merchantCertificatePem: "" },
    { merchantCertificatePem: "public-malformed-certificate" },
    { merchantCertificatePem: identity.certificatePem, merchantSerialNo: other.serial },
    { merchantCertificatePem: identity.certificatePem, merchantPrivateKeyPem: other.privateKeyPem },
    { merchantCertificatePem: identity.certificatePem, merchantPrivateKeyPem: "public-bad-key" },
    { merchantCertificateExpiresAt: "2099-01-01T00:00:00.000Z" },
  ]) {
    try {
      load({ ...config, ...patch });
      expect.fail("错误证书事实未拒绝");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvError);
      expect((error as EnvError).issues).toEqual([
        { key: "WECHAT_PAY_FILE", reason: expect.any(String) },
      ]);
      for (const value of [
        directory,
        identity.serial,
        identity.certificatePem,
        identity.privateKeyPem,
        other.privateKeyPem,
        "2099-01-01",
        "public-bad-key",
      ])
        expect((error as Error).message).not.toContain(value);
    }
  }
});
