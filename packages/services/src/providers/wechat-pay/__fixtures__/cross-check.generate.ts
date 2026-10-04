// pnpm wxpay:vectors：跨实现核对，产出 cross-check.json（X-04 任务书 第 7 节第 2 条、第 11 节第 1 项）。
//
// 做三件事：
//   1. 现场生成两对临时 RSA 密钥（商户、微信支付），用本实现构造签名串并签名；在一次性容器里用官方 Go SDK
//      对同一批输入签名、验签、解密、解析通知（crosscheck/main.go），逐项比对。
//   2. 从官方文档现场取那把公开的测试商户私钥，核对“本实现签出的结果与文档给的签名值逐字节相等”。
//   3. 从官方 Java SDK 仓库现场取它自带的加密向量，核对本实现解出同一明文。
// 临时私钥只写进系统临时目录里的一个文件（给容器读），跑完即删；文档与 SDK 的测试私钥、测试密钥只在内存里用。
// cross-check.json 里没有任何私钥与密钥。要本机有 Docker、能连外网；不进 CI。
// 它借 Vitest 来跑（仓库的 TypeScript 源码用 .js 后缀互相引用，Node 自带的类型擦除加载不了）。

import { execFileSync } from "node:child_process";
import { createPrivateKey } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { format, resolveConfig } from "prettier";
import { expect, it } from "vitest";

import { aeadDecrypt, createApiV3Keyring, createVerifierTable } from "../keyring.js";
import { verifyAndDecrypt } from "../notification.js";
import {
  miniProgramPaySignMessage,
  requestSignMessage,
  responseSignMessage,
  rsaSign,
  rsaVerify,
} from "../sign.js";
import {
  generateIdentity,
  notificationBody,
  refundResource,
  signedHeaders,
  testApiV3Key,
  transactionResource,
} from "./wechatpay-server.js";

/** 官方 Go 镜像（Docker Official Image），按摘要钉死：golang:1.25-alpine，取于 2026-10-05 */
const GO_IMAGE = "golang@sha256:1ae0735f00daffa3aaf1363a5184c0d2dc55c78e3db4ec70241cdac97bf84b59";
const DOC = "https://pay.weixin.qq.com/doc/v3/merchant";
const JAVA_SDK =
  "https://raw.githubusercontent.com/wechatpay-apiv3/wechatpay-java/v0.2.17/core/src/test/java/com/wechat/pay/java/core";
const HERE = import.meta.dirname;
const KEY_TAG = "crosscheck";

interface Delivery {
  name: string;
  headers: Record<string, string>;
  body: string;
}

interface SdkOutput {
  sdk: string;
  go: string;
  sign: Array<{
    name: string;
    sdkSignature: string;
    sdkVerifiesOurs: boolean;
    sdkRejectsTampered: boolean;
  }>;
  seal: Array<{ name: string; ciphertext: string; sdkPlaintext: string }>;
  notifications: Array<{
    name: string;
    sdkAccepted: boolean;
    sdkError?: string;
    id?: string;
    eventType?: string;
    sdkPlaintext?: string;
  }>;
  signed: Delivery[];
}

