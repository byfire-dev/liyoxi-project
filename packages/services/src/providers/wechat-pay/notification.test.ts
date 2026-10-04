import { beforeAll, describe, expect, it } from "vitest";

import {
  generateCertificateIdentity,
  generateIdentity,
  notificationBody,
  refundResource,
  signedHeaders,
  testApiV3Key,
  transactionResource,
} from "./__fixtures__/wechatpay-server.js";
import type { NotificationSpec, TestIdentity } from "./__fixtures__/wechatpay-server.js";
import { createApiV3Keyring, createVerifierTable } from "./keyring.js";
import { verifyAndDecrypt } from "./notification.js";
import type { NotificationDeps, NotificationResult } from "./notification.js";

// 回调验签与解密的每种结果（X-04 任务书 第 7 节第 3 条；h01 第 2.1、3.1、3.2 节）。
// 密钥都是现场生成的测试密钥：一把微信支付公钥、一张自签名的“平台证书”、两把 APIv3 密钥。

const NOW = new Date("2026-10-04T02:00:00.000Z");
const CURRENT = { kid: "v2", key: testApiV3Key("current") };
const PREVIOUS = { kid: "v1", key: testApiV3Key("previous") };

let publicKey: TestIdentity;
let certificate: TestIdentity & { certificatePem: string };
let deps: NotificationDeps;

beforeAll(() => {
  publicKey = generateIdentity("PUB_KEY_ID_0000000000000000000000000000000001");
  certificate = generateCertificateIdentity();
  deps = {
    verifiers: createVerifierTable([
      { serial: publicKey.serial, pem: publicKey.publicKeyPem },
      { serial: certificate.serial, pem: certificate.certificatePem },
    ]),
    keyring: createApiV3Keyring(CURRENT, PREVIOUS),
    now: () => NOW,
  };
});

/** 造一条通知并投给被测的入口。缺省：微信支付公钥签名、当前密钥加密、此刻签发 */
function deliver(
  spec: NotificationSpec,
  options: { by?: TestIdentity; key?: string; at?: Date } = {},
): { headers: Record<string, string>; rawBody: string; result: NotificationResult } {
  const rawBody = notificationBody(options.key ?? CURRENT.key, spec);
  const headers = signedHeaders(options.by ?? publicKey, rawBody, options.at ?? NOW);
  return { headers, rawBody, result: verifyAndDecrypt(deps, { headers, rawBody }) };
}

const PAID: NotificationSpec = {
  id: "EV-0001",
  eventType: "TRANSACTION.SUCCESS",
  resource: transactionResource(),
};

