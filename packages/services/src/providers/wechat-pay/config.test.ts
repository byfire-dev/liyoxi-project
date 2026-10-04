import { beforeAll, describe, expect, it } from "vitest";

import { PROVIDER_METHODS } from "../types.js";
import { generateIdentity, testApiV3Key } from "./__fixtures__/wechatpay-server.js";
import { resolveWechatPayConfig, WECHAT_PAY_GROUP, WechatPayConfigError } from "./config.js";
import type { WechatPaySettings } from "./config.js";
import { createWechatPay } from "./driver.js";

// 未配置不崩溃，配置成组（X-04 任务书 第 7 节第 8 条；D7 第 7.5 节；ADR-039）。

let full: Required<
  Pick<
    WechatPaySettings,
    | "mchid"
    | "merchantSerialNo"
    | "merchantPrivateKeyPem"
    | "apiV3Key"
    | "publicKeyId"
    | "publicKeyPem"
    | "appid"
    | "notifyUrl"
  >
>;

beforeAll(() => {
  const merchant = generateIdentity("LYXTESTMCHCERTSERIAL0001");
  const platform = generateIdentity("PUB_KEY_ID_0000000000000000000000000000000001");
  full = {
    mchid: "1900000109",
    merchantSerialNo: merchant.serial,
    merchantPrivateKeyPem: merchant.privateKeyPem,
    apiV3Key: testApiV3Key("current"),
    publicKeyId: platform.serial,
    publicKeyPem: platform.publicKeyPem,
    appid: "wx0000000000000000",
    notifyUrl: "https://api.example.invalid/api/v1/hooks/wechatpay/transactions",
  };
});

describe("五项成组", () => {
  it("成组的是这五项：商户号、证书序列号、私钥、APIv3 密钥、公钥 ID", () => {
    expect([...WECHAT_PAY_GROUP]).toEqual([
      "mchid",
      "merchantSerialNo",
      "merchantPrivateKeyPem",
      "apiV3Key",
      "publicKeyId",
    ]);
  });

  it("五项全缺：未配置。configured 为 false，调用即“未配置”，不抛错", async () => {
    for (const settings of [{}, { mchid: "", apiV3Key: "   " }, { appid: "wx0000000000000000" }]) {
      expect(resolveWechatPayConfig(settings)).toEqual({ state: "unconfigured" });
    }
    const provider = createWechatPay({});
    expect(provider).toMatchObject({ status: "unconfigured", configured: false });
    for (const method of PROVIDER_METHODS.wechatPay) {
      const call = provider[method] as (input: unknown) => Promise<unknown>;
      expect(await call({})).toMatchObject({ ok: false, reason: "unconfigured" });
    }
  });

  it.each([...WECHAT_PAY_GROUP])("缺 %s 一项：配置错误，并指出缺的是它", (key) => {
    const settings = { ...full, [key]: undefined };
    expect(resolveWechatPayConfig(settings)).toEqual({
      state: "invalid",
      missing: [key],
      problems: [],
    });
    expect(() => createWechatPay(settings)).toThrow(WechatPayConfigError);
    expect(() => createWechatPay(settings)).toThrow(new RegExp(`缺 ${key}$`));
  });

  it("只配了一项：指出缺的另外四项与驱动另要的三项", () => {
    expect(resolveWechatPayConfig({ mchid: "1900000109" })).toEqual({
      state: "invalid",
      missing: [
        "merchantSerialNo",
        "merchantPrivateKeyPem",
        "apiV3Key",
        "publicKeyId",
        "publicKeyPem",
        "appid",
        "notifyUrl",
      ],
      problems: [],
    });
  });

  it.each(["publicKeyPem", "appid", "notifyUrl"] as const)(
    "五项齐全而缺 %s：同样是配置错误",
    (key) => {
      expect(resolveWechatPayConfig({ ...full, [key]: " " })).toEqual({
        state: "invalid",
        missing: [key],
        problems: [],
      });
    },
  );
});

describe("填了但不合规", () => {
  it.each([
    ["merchantPrivateKeyPem", "这不是一把私钥"],
    ["apiV3Key", "too-short"],
    ["publicKeyId", "5157F09EFDC096DE15EBE81A47057A72"],
    ["notifyUrl", "http://api.example.invalid/hooks"],
    ["notifyUrl", "https://api.example.invalid/hooks?x=1"],
    ["refundNotifyUrl", "ftp://api.example.invalid/hooks"],
  ])("%s 写错：配置错误，报错写字段名与原因、不带值", (key, value) => {
    const resolved = resolveWechatPayConfig({ ...full, [key]: value });
    expect(resolved).toMatchObject({ state: "invalid", missing: [] });
    if (resolved.state !== "invalid") return;
    expect(resolved.problems).toHaveLength(1);
    expect(resolved.problems[0]?.startsWith(`${key}: `)).toBe(true);
    const error = new WechatPayConfigError(resolved.missing, resolved.problems);
    expect(error.message).not.toContain(value);
    expect(() => createWechatPay({ ...full, [key]: value })).toThrow(error.message);
  });
});

describe("齐全", () => {
  it("给出校验过的配置：公钥在验签身份表的第一位，密钥版本缺省 v1", () => {
    const resolved = resolveWechatPayConfig(full);
    if (resolved.state !== "configured") throw new Error("应当是已配置");
    expect(resolved.config).toMatchObject({
      mchid: "1900000109",
      appid: "wx0000000000000000",
      publicKeyId: full.publicKeyId,
      apiV3Keys: { current: { kid: "v1" } },
      verifiers: [{ serial: full.publicKeyId, pem: full.publicKeyPem }],
      refundNotifyUrl: undefined,
    });
    expect(resolved.config.merchantPrivateKey.type).toBe("private");
  });

  it("轮换期：上一把 APIv3 密钥与平台证书一并带上", () => {
    const resolved = resolveWechatPayConfig({
      ...full,
      apiV3KeyId: "v2",
      previousApiV3Key: { kid: "v1", key: testApiV3Key("previous") },
      platformCertificates: [{ serial: "4DF0", pem: "-----BEGIN CERTIFICATE-----" }],
      refundNotifyUrl: "https://api.example.invalid/api/v1/hooks/wechatpay/refunds",
    });
    if (resolved.state !== "configured") throw new Error("应当是已配置");
    expect(resolved.config.apiV3Keys).toMatchObject({
      current: { kid: "v2" },
      previous: { kid: "v1" },
    });
    expect(resolved.config.verifiers.map((entry) => entry.serial)).toEqual([
      full.publicKeyId,
      "4DF0",
    ]);
    expect(resolved.config.refundNotifyUrl).toMatch(/refunds$/);
  });

  it("createWechatPay 给出真实驱动", () => {
    expect(createWechatPay(full)).toMatchObject({ status: "wechatpay-v3", configured: true });
  });
});