/** 取一份公开的官方资料。用 curl：这台机器上 Node 的 fetch 只试 IPv6，连 GitHub 会超时。-q 不读 ~/.curlrc */
function fetchText(url: string): string {
  const args = ["-q", "--fail", "--silent", "--show-error", "--location", "--max-time", "60", url];
  return execFileSync("curl", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

const pick = (text: string, pattern: RegExp, what: string): string => {
  const found = pattern.exec(text)?.[1];
  if (found === undefined) throw new Error(`官方资料里没找到${what}，格式可能变了`);
  return found;
};

/** 在一次性容器里跑官方 Go SDK。输入里有临时私钥：只放在系统临时目录，跑完即删 */
function runOfficialSdk(input: unknown): SdkOutput {
  const work = mkdtempSync(join(tmpdir(), "lyx-wxpay-crosscheck-"));
  try {
    writeFileSync(join(work, "in.json"), JSON.stringify(input), { mode: 0o600 });
    execFileSync(
      "docker",
      [
        "run",
        "--rm",
        ...["-v", `${join(HERE, "crosscheck")}:/src:ro`, "-v", `${work}:/work`, "-w", "/src"],
        ...[
          "-e",
          "GOFLAGS=-mod=readonly",
          "-e",
          "GOCACHE=/tmp/go-build",
          "-e",
          "GOMODCACHE=/tmp/go-mod",
        ],
        GO_IMAGE,
        ...["go", "run", ".", "/work/in.json", "/work/out.json"],
      ],
      // docker 命令行缺省会读家目录下的登录凭据；镜像按摘要取公开镜像，用不着，指到一个空目录
      { env: { ...process.env, DOCKER_CONFIG: work }, stdio: ["ignore", "inherit", "inherit"] },
    );
    return JSON.parse(readFileSync(join(work, "out.json"), "utf8")) as SdkOutput;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

it("跨实现核对：官方 Go SDK、官方文档、官方 Java SDK 的向量", async () => {
  const merchant = generateIdentity("LYXTESTMCHCERTSERIAL0001");
  const wechatPay = generateIdentity("PUB_KEY_ID_0000000000000000000000000000000001");
  const apiV3Key = testApiV3Key(KEY_TAG);
  const now = new Date();
  const jsapiBody = JSON.stringify({
    appid: "wx0000000000000000",
    mchid: "1900000109",
    description: "狸有戏·标准版套餐（12 个月）",
    out_trade_no: "FK20261004000001a1b2",
    notify_url: "https://api.example.invalid/api/v1/hooks/wechatpay/transactions",
    amount: { total: 19900, currency: "CNY" },
    payer: { openid: "o-test-openid-0001" },
  });
  const request = (method: string, pathWithQuery: string, body: string) =>
    requestSignMessage({
      method,
      pathWithQuery,
      timestamp: "1791000000",
      nonce: "593BEC0C930BF1AFEB40B4A08C8FB242",
      body,
    });
  const merchantMessages: Array<[string, string]> = [
    ["请求签名：JSAPI 下单", request("POST", "/v3/pay/transactions/jsapi", jsapiBody)],
    [
      "请求签名：查单（带查询串）",
      request("GET", "/v3/pay/transactions/out-trade-no/FK20261004000001a1b2?mchid=1900000109", ""),
    ],
    [
      "请求签名：关单",
      request(
        "POST",
        "/v3/pay/transactions/out-trade-no/FK20261004000001a1b2/close",
        '{"mchid":"1900000109"}',
      ),
    ],
    [
      "请求签名：申请交易账单",
      request("GET", "/v3/bill/tradebill?bill_date=2026-10-03&bill_type=ALL", ""),
    ],
    [
      "调起支付签名",
      miniProgramPaySignMessage({
        appId: "wx0000000000000000",
        timeStamp: "1791000000",
        nonceStr: "593BEC0C930BF1AFEB40B4A08C8FB242",
        prepayId: "wx201410272009395522657a690389285100",
      }),
    ],
  ];
  const responseBody = '{"prepay_id":"wx201410272009395522657a690389285100"}';
  const platformMessages: Array<[string, string]> = [
    [
      "应答验签串：下单应答",
      responseSignMessage("1791000000", "d824f2e086d3c1df", Buffer.from(responseBody)).toString(),
    ],
    [
      "应答验签串：空应答（204）",
      responseSignMessage("1791000000", "n", Buffer.alloc(0)).toString(),
    ],
  ];
  const signCases = [
    ...merchantMessages.map(([name, message]) => ({ name, by: "merchant", message })),
    ...platformMessages.map(([name, message]) => ({ name, by: "wechatPay", message })),
  ].map((entry) => ({
    ...entry,
    ourSignature: rsaSign(
      entry.message,
      (entry.by === "merchant" ? merchant : wechatPay).privateKey,
    ),
  }));

  const sealCases = [
    {
      name: "支付通知的资源",
      plaintext: JSON.stringify(transactionResource()),
      aad: "transaction",
    },
    { name: "退款通知的资源", plaintext: JSON.stringify(refundResource()), aad: "refund" },
    { name: "中文与空关联数据", plaintext: "狸有戏：定点解析，不经浮点。", aad: "" },
  ].map(({ name, plaintext, aad }, index) => ({
    name,
    plaintext,
    associatedData: aad,
    nonce: `lyxnonce000${index}`,
  }));

  const specs = [
    { id: "EV-CROSS-0001", eventType: "TRANSACTION.SUCCESS", resource: transactionResource() },
    { id: "EV-CROSS-0002", eventType: "REFUND.SUCCESS", resource: refundResource() },
    {
      id: "EV-CROSS-0003",
      eventType: "REFUND.ABNORMAL",
      resource: refundResource({ refund_status: "ABNORMAL", success_time: undefined }),
    },
    {
      id: "EV-CROSS-0004",
      eventType: "REFUND.CLOSED",
      resource: refundResource({ refund_status: "CLOSED", success_time: undefined }),
    },
  ];
  const deliveries: Delivery[] = specs.map((spec) => {
    const body = notificationBody(apiV3Key, spec);
    return {
      name: `${spec.eventType}（本仓库用例的支架造）`,
      headers: signedHeaders(wechatPay, body, now),
      body,
    };
  });
  const toSign: Delivery[] = specs.slice(0, 2).map((spec, index) => ({
    name: `${spec.eventType}（官方 SDK 签名）`,
    headers: {
      "Wechatpay-Timestamp": String(Math.floor(now.getTime() / 1000)),
      "Wechatpay-Nonce": `sdk-signed-${index}`,
    },
    body: notificationBody(apiV3Key, spec),
  }));

  const sdk = runOfficialSdk({
    merchant: { ...merchant, privateKey: undefined },
    wechatPay: { ...wechatPay, privateKey: undefined },
    apiV3Key,
    signCases,
    sealCases,
    notifications: deliveries,
    toSign,
  });

  const deps = {
    verifiers: createVerifierTable([{ serial: wechatPay.serial, pem: wechatPay.publicKeyPem }]),
    keyring: createApiV3Keyring({ kid: KEY_TAG, key: apiV3Key }),
    now: () => now,
  };
  const sign = signCases.map((entry, index) => {
    const result = sdk.sign[index];
    return {
      name: entry.name,
      by: entry.by,
      message: entry.message,
      signature: entry.ourSignature,
      sdkSignatureEqualsOurs: result?.sdkSignature === entry.ourSignature,
      sdkVerifiesOurs: result?.sdkVerifiesOurs === true,
      sdkRejectsTampered: result?.sdkRejectsTampered === true,
    };
  });
  const seal = sealCases.map((entry, index) => {
    const ciphertext = sdk.seal[index]?.ciphertext ?? "";
    const cipher = { algorithm: "AEAD_AES_256_GCM", ciphertext, nonce: entry.nonce };
    const ours = aeadDecrypt(Buffer.from(apiV3Key), {
      ...cipher,
      associated_data: entry.associatedData,
    });
    return {
      ...entry,
      ciphertext,
      sdkPlaintextEquals: sdk.seal[index]?.sdkPlaintext === entry.plaintext,
      ourPlaintextEquals: ours === entry.plaintext,
    };
  });
  const notifications = deliveries.map((delivery, index) => {
    const official = sdk.notifications[index];
    const ours = verifyAndDecrypt(deps, { headers: delivery.headers, rawBody: delivery.body });
    return {
      ...delivery,
      sdkAccepted: official?.sdkAccepted === true,
      ourAccepted: ours.ok,
      id: official?.id,
      eventType: official?.eventType,
      plaintext: official?.sdkPlaintext,
      sameResult:
        ours.ok &&
        ours.id === official?.id &&
        ours.eventType === official.eventType &&
        JSON.stringify(ours.resource) === official.sdkPlaintext,
    };
  });
  const sdkSigned = sdk.signed.map((delivery) => {
    const ours = verifyAndDecrypt(deps, { headers: delivery.headers, rawBody: delivery.body });
    return { ...delivery, ourAccepted: ours.ok, id: ours.ok ? ours.id : undefined };
  });

  // 官方文档的测试商户私钥：现场取，只在内存里用
  const bodyDoc = fetchText(`${DOC}/4012365336.md`);
  const docKey = createPrivateKey(
    pick(bodyDoc, /(-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----)/, "测试商户私钥"),
  );
  const official = JSON.parse(readFileSync(join(HERE, "official-docs.json"), "utf8")) as {
    requestSign: Array<{ name: string; message: string; signature: string }>;
    miniProgramPaySign: { message: string; signature: string };
  };
  const officialDocs = [
    ...official.requestSign,
    { name: "小程序调起支付签名", ...official.miniProgramPaySign },
  ].map(({ name, message, signature }) => ({
    name,
    ourSignatureEqualsDocument: rsaSign(message, docKey) === signature,
  }));

  // 官方 Java SDK 自带的加密向量：现场取。它的测试密钥形似真密钥，不入库
  const javaTest = fetchText(`${JAVA_SDK}/cipher/AeadAesCipherTest.java`);
  const javaConfig = fetchText(`${JAVA_SDK}/model/TestConfig.java`);
  const java = (name: string) => pick(javaTest, new RegExp(`${name} =\\s*"([^"]*)"`), name);
  const javaVector = {
    associatedData: java("ASSOCIATED_DATA"),
    nonce: java("NONCE"),
    ciphertext: java("CIPHERTEXT"),
    plaintext: java("MESSAGE"),
  };
  const javaPlaintext = aeadDecrypt(
    Buffer.from(pick(javaConfig, /API_V3_KEY = "([^"]+)"/, "测试 APIv3 密钥")),
    { algorithm: "AEAD_AES_256_GCM", ...javaVector, associated_data: javaVector.associatedData },
  );

  const report = {
    说明: [
      "pnpm wxpay:vectors 的产物，不手改。它记下本实现与微信支付官方实现对同一批输入的核对结果（X-04 任务书 第 7 节第 2 条）。",
      "sign：签名串由本实现构造、用现场生成的临时私钥签名；官方 Go SDK 用同一把私钥签出的结果逐字节相等，并且它的验签器接受本实现的签名、拒绝改过一个字节的签名串。",
      "seal：容器里按 AEAD_AES_256_GCM 加密（官方 Go SDK 只有解密函数，加密用的是 Go 标准库），官方 SDK 与本实现解出同一明文。",
      "notifications：本仓库用例的支架造的通知，官方 SDK 的通知处理器验签解密通过，与本实现的结果一致。sdkSigned：由官方 SDK 签名的通知，本实现验签解密通过。",
      "officialDocs、officialJavaAead：官方文档与官方 Java SDK 的示例，现场取回核对。",
      `文件里没有任何私钥。验签用的公钥在 publicKeys；解密用的测试 APIv3 密钥由 wechatpay-server.ts 的 testApiV3Key("${KEY_TAG}") 现场拼出，一看就是假值。vectors.test.ts 在 CI 里拿这份文件再核一遍。`,
    ],
    generatedAt: now.toISOString(),
    tools: { sdk: sdk.sdk, go: sdk.go, image: GO_IMAGE, javaSdk: "wechatpay-java 0.2.17" },
    serials: { merchant: merchant.serial, wechatPay: wechatPay.serial },
    publicKeys: { merchant: merchant.publicKeyPem, wechatPay: wechatPay.publicKeyPem },
    apiV3KeyTag: KEY_TAG,
    sign,
    seal,
    notifications,
    sdkSigned,
    officialDocs,
    officialJavaAead: {
      source: `${JAVA_SDK}/cipher/AeadAesCipherTest.java`,
      ...javaVector,
      ourPlaintextEquals: javaPlaintext === javaVector.plaintext,
    },
  };
  const target = join(HERE, "cross-check.json");
  const options = await resolveConfig(target);
  const text = await format(JSON.stringify(report), { ...options, filepath: target });
  expect(text).not.toMatch(/PRIVATE KEY/);
  expect(text).not.toContain(apiV3Key);
  writeFileSync(target, text);

  // 写完再判：有一项对不上即失败，文件留着看差在哪
  for (const entry of sign) {
    expect(entry, entry.name).toMatchObject({
      sdkSignatureEqualsOurs: true,
      sdkVerifiesOurs: true,
      sdkRejectsTampered: true,
    });
    const key = entry.by === "merchant" ? merchant : wechatPay;
    expect(rsaVerify(entry.message, entry.signature, key.privateKey), entry.name).toBe(true);
  }
  for (const entry of seal) {
    expect(entry, entry.name).toMatchObject({ sdkPlaintextEquals: true, ourPlaintextEquals: true });
  }
  for (const entry of notifications) {
    expect(entry, entry.name).toMatchObject({
      sdkAccepted: true,
      ourAccepted: true,
      sameResult: true,
    });
  }
  for (const entry of sdkSigned) expect(entry.ourAccepted, entry.name).toBe(true);
  for (const entry of officialDocs) expect(entry.ourSignatureEqualsDocument, entry.name).toBe(true);
  expect(report.officialJavaAead.ourPlaintextEquals).toBe(true);
  process.stdout.write(
    `cross-check.json 已写出：签名 ${sign.length} 组、加密 ${seal.length} 组、通知 ${notifications.length + sdkSigned.length} 条，` +
      `官方文档 ${officialDocs.length} 条、官方 Java SDK 1 条，全部一致（${sdk.sdk}，${sdk.go}）。\n`,
  );
});
