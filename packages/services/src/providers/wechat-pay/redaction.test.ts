import { beforeAll, describe, expect, it } from "vitest";

import { createRecordingLogger } from "../../testing/index.js";
import { createTestSetup } from "./__fixtures__/test-setup.js";
import type { TestSetup } from "./__fixtures__/test-setup.js";
import {
  notificationBody,
  signedHeaders,
  transactionResource,
} from "./__fixtures__/wechatpay-server.js";
import { resolveWechatPayConfig, WechatPayConfigError } from "./config.js";
import { createWechatPayDriver } from "./driver.js";
import type { WechatPayDriver } from "./driver.js";
import { createApiV3Keyring, createVerifierTable } from "./keyring.js";

// 不泄密（X-04 任务书 第 7 节第 9 条；D2 第 10.2 节“密钥不进日志”）：各方法出错时，
// 错误对象与日志输出里没有私钥、APIv3 密钥、Authorization 头、openid、请求体，也没有账单下载地址里的令牌。

const NOW = new Date("2026-10-04T02:00:00.000Z");
const OPENID = "o-test-openid-secret-0001";
const DESCRIPTION = "只该出现在请求体里的商品描述";
const ATTACH = "v1.only-in-request-body";
const TOKEN = "BILL-DOWNLOAD-TOKEN-0001";

let setup: TestSetup;
/** 不许出现在错误与日志里的内容 */
let secrets: string[];

beforeAll(() => {
  setup = createTestSetup();
  const privateKeyBody = setup.merchant.privateKeyPem.split("\n").slice(1, -2);
  secrets = [
    setup.apiV3Key,
    OPENID,
    DESCRIPTION,
    ATTACH,
    TOKEN,
    "WECHATPAY2-SHA256-RSA2048",
    ...privateKeyBody,
  ];
});

type Outcome = (sentAuthorization: string) => Response | Promise<Response>;

/** 把每个方法都调一遍，每次请求都按 outcome 应答（或抛错）。返回全部结果、日志与发出去的 Authorization 头 */
async function exercise(outcome: Outcome): Promise<{ dump: string; authorizations: string[] }> {
  const logger = createRecordingLogger();
  const authorizations: string[] = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    const authorization = (init?.headers as Record<string, string>).Authorization ?? "";
    authorizations.push(authorization);
    return outcome(authorization);
  }) as typeof fetch;
  const driver: WechatPayDriver = createWechatPayDriver(setup.config, {
    fetchImpl,
    now: () => NOW,
    logger,
  });
  const results = [
    await driver.createJsapiOrder({
      outTradeNo: "FK20261004000001a1b2",
      description: DESCRIPTION,
      amountFen: 19900,
      payerOpenid: OPENID,
      attach: ATTACH,
    }),
    await driver.queryByOutTradeNo({ outTradeNo: "FK20261004000001a1b2" }),
    await driver.closeOrder({ outTradeNo: "FK20261004000001a1b2" }),
    await driver.createRefund({
      outTradeNo: "FK20261004000001a1b2",
      outRefundNo: "TK20261004000001",
      refundFen: 100,
      totalFen: 19900,
      reason: DESCRIPTION,
    }),
    await driver.queryRefund({ outRefundNo: "TK20261004000001" }),
    await driver.applyTradeBill({ billDate: "2026-10-03" }),
    await driver.downloadBill({
      downloadUrl: `https://api.mch.weixin.qq.com/v3/billdownload/file?token=${TOKEN}`,
      hashValue: "00",
    }),
    await driver.fetchTradeBill({ billDate: "2026-10-03" }),
  ];
  for (const result of results) expect(result.ok).toBe(false);
  // 账单摘要不符是驱动自己判出来的，不经请求客户端的日志；其余每次失败的请求都记一行
  expect(logger.lines.length).toBeGreaterThanOrEqual(results.length - 1);
  return { dump: JSON.stringify({ results, logs: logger.lines }), authorizations };
}

function expectClean(dump: string, authorizations: string[]): void {
  for (const secret of secrets) expect(dump).not.toContain(secret);
  for (const authorization of authorizations) {
    const signature = /signature="([^"]+)"/.exec(authorization)?.[1] ?? "没有签名";
    expect(dump).not.toContain(signature);
  }
}

