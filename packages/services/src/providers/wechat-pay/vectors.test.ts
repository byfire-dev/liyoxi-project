import { createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { testApiV3Key } from "./__fixtures__/wechatpay-server.js";
import { aeadDecrypt, createApiV3Keyring, createVerifierTable } from "./keyring.js";
import { verifyAndDecrypt } from "./notification.js";
import {
  authorizationHeader,
  miniProgramPaySignMessage,
  requestSignMessage,
  responseSignMessage,
  rsaVerify,
} from "./sign.js";

// 官方示例向量（X-04 任务书 第 7 节第 1 条）。三处来源，各文件头写明出处：
//   __fixtures__/official-docs.json   官方文档里给全了输入与输出的示例
//   __fixtures__/official-sdk.json    官方 Go SDK 仓库自带的测试向量
//   __fixtures__/cross-check.json     pnpm wxpay:vectors 用官方 Go SDK 现场产出的核对结果
// 这里不连网、不用 Docker：只拿入库的公钥、输入、签名、密文再核一遍。

const load = <T>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dirname, "__fixtures__", name), "utf8")) as T;

interface OfficialDocs {
  merchantTestPublicKeyPem: string;
  requestSign: Array<{
    name: string;
    source: string;
    method: string;
    pathWithQuery: string;
    timestamp: string;
    nonce: string;
    body: string;
    message: string;
    signature: string;
    mchid?: string;
    serialNo?: string;
    authorization?: string;
  }>;
  miniProgramPaySign: {
    source: string;
    appId: string;
    timeStamp: string;
    nonceStr: string;
    prepayId: string;
    message: string;
    signature: string;
  };
  responseVerify: Array<{
    name: string;
    source: string;
    expect: "pass" | "message-only";
    serial: string;
    timestamp: string;
    nonce: string;
    body: string;
    message: string;
    signature: string;
    publicKeyPem: string;
  }>;
  probeSignature: { source: string; value: string };
}

interface OfficialSdk {
  goNotification: {
    source: string;
    certificatePem: string;
    serial: string;
    timestamp: string;
    nonce: string;
    signature: string;
    body: string;
    id: string;
  };
}

interface Delivery {
  name: string;
  headers: Record<string, string>;
  body: string;
}

interface CrossCheck {
  tools: { sdk: string; go: string; image: string };
  serials: { merchant: string; wechatPay: string };
  publicKeys: { merchant: string; wechatPay: string };
  apiV3KeyTag: string;
  sign: Array<{
    name: string;
    by: "merchant" | "wechatPay";
    message: string;
    signature: string;
    sdkSignatureEqualsOurs: boolean;
    sdkVerifiesOurs: boolean;
    sdkRejectsTampered: boolean;
  }>;
  seal: Array<{
    name: string;
    plaintext: string;
    associatedData: string;
    nonce: string;
    ciphertext: string;
    sdkPlaintextEquals: boolean;
    ourPlaintextEquals: boolean;
  }>;
  notifications: Array<Delivery & { sdkAccepted: boolean; sameResult: boolean; plaintext: string }>;
  sdkSigned: Array<Delivery & { id: string }>;
  officialDocs: Array<{ name: string; ourSignatureEqualsDocument: boolean }>;
  officialJavaAead: { source: string; ourPlaintextEquals: boolean };
}

const docs = load<OfficialDocs>("official-docs.json");
const sdk = load<OfficialSdk>("official-sdk.json");
const cross = load<CrossCheck>("cross-check.json");

/** 把字符串的第 index 个字符换成另一个字符 */
const flip = (text: string, index: number): string =>
  `${text.slice(0, index)}${text[index] === "A" ? "B" : "A"}${text.slice(index + 1)}`;

