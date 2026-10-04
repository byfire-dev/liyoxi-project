import { createPublicKey } from "node:crypto";
import type { KeyObject } from "node:crypto";

import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import { FC_LABEL, FC_PARAMS, FC_TIMEOUT_MS } from "./__fixtures__/fc.js";
import { generateIdentity, seal, testApiV3Key } from "./__fixtures__/wechatpay-server.js";
import type { TestIdentity } from "./__fixtures__/wechatpay-server.js";
import { aeadDecrypt, createApiV3Keyring } from "./keyring.js";
import {
  miniProgramPaySignMessage,
  requestSignMessage,
  responseSignMessage,
  rsaSign,
  rsaVerify,
} from "./sign.js";
import type { RequestSignParts } from "./sign.js";

// 性质测试（X-04 任务书 第 7 节第 6 条 ①②；甲类必带）。密钥是现场生成的测试密钥。
// 签名串按换行分行：方法、地址、时间戳、随机串里不会有换行（真实请求里也不会有），请求体放在最后、可以是任意文本。

let merchant: TestIdentity;
let merchantPublicKey: KeyObject;
let stranger: KeyObject;

beforeAll(() => {
  merchant = generateIdentity("LYXTESTMCHCERTSERIAL0001");
  merchantPublicKey = createPublicKey(merchant.publicKeyPem);
  stranger = createPublicKey(generateIdentity("LYXTESTMCHCERTSERIAL0002").publicKeyPem);
});

const line = fc.string({ unit: "binary", maxLength: 40 }).filter((text) => !text.includes("\n"));
const anyText = fc.string({ unit: "binary", maxLength: 200 });
const requestArb: fc.Arbitrary<RequestSignParts> = fc.record({
  method: fc.constantFrom("GET", "POST", "PUT", "PATCH", "DELETE"),
  pathWithQuery: fc
    .tuple(fc.webPath(), fc.option(fc.webQueryParameters(), { nil: undefined }))
    .map(([path, query]) => `/v3${path}${query === undefined ? "" : `?${query}`}`),
  timestamp: fc.integer({ min: 0, max: 4_102_444_800 }).map(String),
  nonce: fc.string({ unit: fc.constantFrom(..."0123456789ABCDEF"), minLength: 1, maxLength: 32 }),
  body: fc.oneof(fc.constant(""), fc.json(), anyText),
});
const FIELDS = ["method", "pathWithQuery", "timestamp", "nonce", "body"] as const;

describe(`property: 签名与验签（${FC_LABEL}）`, () => {
  it(
    "property: 任意请求签名后验签通过；改动方法、路径、时间戳、随机串、请求体任一处即失败",
    () => {
      fc.assert(
        fc.property(
          requestArb,
          fc.constantFrom(...FIELDS),
          fc.oneof(line, anyText),
          (request, field, replacement) => {
            const message = requestSignMessage(request);
            const signature = rsaSign(message, merchant.privateKey);
            expect(rsaVerify(message, signature, merchantPublicKey)).toBe(true);
            expect(rsaVerify(message, signature, stranger)).toBe(false);

            const value = field === "body" ? replacement : replacement.replaceAll("\n", " ");
            fc.pre(value !== request[field]);
            const changed = requestSignMessage({ ...request, [field]: value });
            expect(changed).not.toBe(message);
            expect(rsaVerify(changed, signature, merchantPublicKey)).toBe(false);
          },
        ),
        FC_PARAMS,
      );
    },
    FC_TIMEOUT_MS,
  );

  it(
    "property: 任意应答或回调的原始字节签名后验签通过；改动时间戳、随机串、任一字节即失败",
    () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 4_102_444_800 }).map(String),
          line.filter((text) => text !== ""),
          fc.uint8Array({ maxLength: 300 }),
          fc.nat(),
          fc.integer({ min: 1, max: 255 }),
          (timestamp, nonce, body, at, delta) => {
            const message = responseSignMessage(timestamp, nonce, body);
            const signature = rsaSign(message, merchant.privateKey);
            expect(rsaVerify(message, signature, merchantPublicKey)).toBe(true);
            const verify = (t: string, n: string, b: Uint8Array) =>
              rsaVerify(responseSignMessage(t, n, b), signature, merchantPublicKey);
            expect(verify(`${timestamp}0`, nonce, body)).toBe(false);
            expect(verify(timestamp, `${nonce}x`, body)).toBe(false);
            expect(verify(timestamp, nonce, Buffer.concat([body, Buffer.from([delta])]))).toBe(
              false,
            );
            if (body.length > 0) {
              const flipped = Uint8Array.from(body);
              const index = at % body.length;
              flipped[index] = ((flipped[index] ?? 0) + delta) % 256;
              expect(verify(timestamp, nonce, flipped)).toBe(false);
            }
          },
        ),
        FC_PARAMS,
      );
    },
    FC_TIMEOUT_MS,
  );

  it(
    "property: 任意调起支付参数签名后验签通过；改动任一处即失败",
    () => {
      const part = fc
        .string({ unit: "binary", minLength: 1, maxLength: 40 })
        .filter((t) => !t.includes("\n"));
      fc.assert(
        fc.property(
          part,
          part,
          part,
          part,
          fc.nat({ max: 3 }),
          (appId, timeStamp, nonceStr, prepayId, at) => {
            const parts = { appId, timeStamp, nonceStr, prepayId };
            const message = miniProgramPaySignMessage(parts);
            const signature = rsaSign(message, merchant.privateKey);
            expect(rsaVerify(message, signature, merchantPublicKey)).toBe(true);
            const field = (["appId", "timeStamp", "nonceStr", "prepayId"] as const)[at] ?? "appId";
            const changed = miniProgramPaySignMessage({ ...parts, [field]: `${parts[field]}!` });
            expect(rsaVerify(changed, signature, merchantPublicKey)).toBe(false);
          },
        ),
        FC_PARAMS,
      );
    },
    FC_TIMEOUT_MS,
  );

  it(
    "property: 任意改动签名值即验签失败（含不是 base64 的写法与探测前缀）",
    () => {
      const message = requestSignMessage({
        method: "GET",
        pathWithQuery: "/v3/pay/transactions/out-trade-no/FK1?mchid=1900000109",
        timestamp: "1791000000",
        nonce: "593BEC0C930BF1AFEB40B4A08C8FB242",
        body: "",
      });
      const signature = rsaSign(message, merchant.privateKey);
      fc.assert(
        fc.property(
          fc.nat({ max: signature.length - 1 }),
          fc.string({ maxLength: 4 }),
          (at, insert) => {
            const changed = `${signature.slice(0, at)}${insert}${signature.slice(at + 1)}`;
            fc.pre(changed !== signature);
            expect(rsaVerify(message, changed, merchantPublicKey)).toBe(false);
            expect(rsaVerify(message, `WECHATPAY/SIGNTEST/${changed}`, merchantPublicKey)).toBe(
              false,
            );
          },
        ),
        FC_PARAMS,
      );
    },
    FC_TIMEOUT_MS,
  );
});