describe("各方法出错时：错误对象与日志里没有密钥、Authorization 头、openid 与请求体", () => {
  it("业务错误：微信的说明里回显了入参，也不外传", async () => {
    const { dump, authorizations } = await exercise((authorization) => {
      const message = `参数错误：${DESCRIPTION} ${OPENID} ${ATTACH} ${authorization}`;
      return new Response(JSON.stringify({ code: "PARAM_ERROR", message }), { status: 400 });
    });
    expect(authorizations.length).toBeGreaterThanOrEqual(8);
    expectClean(dump, authorizations);
    expect(dump).toContain("PARAM_ERROR");
  });

  it("5xx：同上", async () => {
    const { dump, authorizations } = await exercise(
      () => new Response(`<html>${OPENID} ${DESCRIPTION}</html>`, { status: 502 }),
    );
    expectClean(dump, authorizations);
  });

  it("连不上：底层的报错里带着地址与请求头，也不外传", async () => {
    const { dump, authorizations } = await exercise((authorization) => {
      throw new Error(`connect ECONNREFUSED ?token=${TOKEN} ${authorization} ${OPENID}`);
    });
    expectClean(dump, authorizations);
  });

  it("应答验签失败：被丢弃的应答内容不外传", async () => {
    const { dump, authorizations } = await exercise(
      () =>
        new Response(JSON.stringify({ payer: { openid: OPENID }, attach: ATTACH }), {
          status: 200,
        }),
    );
    expectClean(dump, authorizations);
  });

  it("日志只带接口名、不带查询串的地址、状态码、错误码与 Request-ID", async () => {
    const logger = createRecordingLogger();
    const fetchImpl = (async () =>
      new Response('{"code":"NO_AUTH"}', {
        status: 403,
        headers: { "Request-ID": "REQ-9" },
      })) as typeof fetch;
    const driver = createWechatPayDriver(setup.config, { fetchImpl, now: () => NOW, logger });
    await driver.queryByOutTradeNo({ outTradeNo: "FK1" });
    expect(logger.lines).toEqual([
      {
        level: "warn",
        fields: {
          provider: "wechatPay",
          path: "/v3/pay/transactions/out-trade-no/FK1",
          status: 403,
          code: "NO_AUTH",
          requestId: "REQ-9",
        },
        message: "微信支付拒绝了请求（HTTP 403，NO_AUTH，Request-ID REQ-9）",
      },
    ]);
  });
});

describe("回调与配置出错时", () => {
  it("回调没通过：结果里没有请求体、密文、签名、openid 与密钥", async () => {
    const driver = createWechatPayDriver(setup.config, { now: () => NOW });
    const resource = transactionResource({ payer: { openid: OPENID }, attach: ATTACH });
    const rawBody = notificationBody(setup.apiV3Key, {
      id: "EV-1",
      eventType: "TRANSACTION.SUCCESS",
      resource,
    });
    const headers = signedHeaders(setup.platform, rawBody, NOW);
    const ciphertext = (JSON.parse(rawBody) as { resource: { ciphertext: string } }).resource
      .ciphertext;
    const failures = [
      driver.verifyNotification({ headers, rawBody: `${rawBody} ` }),
      driver.verifyNotification({
        headers: { ...headers, "Wechatpay-Serial": "PUB_KEY_ID_X" },
        rawBody,
      }),
      driver.verifyNotification({
        headers: signedHeaders(setup.platform, rawBody, new Date(0)),
        rawBody,
      }),
      await driver.verifyAndDecryptNotification({
        headers,
        rawBody: rawBody.replace("EV-1", "EV-2"),
      }),
    ];
    const dump = JSON.stringify(failures);
    for (const failure of failures) expect(failure.ok).toBe(false);
    for (const secret of [...secrets, ciphertext, headers["Wechatpay-Signature"] ?? "?", "EV-1"]) {
      expect(dump).not.toContain(secret);
    }
  });

  it("配置错误、密钥环与验签身份表建不起来：报错里没有任何配置值", () => {
    const privateKeyBody = setup.merchant.privateKeyPem.split("\n").slice(1, -2);
    const messages: string[] = [];
    const capture = (action: () => unknown) => {
      try {
        action();
      } catch (error) {
        messages.push(String(error instanceof Error ? error.message : error));
      }
    };
    const settings = {
      mchid: "1900000109",
      merchantSerialNo: setup.merchant.serial,
      merchantPrivateKeyPem: setup.merchant.privateKeyPem,
      apiV3Key: `${setup.apiV3Key}-too-long`,
      publicKeyId: "NOT-A-PUBLIC-KEY-ID",
      publicKeyPem: setup.platform.publicKeyPem,
      appid: "wx0000000000000000",
      notifyUrl: "http://insecure.example.invalid/?secret=1",
    };
    const resolved = resolveWechatPayConfig(settings);
    if (resolved.state !== "invalid") throw new Error("应当是配置错误");
    messages.push(new WechatPayConfigError(resolved.missing, resolved.problems).message);
    capture(() => createApiV3Keyring({ kid: "v1", key: `${setup.apiV3Key}-too-long` }));
    capture(() => createVerifierTable([{ serial: "ABCD", pem: setup.platform.publicKeyPem }]));
    capture(() =>
      createVerifierTable([{ serial: setup.platform.serial, pem: "-----BEGIN CERTIFICATE-----" }]),
    );
    expect(messages).toHaveLength(4);
    const dump = messages.join("\n");
    for (const secret of [
      setup.apiV3Key,
      "NOT-A-PUBLIC-KEY-ID",
      "insecure.example",
      ...privateKeyBody,
    ]) {
      expect(dump).not.toContain(secret);
    }
    expect(dump).not.toContain(setup.platform.publicKeyPem.split("\n")[1] ?? "?");
  });
});