describe("官方文档的示例：签名串逐字节一致", () => {
  const merchantKey = createPublicKey(docs.merchantTestPublicKeyPem);

  it.each(docs.requestSign)("请求签名串 · $name", (vector) => {
    expect(vector.source).toMatch(/^.+https:\/\/pay\.weixin\.qq\.com\/doc\/v3\/merchant\/\d+/);
    const message = requestSignMessage(vector);
    expect(message).toBe(vector.message);
    // 文档给的签名值是用它公开的测试私钥对这个签名串算的：本实现构造的串能通过它的验签
    expect(rsaVerify(message, vector.signature, merchantKey)).toBe(true);
    expect(rsaVerify(`${message} `, vector.signature, merchantKey)).toBe(false);
    if (vector.authorization && vector.mchid && vector.serialNo) {
      expect(
        authorizationHeader({ ...vector, mchid: vector.mchid, serialNo: vector.serialNo }),
      ).toBe(vector.authorization);
    }
  });

  it("调起支付签名串", () => {
    const vector = docs.miniProgramPaySign;
    const message = miniProgramPaySignMessage(vector);
    expect(message).toBe(vector.message);
    expect(rsaVerify(message, vector.signature, merchantKey)).toBe(true);
    expect(
      rsaVerify(message.replace("prepay_id=", "prepay_id= "), vector.signature, merchantKey),
    ).toBe(false);
  });

  it.each(docs.responseVerify)("应答与回调的验签串 · $name", (vector) => {
    const message = responseSignMessage(vector.timestamp, vector.nonce, Buffer.from(vector.body));
    expect(message.toString("utf8")).toBe(vector.message);
    const verified = rsaVerify(message, vector.signature, createPublicKey(vector.publicKeyPem));
    // message-only 的那一份：文档给的公钥与签名对不上（见向量文件里的 note），只核对验签串
    expect(verified).toBe(vector.expect === "pass");
  });

  it("文档给的应答示例：改动任一字节即验签失败", () => {
    const vector = docs.responseVerify.find((entry) => entry.expect === "pass");
    if (!vector) throw new Error("向量文件里没有能验签的应答示例");
    const key = createPublicKey(vector.publicKeyPem);
    const verify = (timestamp: string, nonce: string, body: string, signature: string) =>
      rsaVerify(responseSignMessage(timestamp, nonce, Buffer.from(body)), signature, key);
    const { timestamp, nonce, body, signature } = vector;
    expect(verify(timestamp, nonce, body, signature)).toBe(true);
    expect(verify(flip(timestamp, 9), nonce, body, signature)).toBe(false);
    expect(verify(timestamp, flip(nonce, 0), body, signature)).toBe(false);
    for (let index = 0; index < body.length; index += 1) {
      expect(verify(timestamp, nonce, flip(body, index), signature)).toBe(false);
    }
    for (const index of [0, 100, 200, 300]) {
      expect(verify(timestamp, nonce, body, flip(signature, index))).toBe(false);
    }
  });

  it("文档给的探测签名：验签失败", () => {
    const vector = docs.responseVerify[0];
    if (!vector) throw new Error("向量文件里没有应答示例");
    expect(docs.probeSignature.value.startsWith("WECHATPAY/SIGNTEST/")).toBe(true);
    const message = responseSignMessage(vector.timestamp, vector.nonce, Buffer.from(vector.body));
    expect(
      rsaVerify(message, docs.probeSignature.value, createPublicKey(vector.publicKeyPem)),
    ).toBe(false);
  });
});

describe("官方 Go SDK 自带的通知向量：按证书序列号选平台证书验签", () => {
  const vector = sdk.goNotification;
  const headers = {
    "Wechatpay-Timestamp": vector.timestamp,
    "Wechatpay-Nonce": vector.nonce,
    "Wechatpay-Serial": vector.serial,
    "Wechatpay-Signature": vector.signature,
  };
  const deps = {
    verifiers: createVerifierTable([{ serial: vector.serial, pem: vector.certificatePem }]),
    keyring: createApiV3Keyring({ kid: "v1", key: testApiV3Key("other") }),
    now: () => new Date(Number(vector.timestamp) * 1000),
  };

  it("出处写明了 SDK 的名称与版本", () => {
    expect(vector.source).toMatch(/wechatpay-go v\d+\.\d+\.\d+/);
  });

  it("官方实现签出的签名，本实现验签通过（走到解密才停：这条向量的密钥不是 32 个字节）", () => {
    expect(deps.verifiers.lookup(vector.serial)?.kind).toBe("certificate");
    const result = verifyAndDecrypt(deps, { headers, rawBody: vector.body });
    expect(result).toMatchObject({ ok: false, kind: "decrypt_failed", probe: false });
  });

  it("改动请求体、时间戳、随机串任一处即验签失败", () => {
    const tampered = [
      { headers, rawBody: vector.body.replace("签约成功", "签约失败") },
      {
        headers: { ...headers, "Wechatpay-Timestamp": flip(vector.timestamp, 9) },
        rawBody: vector.body,
      },
      { headers: { ...headers, "Wechatpay-Nonce": flip(vector.nonce, 0) }, rawBody: vector.body },
    ];
    for (const input of tampered) {
      expect(verifyAndDecrypt(deps, input)).toMatchObject({ ok: false, kind: "signature_invalid" });
    }
  });

  it("把请求体解析后再序列化的字节送去验签：失败", () => {
    const reserialized = JSON.stringify(JSON.parse(vector.body), null, 1);
    expect(verifyAndDecrypt(deps, { headers, rawBody: reserialized })).toMatchObject({
      ok: false,
      kind: "signature_invalid",
    });
  });
});

