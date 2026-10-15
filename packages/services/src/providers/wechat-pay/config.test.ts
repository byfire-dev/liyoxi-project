import { beforeAll, describe, expect, it } from "vitest";

import { PROVIDER_METHODS } from "../types.js";
import { createProviders } from "../index.js";
import { createRecordingLogger } from "../../testing/index.js";
import {
  generateCertificateIdentity,
  generateIdentity,
  testApiV3Key,
} from "./__fixtures__/wechatpay-server.js";
import type { TestIdentity } from "./__fixtures__/wechatpay-server.js";
import { resolveWechatPayConfig, WECHAT_PAY_GROUP, WechatPayConfigError } from "./config.js";
import type { WechatPaySettings } from "./config.js";
import { createWechatPay } from "./driver.js";
import { createVerifierTable } from "./keyring.js";

// 未配置不崩溃，配置成组（X-04 任务书 第 7 节第 8 条；D7 第 7.5 节；ADR-039）。

/** 时钟是必填的依赖：接入时给内核的时钟，用例给固定时刻 */
const DEPS = { now: () => new Date("2026-10-04T02:00:00.000Z") };

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

let merchant: TestIdentity;
let certificate: TestIdentity & { certificatePem: string };

beforeAll(() => {
  merchant = generateIdentity("LYXTESTMCHCERTSERIAL0001");
  certificate = generateCertificateIdentity();
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
    for (const settings of [{}, { mchid: "", apiV3Key: "   " }]) {
      expect(resolveWechatPayConfig(settings)).toEqual({ state: "unconfigured" });
    }
    const provider = createWechatPay({}, DEPS);
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
    expect(() => createWechatPay(settings, DEPS)).toThrow(WechatPayConfigError);
    expect(() => createWechatPay(settings, DEPS)).toThrow(new RegExp(`缺 ${key}$`));
  });

  it("只配了一项：指出缺的另外四项与驱动另要的三项", () => {
    expect(resolveWechatPayConfig({ appid: "wx0000000000000000" })).toMatchObject({
      state: "invalid",
    });
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
    expect(() => createWechatPay({ ...full, [key]: value }, DEPS)).toThrow(error.message);
  });
});