describe(`property: 加密与解密（${FC_LABEL}）`, () => {
  const key = testApiV3Key("current");
  const keyBytes = Buffer.from(key);
  // 明文至少一个字符：只有认证标签、没有密文的报文按不合规处理（官方文档的 PHP 示例同此）
  const plaintextArb = fc.oneof(
    fc.json(),
    fc.string({ unit: "binary", minLength: 1, maxLength: 300 }),
  );
  const nonceArb = fc.string({
    unit: fc.constantFrom(..."0123456789abcdef"),
    minLength: 12,
    maxLength: 12,
  });
  const aadArb = fc.string({ unit: "binary", maxLength: 16 });

  it(
    "property: 任意明文与关联数据加密后解密恒等；改动密文、随机串、关联数据任一处即失败",
    () => {
      fc.assert(
        fc.property(plaintextArb, nonceArb, aadArb, fc.nat(), (plaintext, nonce, aad, at) => {
          const ciphertext = seal(key, plaintext, nonce, aad);
          const resource = {
            algorithm: "AEAD_AES_256_GCM",
            ciphertext,
            nonce,
            associated_data: aad,
          };
          expect(aeadDecrypt(keyBytes, resource)).toBe(plaintext);

          const index = at % ciphertext.length;
          const swapped = ciphertext[index] === "A" ? "B" : "A";
          const tampered = `${ciphertext.slice(0, index)}${swapped}${ciphertext.slice(index + 1)}`;
          expect(aeadDecrypt(keyBytes, { ...resource, ciphertext: tampered })).toBeNull();
          expect(
            aeadDecrypt(keyBytes, { ...resource, ciphertext: ciphertext.slice(0, -4) }),
          ).toBeNull();
          const otherNonce = `${nonce.slice(0, 11)}${nonce[11] === "0" ? "1" : "0"}`;
          expect(aeadDecrypt(keyBytes, { ...resource, nonce: otherNonce })).toBeNull();
          expect(aeadDecrypt(keyBytes, { ...resource, associated_data: `${aad}x` })).toBeNull();
          expect(aeadDecrypt(Buffer.from(testApiV3Key("other")), resource)).toBeNull();
        }),
        FC_PARAMS,
      );
    },
    FC_TIMEOUT_MS,
  );

  it(
    "property: 密钥环返回实际所用的 kid；指定别的 kid 解不开",
    () => {
      const ring = createApiV3Keyring(
        { kid: "v2", key },
        { kid: "v1", key: testApiV3Key("previous") },
      );
      fc.assert(
        fc.property(
          plaintextArb,
          nonceArb,
          aadArb,
          fc.boolean(),
          (plaintext, nonce, aad, useCurrent) => {
            const [kid, other] = useCurrent ? ["v2", "v1"] : ["v1", "v2"];
            const used = useCurrent ? key : testApiV3Key("previous");
            const resource = {
              algorithm: "AEAD_AES_256_GCM",
              ciphertext: seal(used, plaintext, nonce, aad),
              nonce,
              associated_data: aad,
            };
            expect(ring.decrypt(resource)).toEqual({ kid, plaintext });
            expect(ring.decrypt(resource, kid)).toEqual({ kid, plaintext });
            expect(ring.decrypt(resource, other)).toBeNull();
          },
        ),
        FC_PARAMS,
      );
    },
    FC_TIMEOUT_MS,
  );
});