describe("通过的通知", () => {
  it("支付成功通知：给出通知 id、事件类型、归一的交易、实际所用的密钥版本与序列号", () => {
    const { result } = deliver(PAID);
    expect(result).toMatchObject({
      ok: true,
      id: "EV-0001",
      eventType: "TRANSACTION.SUCCESS",
      serial: publicKey.serial,
      kid: "v2",
      notification: {
        kind: "transaction",
        id: "EV-0001",
        transaction: {
          outTradeNo: "FK20261004000001a1b2",
          tradeState: "SUCCESS",
          transactionId: "4200000000202610040000000001",
          amountFen: 19900,
          payerOpenid: "o-test-openid-0001",
          attach: "v1.e.o.N.r.12",
          successAt: new Date("2026-10-04T02:00:00.000Z"),
        },
      },
    });
    if (!result.ok) return;
    expect(result.resourceCipher).toMatchObject({
      algorithm: "AEAD_AES_256_GCM",
      original_type: "transaction",
    });
    expect(result.resource.bank_type).toBe("OTHERS");
  });

  it("摘要不含 openid：任何层级都没有 openid 与 payer", () => {
    const { result } = deliver(PAID);
    if (!result.ok) throw new Error(result.detail);
    expect(result.summary).toEqual({
      serial: publicKey.serial,
      outTradeNo: "FK20261004000001a1b2",
      transactionId: "4200000000202610040000000001",
      state: "SUCCESS",
      amountFen: 19900,
      successAt: "2026-10-04T02:00:00.000Z",
    });
    expect(JSON.stringify(result.summary)).not.toMatch(/openid|payer/i);
  });

  it.each([
    ["REFUND.SUCCESS", "SUCCESS", "2026-10-04T03:00:00.000Z"],
    ["REFUND.ABNORMAL", "ABNORMAL", undefined],
    ["REFUND.CLOSED", "CLOSED", undefined],
  ] as const)("退款通知 %s", (eventType, status, successAt) => {
    const resource = refundResource({
      refund_status: status,
      success_time: successAt ? "2026-10-04T11:00:00+08:00" : undefined,
    });
    const { result } = deliver({ id: `EV-${status}`, eventType, resource });
    expect(result).toMatchObject({
      ok: true,
      eventType,
      notification: {
        kind: "refund",
        id: `EV-${status}`,
        refund: {
          outRefundNo: "TK20261004000001",
          outTradeNo: "FK20261004000001a1b2",
          refundId: "50000000002026100400000000001",
          status,
          refundFen: 19900,
        },
      },
      summary: { outRefundNo: "TK20261004000001", state: status, amountFen: 19900, successAt },
    });
  });

  it("两种序列号：公钥 ID 用微信支付公钥，其余用平台证书", () => {
    expect(deps.verifiers.lookup(publicKey.serial)?.kind).toBe("public-key");
    expect(deps.verifiers.lookup(certificate.serial)?.kind).toBe("certificate");
    expect(deliver(PAID).result).toMatchObject({ ok: true, serial: publicKey.serial });
    expect(deliver(PAID, { by: certificate }).result).toMatchObject({
      ok: true,
      serial: certificate.serial,
    });
  });

  it("请求头名字不分大小写；请求体给原始字节与给文本一样", () => {
    const { headers, rawBody } = deliver(PAID);
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(verifyAndDecrypt(deps, { headers: lower, rawBody: Buffer.from(rawBody) })).toMatchObject(
      {
        ok: true,
        id: "EV-0001",
      },
    );
  });

  it("登记清单外的事件类型：验签解密通过，没有归一的内容", () => {
    const { result } = deliver({
      id: "EV-OTHER",
      eventType: "PAYSCORE.USER_OPEN_SERVICE",
      resource: { mchid: "1900000109" },
    });
    expect(result).toMatchObject({
      ok: true,
      eventType: "PAYSCORE.USER_OPEN_SERVICE",
      notification: null,
      summary: null,
    });
  });
});

describe("两把 APIv3 密钥并存", () => {
  it("返回实际所用的 kid；按指定 kid 能重新解开旧密文", () => {
    const withCurrent = deliver(PAID).result;
    const withPrevious = deliver(PAID, { key: PREVIOUS.key }).result;
    expect(withCurrent).toMatchObject({ ok: true, kid: "v2" });
    expect(withPrevious).toMatchObject({ ok: true, kid: "v1" });
    if (!withPrevious.ok) return;
    // 重处理：收件行里存着 resourceCipher 与 key_version，按它指定密钥重新解密
    const reopened = deps.keyring.decrypt(withPrevious.resourceCipher, "v1");
    expect(JSON.parse(reopened?.plaintext ?? "null")).toEqual(withPrevious.resource);
    expect(deps.keyring.decrypt(withPrevious.resourceCipher, "v2")).toBeNull();
    expect(deps.keyring.decrypt(withPrevious.resourceCipher, "v9")).toBeNull();
  });

  it("密钥环：不是 32 个字节、两把同名，建不起来", () => {
    expect(() => createApiV3Keyring({ kid: "v1", key: "short" })).toThrow(/32 个字节/);
    expect(() => createApiV3Keyring(CURRENT, { ...PREVIOUS, kid: "v2" })).toThrow(/kid 相同/);
  });
});