describe("公钥本体与轮换项写错（复审补的）：在成组校验里就报出字段名，不等到建驱动时抛底层的报错", () => {
  const cases = (): Array<[string, Partial<WechatPaySettings>, string]> => [
    ["公钥本体不是 PEM", { publicKeyPem: "这不是一把公钥" }, "publicKeyPem: "],
    [
      "公钥本体被截断",
      { publicKeyPem: full.publicKeyPem.replace(/\n[^\n]{20}/, "\n") },
      "publicKeyPem: ",
    ],
    ["私钥填进了公钥一栏", { publicKeyPem: merchant.privateKeyPem }, "publicKeyPem: "],
    ["证书填进了公钥一栏", { publicKeyPem: certificate.certificatePem }, "publicKeyPem: "],
    [
      "上一把密钥长度不对",
      { previousApiV3Key: { kid: "v0", key: "too-short" } },
      "previousApiV3Key: ",
    ],
    [
      "上一把密钥的 kid 与当前的相同",
      { apiV3KeyId: "v2", previousApiV3Key: { kid: "v2", key: testApiV3Key("previous") } },
      "previousApiV3Key: ",
    ],
    [
      "上一把密钥没有 kid",
      { previousApiV3Key: { kid: "", key: testApiV3Key("previous") } },
      "previousApiV3Key: ",
    ],
    [
      "平台证书的序列号与证书不一致",
      { platformCertificates: [{ serial: "00FF", pem: certificate.certificatePem }] },
      "platformCertificates[0]: ",
    ],
    [
      "平台证书写坏",
      { platformCertificates: [{ serial: "4DF0", pem: "-----BEGIN CERTIFICATE-----" }] },
      "platformCertificates[0]: ",
    ],
    [
      "第二条验签身份：证书序列号配了公钥",
      {
        platformCertificates: [
          { serial: certificate.serial, pem: certificate.certificatePem },
          { serial: "4DF0", pem: full.publicKeyPem },
        ],
      },
      "platformCertificates[1]: ",
    ],
  ];

  it("逐例：配置错误，只有这一个字段的一条原因；createWechatPay 抛 WechatPayConfigError", () => {
    for (const [name, overrides, prefix] of cases()) {
      const settings = { ...full, ...overrides };
      const resolved = resolveWechatPayConfig(settings);
      expect(resolved, name).toMatchObject({ state: "invalid", missing: [] });
      if (resolved.state !== "invalid") continue;
      expect(resolved.problems, name).toHaveLength(1);
      expect(resolved.problems[0]?.startsWith(prefix), name).toBe(true);
      const build = () => createWechatPay(settings, DEPS);
      expect(build, name).toThrow(WechatPayConfigError);
      expect(build, name).toThrow(prefix);
      // 报错不带底层（OpenSSL）的原文，也不带任何配置值
      expect(build, name).not.toThrow(/DECODER|routines|asn1|BEGIN|too-short/i);
    }
  });

  it("公钥 ID 写错时不连带再报公钥本体；几样都错时各报各的", () => {
    const resolved = resolveWechatPayConfig({
      ...full,
      publicKeyId: "5157F09EFDC096DE15EBE81A47057A72",
      previousApiV3Key: { kid: "v0", key: "x" },
      platformCertificates: [{ serial: "4DF0", pem: "-----BEGIN CERTIFICATE-----" }],
    });
    if (resolved.state !== "invalid") throw new Error("应当是配置错误");
    expect(resolved.problems.map((problem) => problem.split(": ")[0])).toEqual([
      "publicKeyId",
      "previousApiV3Key",
      "platformCertificates[0]",
    ]);
  });

  it("证书序列号写成小写：算合规，验签身份表照证书自己的序列号登记", () => {
    const serial = certificate.serial.toLowerCase();
    const resolved = resolveWechatPayConfig({
      ...full,
      platformCertificates: [{ serial, pem: certificate.certificatePem }],
    });
    if (resolved.state !== "configured") throw new Error("应当是已配置");
    const table = createVerifierTable(resolved.config.verifiers);
    expect(table.lookup(certificate.serial)?.kind).toBe("certificate");
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
      platformCertificates: [{ serial: certificate.serial, pem: certificate.certificatePem }],
      refundNotifyUrl: "https://api.example.invalid/api/v1/hooks/wechatpay/refunds",
    });
    if (resolved.state !== "configured") throw new Error("应当是已配置");
    expect(resolved.config.apiV3Keys).toMatchObject({
      current: { kid: "v2" },
      previous: { kid: "v1" },
    });
    expect(resolved.config.verifiers.map((entry) => entry.serial)).toEqual([
      full.publicKeyId,
      certificate.serial,
    ]);
    expect(resolved.config.refundNotifyUrl).toMatch(/refunds$/);
  });

  it("换微信支付公钥时：并存的另一把公钥放进 platformCertificates，验签身份表两把都认", () => {
    const next = generateIdentity("PUB_KEY_ID_0000000000000000000000000000000002");
    const resolved = resolveWechatPayConfig({
      ...full,
      platformCertificates: [{ serial: next.serial, pem: next.publicKeyPem }],
    });
    if (resolved.state !== "configured") throw new Error("应当是已配置");
    // 请求头里带的公钥 ID 只有 publicKeyId 一个
    expect(resolved.config.publicKeyId).toBe(full.publicKeyId);
    const table = createVerifierTable(resolved.config.verifiers);
    expect(table.lookup(full.publicKeyId)?.kind).toBe("public-key");
    expect(table.lookup(next.serial)?.kind).toBe("public-key");
  });

  it("上一把 APIv3 密钥首尾的空白同样不计入长度", () => {
    const key = testApiV3Key("previous");
    const resolved = resolveWechatPayConfig({
      ...full,
      apiV3KeyId: "v2",
      previousApiV3Key: { kid: "v1", key: `${key}\n` },
    });
    if (resolved.state !== "configured") throw new Error("应当是已配置");
    expect(resolved.config.apiV3Keys.previous).toEqual({ kid: "v1", key });
  });

  it("APIv3 密钥首尾的空白（文件结尾的换行）不计入长度", () => {
    const resolved = resolveWechatPayConfig({ ...full, apiV3Key: `${full.apiV3Key}\n` });
    if (resolved.state !== "configured") throw new Error("应当是已配置");
    expect(resolved.config.apiV3Keys.current.key).toBe(full.apiV3Key);
  });

  it("createWechatPay 给出真实驱动", () => {
    expect(
      createProviders({
        appEnv: "test",
        logger: createRecordingLogger(),
        settings: { wechatPay: full },
        wechatPay: DEPS,
      }).wechatPay,
    ).toMatchObject({ status: "wechatpay-v3", configured: true });
    expect(createWechatPay(full, DEPS)).toMatchObject({
      status: "wechatpay-v3",
      configured: true,
    });
  });
});