describe("跨实现核对的产物 cross-check.json", () => {
  const keys = {
    merchant: createPublicKey(cross.publicKeys.merchant),
    wechatPay: createPublicKey(cross.publicKeys.wechatPay),
  };
  const apiV3Key = testApiV3Key(cross.apiV3KeyTag);

  it("写明了官方 SDK 的名称、版本与容器镜像；文件里没有私钥", () => {
    expect(cross.tools.sdk).toMatch(/^github\.com\/wechatpay-apiv3\/wechatpay-go v\d+\.\d+\.\d+$/);
    expect(cross.tools.image).toMatch(/^golang@sha256:[0-9a-f]{64}$/);
    const raw = readFileSync(join(import.meta.dirname, "__fixtures__", "cross-check.json"), "utf8");
    expect(raw).not.toMatch(/PRIVATE KEY/);
    expect(raw).not.toContain(apiV3Key);
  });

  it.each(cross.sign)("签名 · $name：与官方 SDK 逐字节相等，官方验签器接受", (entry) => {
    expect(entry).toMatchObject({
      sdkSignatureEqualsOurs: true,
      sdkVerifiesOurs: true,
      sdkRejectsTampered: true,
    });
    // 入库的签名用入库的公钥再验一遍；改动签名串任一处即失败
    expect(rsaVerify(entry.message, entry.signature, keys[entry.by])).toBe(true);
    expect(rsaVerify(flip(entry.message, 0), entry.signature, keys[entry.by])).toBe(false);
    expect(
      rsaVerify(
        entry.message,
        entry.signature,
        keys[entry.by === "merchant" ? "wechatPay" : "merchant"],
      ),
    ).toBe(false);
  });

  it.each(cross.seal)("解密 · $name：官方 SDK 与本实现解出同一明文", (entry) => {
    expect(entry).toMatchObject({ sdkPlaintextEquals: true, ourPlaintextEquals: true });
    const resource = {
      algorithm: "AEAD_AES_256_GCM",
      ciphertext: entry.ciphertext,
      nonce: entry.nonce,
      associated_data: entry.associatedData,
    };
    expect(aeadDecrypt(Buffer.from(apiV3Key), resource)).toBe(entry.plaintext);
    expect(
      aeadDecrypt(Buffer.from(apiV3Key), { ...resource, ciphertext: flip(entry.ciphertext, 3) }),
    ).toBeNull();
    expect(aeadDecrypt(Buffer.from(testApiV3Key("other")), resource)).toBeNull();
  });

  const deps = (at: string) => ({
    verifiers: createVerifierTable([
      { serial: cross.serials.wechatPay, pem: cross.publicKeys.wechatPay },
    ]),
    keyring: createApiV3Keyring({ kid: "v1", key: apiV3Key }),
    now: () => new Date(Number(at) * 1000),
  });

  it.each(cross.notifications)("通知 · $name：官方 SDK 接受，结果与本实现一致", (entry) => {
    expect(entry).toMatchObject({ sdkAccepted: true, sameResult: true });
    const at = entry.headers["Wechatpay-Timestamp"] ?? "";
    const result = verifyAndDecrypt(deps(at), { headers: entry.headers, rawBody: entry.body });
    if (!result.ok) throw new Error(result.detail);
    expect(JSON.stringify(result.resource)).toBe(entry.plaintext);
  });

  it.each(cross.sdkSigned)("通知 · $name：官方实现签出的签名，本实现验签解密通过", (entry) => {
    const at = entry.headers["Wechatpay-Timestamp"] ?? "";
    const input = { headers: entry.headers, rawBody: entry.body };
    expect(verifyAndDecrypt(deps(at), input)).toMatchObject({ ok: true, id: entry.id });
    expect(verifyAndDecrypt(deps(at), { ...input, rawBody: `${entry.body} ` })).toMatchObject({
      ok: false,
      kind: "signature_invalid",
    });
  });

  it("官方文档与官方 Java SDK 的示例：现场核对的结果都是一致", () => {
    expect(cross.officialDocs.length).toBeGreaterThanOrEqual(3);
    for (const entry of cross.officialDocs)
      expect(entry.ourSignatureEqualsDocument, entry.name).toBe(true);
    expect(cross.officialJavaAead.source).toMatch(/wechatpay-java\/v\d+\.\d+\.\d+\//);
    expect(cross.officialJavaAead.ourPlaintextEquals).toBe(true);
  });
});