describe("没有通过的通知", () => {
  it("探测签名：验签失败，并标记为探测", () => {
    const { headers, rawBody } = deliver(PAID);
    const probe = `WECHATPAY/SIGNTEST/${headers["Wechatpay-Signature"]}`;
    const result = verifyAndDecrypt(deps, {
      headers: { ...headers, "Wechatpay-Signature": probe },
      rawBody,
    });
    expect(result).toMatchObject({ ok: false, kind: "signature_invalid", probe: true });
  });

  it("签名对不上：请求体、时间戳、随机串改动任一处，或换了一把私钥签", () => {
    const { headers, rawBody } = deliver(PAID);
    const stranger = generateIdentity(publicKey.serial);
    const cases = [
      { headers, rawBody: rawBody.replace("EV-0001", "EV-0002") },
      { headers: { ...headers, "Wechatpay-Timestamp": "1791079201" }, rawBody },
      { headers: { ...headers, "Wechatpay-Nonce": "another-nonce" }, rawBody },
      { headers: signedHeaders(stranger, rawBody, NOW), rawBody },
      { headers: { ...headers, "Wechatpay-Signature": "不是 base64" }, rawBody },
    ];
    for (const input of cases) {
      expect(verifyAndDecrypt(deps, input)).toMatchObject({
        ok: false,
        kind: "signature_invalid",
        probe: false,
      });
    }
  });

  it("把请求体解析后再序列化的字节送去验签：失败", () => {
    const pretty = JSON.stringify(JSON.parse(notificationBody(CURRENT.key, PAID)), null, 2);
    const headers = signedHeaders(publicKey, pretty, NOW);
    expect(verifyAndDecrypt(deps, { headers, rawBody: pretty })).toMatchObject({ ok: true });
    const reserialized = JSON.stringify(JSON.parse(pretty));
    expect(JSON.parse(reserialized)).toEqual(JSON.parse(pretty));
    expect(verifyAndDecrypt(deps, { headers, rawBody: reserialized })).toMatchObject({
      ok: false,
      kind: "signature_invalid",
    });
  });

  it("四个请求头缺任何一个：验签失败", () => {
    const { headers, rawBody } = deliver(PAID);
    for (const name of Object.keys(headers)) {
      const partial = { ...headers, [name]: undefined };
      expect(verifyAndDecrypt(deps, { headers: partial, rawBody })).toMatchObject({
        ok: false,
        kind: "signature_invalid",
      });
    }
  });

  it("时间戳与本机相差超过 5 分钟：拒绝；正好 5 分钟：通过", () => {
    const shifted = (ms: number) => deliver(PAID, { at: new Date(NOW.getTime() + ms) }).result;
    expect(shifted(-5 * 60_000)).toMatchObject({ ok: true });
    expect(shifted(5 * 60_000)).toMatchObject({ ok: true });
    expect(shifted(-5 * 60_000 - 1000)).toMatchObject({ ok: false, kind: "timestamp_skewed" });
    expect(shifted(5 * 60_000 + 1000)).toMatchObject({ ok: false, kind: "timestamp_skewed" });
  });

  it("未知序列号：单独一种结果", () => {
    const unknownKey = generateIdentity("PUB_KEY_ID_0000000000000000000000000000000099");
    const unknownCert = generateCertificateIdentity();
    for (const by of [unknownKey, unknownCert]) {
      expect(deliver(PAID, { by }).result).toMatchObject({ ok: false, kind: "key_not_found" });
    }
  });

  it("验签通过但解密失败：密钥不在密钥环里，或密文被换过", () => {
    expect(deliver(PAID, { key: testApiV3Key("stranger") }).result).toMatchObject({
      ok: false,
      kind: "decrypt_failed",
    });
    const outer = JSON.parse(notificationBody(CURRENT.key, PAID)) as {
      resource: { associated_data: string };
    };
    outer.resource.associated_data = "refund";
    const rawBody = JSON.stringify(outer);
    const headers = signedHeaders(publicKey, rawBody, NOW);
    expect(verifyAndDecrypt(deps, { headers, rawBody })).toMatchObject({
      ok: false,
      kind: "decrypt_failed",
    });
  });

  it("报文不全：缺 id、缺 resource、算法不认识、外层不是 JSON", () => {
    const outer = JSON.parse(notificationBody(CURRENT.key, PAID)) as Record<string, unknown>;
    const bodies = [
      JSON.stringify({ ...outer, id: undefined }),
      JSON.stringify({ ...outer, id: "" }),
      JSON.stringify({ ...outer, event_type: undefined }),
      JSON.stringify({ ...outer, resource: undefined }),
      JSON.stringify({ ...outer, resource: { ...(outer.resource as object), algorithm: "AES" } }),
      "不是 JSON",
      "[]",
    ];
    for (const rawBody of bodies) {
      const headers = signedHeaders(publicKey, rawBody, NOW);
      expect(verifyAndDecrypt(deps, { headers, rawBody })).toMatchObject({
        ok: false,
        kind: "payload_invalid",
      });
    }
  });

  it.each([
    ["支付通知缺商户单号", "TRANSACTION.SUCCESS", transactionResource({ out_trade_no: undefined })],
    [
      "支付通知缺微信单号",
      "TRANSACTION.SUCCESS",
      transactionResource({ transaction_id: undefined }),
    ],
    ["支付通知缺付款人", "TRANSACTION.SUCCESS", transactionResource({ payer: {} })],
    ["支付通知缺成功时间", "TRANSACTION.SUCCESS", transactionResource({ success_time: undefined })],
    ["支付通知缺商户号", "TRANSACTION.SUCCESS", transactionResource({ mchid: undefined })],
    ["支付通知缺 appid", "TRANSACTION.SUCCESS", transactionResource({ appid: undefined })],
    [
      "支付通知金额是小数",
      "TRANSACTION.SUCCESS",
      transactionResource({ amount: { total: 199.5 } }),
    ],
    ["支付通知金额是 0", "TRANSACTION.SUCCESS", transactionResource({ amount: { total: 0 } })],
    [
      "支付通知金额是字符串",
      "TRANSACTION.SUCCESS",
      transactionResource({ amount: { total: "19900" } }),
    ],
    ["支付通知状态不认识", "TRANSACTION.SUCCESS", transactionResource({ trade_state: "DONE" })],
    ["支付通知时间写错", "TRANSACTION.SUCCESS", transactionResource({ success_time: "昨天" })],
    ["退款通知缺退款单号", "REFUND.SUCCESS", refundResource({ out_refund_no: undefined })],
    ["退款通知缺微信退款单号", "REFUND.SUCCESS", refundResource({ refund_id: undefined })],
    ["退款通知缺微信单号", "REFUND.SUCCESS", refundResource({ transaction_id: undefined })],
    ["退款通知缺订单金额", "REFUND.SUCCESS", refundResource({ amount: { refund: 100 } })],
    ["退款通知状态不认识", "REFUND.CLOSED", refundResource({ refund_status: "DONE" })],
    ["解密后不是对象", "TRANSACTION.SUCCESS", [1, 2]],
  ])("解密后缺必需字段 · %s", (_name, eventType, resource) => {
    expect(deliver({ id: "EV-BAD", eventType, resource }).result).toMatchObject({
      ok: false,
      kind: "payload_invalid",
    });
  });

  it("失败的结果里没有请求体、签名与密钥", () => {
    const { headers, rawBody } = deliver(PAID);
    const broken = { ...headers, "Wechatpay-Signature": headers["Wechatpay-Signature"]?.slice(4) };
    const failure = JSON.stringify(verifyAndDecrypt(deps, { headers: broken, rawBody }));
    for (const secret of [
      CURRENT.key,
      "o-test-openid-0001",
      "ciphertext",
      broken["Wechatpay-Signature"] ?? "?",
    ]) {
      expect(failure).not.toContain(secret);
    }
  });
});

describe("验签身份表", () => {
  it("公钥 ID 配了证书、证书序列号配了公钥、序列号与证书不一致：建不起来，报错不带密钥内容", () => {
    const wrong = [
      { serial: publicKey.serial, pem: certificate.certificatePem },
      { serial: certificate.serial, pem: publicKey.publicKeyPem },
      { serial: "00FF", pem: certificate.certificatePem },
    ];
    for (const entry of wrong) {
      expect(() => createVerifierTable([entry])).toThrow(/^验签身份 [0-9A-Z_]+：/);
    }
  });
});
