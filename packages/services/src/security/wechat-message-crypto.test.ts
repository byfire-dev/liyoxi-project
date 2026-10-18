import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createWechatMessageCrypto } from "./wechat-message-crypto.js";

// 公开官方 JSON 示例，非真实平台密钥。获取日期与原文 SHA 见私有 README。
// https://developers.weixin.qq.com/miniprogram/dev/framework/server-ability/message-push.html
const config = {
  token: "AAAAA",
  encodingAESKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  appid: "wxba5fad812f8e6fb9",
};
const now = new Date(1714112445_000);
const officialCipher =
  "+qdx1OKCy+5JPCBFWw70tm0fJGb2Jmeia4FCB7kao+/Q5c/ohsOzQHi8khUOb05JCpj0JB4RvQMkUyus8TPxLKJGQqcvZqzDpVzazhZv6JsXUnnR8XGT740XgXZUXQ7vJVnAG+tE8NUd4yFyjPy7GgiaviNrlCTj+l5kdfMuFUPpRSrfMZuMcp3Fn2Pede2IuQrKEYwKSqFIZoNqJ4M8EajAsjLY2km32IIjdf8YL/P50F7mStwntrA2cPDrM1kb6mOcfBgRtWygb3VIYnSeOBrebufAlr7F9mFUPAJGj04=";
const officialMessage = {
  ToUserName: "gh_97417a04a28d",
  FromUserName: "o9AgO5Kd5ggOC-bXrbNODIiE3bGY",
  CreateTime: 1714112445,
  MsgType: "event",
  Event: "debug_demo",
  debug_str: "hello world",
};
const signature = (...parts: string[]) =>
  createHash("sha1").update(parts.sort().join("")).digest("hex");
const crypto = () => createWechatMessageCrypto(config);
const body = (cipher: string) =>
  Buffer.from(JSON.stringify({ ToUserName: "gh_test", Encrypt: cipher }));
const post = (cipher = officialCipher) => ({
  query: {
    signature: "0".repeat(40), // 安全模式只认 msg_signature。
    timestamp: "1714112445",
    nonce: "415670741",
    encrypt_type: "aes",
    msg_signature: signature(config.token, "1714112445", "415670741", cipher),
  },
  rawBody: body(cipher),
  now,
});
const get = () => ({
  query: {
    signature: "f464b24fc39322e44b38aa78f5edd27bd1441696",
    timestamp: "1714036504",
    nonce: "1514711492",
    echostr: "4375120948345356249",
  },
  now: new Date(1714036504_000),
});
const error = (symbol: string) => ({ ok: false, error: symbol });

// 独立测试侧打包/加密，不引生产 padding/打包函数，专用于对抗数据。
function frame(plain: Uint8Array, appid = config.appid, length = plain.byteLength): Buffer {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(length);
  return Buffer.concat([Buffer.alloc(16, 0x61), size, plain, Buffer.from(appid)]);
}
function seal(bytes: Buffer, pad?: Buffer): string {
  const count = 32 - (bytes.length % 32);
  const cipher = createCipheriv("aes-256-cbc", Buffer.alloc(32), Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([
    cipher.update(Buffer.concat([bytes, pad ?? Buffer.alloc(count, count)])),
    cipher.final(),
  ]).toString("base64");
}
const encrypted = (value: unknown) => seal(frame(Buffer.from(JSON.stringify(value))));
const nested = (depth: number): string => '{"p":'.repeat(depth) + '"end"' + "}".repeat(depth);

describe("微信消息协议：独立官方向量", () => {
  it("官方 GET 签名与 echostr 原文", () => {
    expect(crypto().verifyGet(get())).toEqual({ ok: true, value: "4375120948345356249" });
  });
  it("官方 JSON 安全 POST 密文与消息签名解出确定性明文", () => {
    const input = post();
    input.query.msg_signature = "046e02f8204d34f8ba5fa3b1db94908f3df2e9b3";
    expect(crypto().decryptPost(input)).toEqual({ ok: true, value: officialMessage });
  });
  it("官方回复随机前缀、时间、base64 密文与四字段签名", () => {
    const service = createWechatMessageCrypto({
      ...config,
      randomBytes: () => Buffer.from("707722b803182950"),
    });
    expect(
      service.encryptReply({
        plaintext: '{"demo_resp":"good luck"}',
        nonce: "415670741",
        now: new Date(1713424427_000),
      }),
    ).toEqual({
      ok: true,
      value: {
        Encrypt:
          "ELGduP2YcVatjqIS+eZbp80MNLoAUWvzzyJxgGzxZO/5sAvd070Bs6qrLARC9nVHm48Y4hyRbtzve1L32tmxSQ==",
        MsgSignature: "1b9339964ed2e271e7c7b6ff2b0ef902fc94dea1",
        TimeStamp: 1713424427,
        Nonce: "415670741",
      },
    });
  });
});

describe("微信消息协议：签名、时间与参数", () => {
  it.each([-300_000, 300_000])("GET/POST 接受时差边界 %ims", (offset) => {
    expect(crypto().verifyGet({ ...get(), now: new Date(get().now.getTime() + offset) }).ok).toBe(
      true,
    );
    expect(crypto().decryptPost({ ...post(), now: new Date(now.getTime() + offset) }).ok).toBe(
      true,
    );
  });
  it.each([-300_001, 300_001])("GET/POST 拒绝过期或未来偏差 %ims", (offset) => {
    expect(crypto().verifyGet({ ...get(), now: new Date(get().now.getTime() + offset) })).toEqual(
      error("WEBHOOK_TIMESTAMP_SKEWED"),
    );
    expect(crypto().decryptPost({ ...post(), now: new Date(now.getTime() + offset) })).toEqual(
      error("WEBHOOK_TIMESTAMP_SKEWED"),
    );
  });
  it("GET 40hex 与 POST 消息签名分别校验，plain signature 不能替代消息签名", () => {
    const input = get();
    input.query.signature = "0".repeat(40);
    expect(crypto().verifyGet(input)).toEqual(error("WEBHOOK_SIGNATURE_INVALID"));
    const request = post();
    request.query.signature = request.query.msg_signature;
    request.query.msg_signature = "0".repeat(40);
    expect(crypto().decryptPost(request)).toEqual(error("WEBHOOK_SIGNATURE_INVALID"));
  });
  it("hex 大小写均按相同字节比较", () => {
    const input = get();
    input.query.signature = input.query.signature.toUpperCase();
    expect(crypto().verifyGet(input).ok).toBe(true);
  });
  it.each([
    "",
    "1714112445.0",
    "1e9",
    "-1",
    " 1714112445",
    "Infinity",
    "9007199254740991",
    "8640000000001",
  ])("timestamp 非有限整秒或毫秒溢出：%s", (timestamp) => {
    expect(crypto().decryptPost({ ...post(), query: { ...post().query, timestamp } })).toEqual(
      error("WEBHOOK_PAYLOAD_INVALID"),
    );
  });
  it("无效 clock、错 query 字段类型、缺安全模式均受控", () => {
    expect(crypto().verifyGet({ ...get(), now: new Date(NaN) })).toEqual(
      error("WEBHOOK_PAYLOAD_INVALID"),
    );
    for (const query of [
      null,
      [],
      { ...post().query, nonce: [] },
      { ...post().query, encrypt_type: "raw" },
      { ...post().query, msg_signature: "z".repeat(40) },
      { ...post().query, signature: undefined },
    ]) {
      expect(crypto().decryptPost({ ...post(), query: query as never })).toEqual(
        error("WEBHOOK_PAYLOAD_INVALID"),
      );
    }
  });
  it("query/outer 的继承字段不能充作已提供的参数", () => {
    expect(crypto().verifyGet({ ...get(), query: Object.create(get().query) })).toEqual(
      error("WEBHOOK_PAYLOAD_INVALID"),
    );
    for (const field of ["constructor", "__proto__", "toString"]) {
      const query = { [field]: get().query };
      expect(crypto().verifyGet({ ...get(), query })).toEqual(error("WEBHOOK_PAYLOAD_INVALID"));
      const rawBody = Buffer.from(
        JSON.stringify({ [field]: { ToUserName: "x", Encrypt: officialCipher } }),
      );
      expect(crypto().decryptPost({ ...post(), rawBody })).toEqual(
        error("WEBHOOK_PAYLOAD_INVALID"),
      );
    }
  });
  it("nonce 恰256字节接受，空/控制/非ASCII/257字节拒绝", () => {
    const nonce = "a".repeat(256);
    const query = {
      ...get().query,
      nonce,
      signature: signature(config.token, get().query.timestamp, nonce),
    };
    expect(crypto().verifyGet({ ...get(), query }).ok).toBe(true);
    for (const invalid of ["", "a\u0000b", "中文", "a".repeat(257)]) {
      expect(crypto().verifyGet({ ...get(), query: { ...query, nonce: invalid } })).toEqual(
        error("WEBHOOK_PAYLOAD_INVALID"),
      );
    }
  });
});

describe("微信消息协议：加解密严格边界", () => {
  it("不是规范 base64、太短或非32字节密文拒绝", () => {
    for (const cipher of [
      "",
      officialCipher + " ",
      officialCipher.slice(0, -1),
      "AAAA",
      "_".repeat(44),
      Buffer.alloc(16).toString("base64"),
      officialCipher.slice(0, -2) + "B=",
    ]) {
      expect(crypto().decryptPost(post(cipher))).toEqual(error("WEBHOOK_PAYLOAD_INVALID"));
    }
  });
  it("签名错误优先，不暴露配置是否能解密", () => {
    const request = post(seal(Buffer.alloc(10)));
    request.query.msg_signature = "0".repeat(40);
    expect(crypto().decryptPost(request)).toEqual(error("WEBHOOK_SIGNATURE_INVALID"));
  });
  it("合法配置但实际错 key 返回已验签解密失败，错误不含明文/密钥", () => {
    const service = createWechatMessageCrypto({
      ...config,
      encodingAESKey: Buffer.alloc(32, 1).toString("base64").slice(0, -1),
    });
    expect(service.decryptPost(post())).toEqual(error("WEBHOOK_DECRYPT_FAILED"));
  });
  it("32字节 PKCS7 全块填充可接受，不能使用16字节自动padding", () => {
    const value = { x: "a".repeat(18) }; // UTF8消息26字节 + 20 + appid18 = 64；再补32。
    expect(crypto().decryptPost(post(encrypted(value)))).toEqual({ ok: true, value });
  });
  it.each([0, 33])("已验签密文 padding末字节 %i 不是1..32", (last) => {
    const bytes = frame(Buffer.from('{"x":1}'));
    const pad = Buffer.alloc(32 - (bytes.length % 32), last);
    expect(crypto().decryptPost(post(seal(bytes, pad)))).toEqual(error("WEBHOOK_DECRYPT_FAILED"));
  });
  it("已验签密文每个padding尾字节都必须相等", () => {
    const bytes = frame(Buffer.from('{"x":1}'));
    const count = 32 - (bytes.length % 32);
    const pad = Buffer.alloc(count, count);
    pad[0] = 1;
    expect(crypto().decryptPost(post(seal(bytes, pad)))).toEqual(error("WEBHOOK_DECRYPT_FAILED"));
  });
  it("二进制结构过短、4字节长度越界不能读越缓冲区", () => {
    for (const bytes of [
      Buffer.alloc(10),
      frame(Buffer.from('{"x":1}'), config.appid, 0xffffffff),
    ]) {
      expect(crypto().decryptPost(post(seal(bytes)))).toEqual(error("WEBHOOK_DECRYPT_FAILED"));
    }
  });
  it("appid 精确比较，错值、前缀或追加后缀均拒绝", () => {
    for (const appid of ["wx_wrong", config.appid.slice(0, -1), config.appid + "suffix"]) {
      expect(crypto().decryptPost(post(seal(frame(Buffer.from('{"x":1}'), appid))))).toEqual(
        error("WEBHOOK_SIGNATURE_INVALID"),
      );
    }
  });
  it("解开appid后坏UTF8/坏JSON/数组/原始类型仍400", () => {
    for (const plain of [
      Buffer.from([0xff]),
      Buffer.from("{"),
      Buffer.from("[]"),
      Buffer.from("null"),
      Buffer.from("1"),
    ]) {
      expect(crypto().decryptPost(post(seal(frame(plain))))).toEqual(
        error("WEBHOOK_PAYLOAD_INVALID"),
      );
    }
  });
  it("外层必须有真实字符串字段，不能仅因JSON可解析就接受", () => {
    for (const value of [
      null,
      [],
      {},
      { Encrypt: officialCipher },
      { ToUserName: "x", Encrypt: 1 },
      { ToUserName: "", Encrypt: officialCipher },
      { ToUserName: "a".repeat(129), Encrypt: officialCipher },
    ]) {
      expect(
        crypto().decryptPost({ ...post(), rawBody: Buffer.from(JSON.stringify(value)) }),
      ).toEqual(error("WEBHOOK_PAYLOAD_INVALID"));
    }
    expect(crypto().decryptPost({ ...post(), rawBody: Buffer.from([0xff]) })).toEqual(
      error("WEBHOOK_PAYLOAD_INVALID"),
    );
  });
  it("深度32接受，33拒绝；外层未知字段也必须有界", () => {
    expect(crypto().decryptPost(post(seal(frame(Buffer.from(nested(32)))))).ok).toBe(true);
    expect(crypto().decryptPost(post(seal(frame(Buffer.from(nested(33))))))).toEqual(
      error("WEBHOOK_PAYLOAD_INVALID"),
    );
    const rawBody = Buffer.from(
      '{"ToUserName":"x","Encrypt":' +
        JSON.stringify(officialCipher) +
        ',"extra":' +
        nested(33) +
        "}",
    );
    expect(crypto().decryptPost({ ...post(), rawBody })).toEqual(error("WEBHOOK_PAYLOAD_INVALID"));
  });
  it("raw body 128KiB恰边界，+1字节拒绝；不是HTTP流限量证明", () => {
    const original = post().rawBody;
    const exact = Buffer.concat([original, Buffer.alloc(128 * 1024 - original.length, 0x20)]);
    expect(crypto().decryptPost({ ...post(), rawBody: exact }).ok).toBe(true);
    expect(
      crypto().decryptPost({ ...post(), rawBody: Buffer.concat([exact, Buffer.from(" ")]) }),
    ).toEqual(error("WEBHOOK_PAYLOAD_INVALID"));
  });
  it("明文64KiB边界与中文按UTF8字节计数", () => {
    const exact = '{"x":"' + "a".repeat(64 * 1024 - 8) + '"}';
    expect(crypto().decryptPost(post(seal(frame(Buffer.from(exact))))).ok).toBe(true);
    expect(crypto().decryptPost(post(seal(frame(Buffer.from(exact + " ")))))).toEqual(
      error("WEBHOOK_PAYLOAD_INVALID"),
    );
    const chinese = JSON.stringify({ x: "中".repeat(22_000) });
    expect(crypto().decryptPost(post(seal(frame(Buffer.from(chinese)))))).toEqual(
      error("WEBHOOK_PAYLOAD_INVALID"),
    );
    expect(crypto().decryptPost(post(encrypted({ x: "中文🦝" })))).toEqual({
      ok: true,
      value: { x: "中文🦝" },
    });
  });
  it("echo的4KiB UTF8界限原文保留", () => {
    const exact = "x".repeat(4096);
    expect(crypto().verifyGet({ ...get(), query: { ...get().query, echostr: exact } })).toEqual({
      ok: true,
      value: exact,
    });
    for (const value of [exact + "x", "中".repeat(1400)]) {
      expect(crypto().verifyGet({ ...get(), query: { ...get().query, echostr: value } })).toEqual(
        error("WEBHOOK_PAYLOAD_INVALID"),
      );
    }
  });
});

describe("微信消息协议：配置与回复", () => {
  it("配置校验固定报错，不输出输入钥匙；规范43字符key与32字节对应", () => {
    for (const overrides of [
      { token: "" },
      { token: "x\u0000y" },
      { token: "x".repeat(129) },
      { appid: "" },
      { appid: "\n" },
      { encodingAESKey: "private-invalid-key" },
      { encodingAESKey: "A".repeat(42) + "B" },
      { encodingAESKey: "A".repeat(44) },
    ]) {
      expect(() => createWechatMessageCrypto({ ...config, ...overrides })).toThrow(
        "微信消息加密配置非法",
      );
    }
  });
  it("缺省加密使用独立随机前缀，同明文不会重复密文", () => {
    const input = { plaintext: '{"x":1}', nonce: "1", now };
    const first = crypto().encryptReply(input);
    const second = crypto().encryptReply(input);
    expect(first.ok && second.ok && first.value.Encrypt !== second.value.Encrypt).toBe(true);
  });
  it("继承的配置不能通过工厂校验；null也只得到固定配置错误", () => {
    for (const value of [Object.create(config), null]) {
      expect(() => createWechatMessageCrypto(value as never)).toThrow("微信消息加密配置非法");
    }
  });
  it("回复64KiB与32层边界接受，UTF8超界和孤立代理字符拒绝", () => {
    for (const plaintext of ['{"x":"' + "a".repeat(65536 - 8) + '"}', nested(32)]) {
      expect(crypto().encryptReply({ plaintext, nonce: "1", now }).ok).toBe(true);
    }
    for (const plaintext of [JSON.stringify({ x: "中".repeat(22000) }), '{"x":"\ud800"}']) {
      expect(crypto().encryptReply({ plaintext, nonce: "1", now })).toEqual(
        error("WEBHOOK_PAYLOAD_INVALID"),
      );
    }
    expect(crypto().verifyGet({ ...get(), query: { ...get().query, echostr: "\ud800" } })).toEqual(
      error("WEBHOOK_PAYLOAD_INVALID"),
    );
  });
  it("回复非JSON对象、超字节/深度、无效clock/nonce均受控", () => {
    for (const plaintext of [
      "",
      "{",
      "[]",
      "null",
      nested(33),
      JSON.stringify({ x: "a".repeat(65536) }),
    ]) {
      expect(crypto().encryptReply({ plaintext, nonce: "1", now })).toEqual(
        error("WEBHOOK_PAYLOAD_INVALID"),
      );
    }
    expect(crypto().encryptReply({ plaintext: "{}", nonce: "", now })).toEqual(
      error("WEBHOOK_PAYLOAD_INVALID"),
    );
    expect(crypto().encryptReply({ plaintext: "{}", nonce: "1", now: new Date(NaN) })).toEqual(
      error("WEBHOOK_PAYLOAD_INVALID"),
    );
  });
  it("注入随机源错长度或抛异常不泄露原始错误", () => {
    for (const randomBytes of [
      () => Buffer.alloc(15),
      () => {
        throw new Error("private-random-failure");
      },
    ]) {
      expect(
        createWechatMessageCrypto({ ...config, randomBytes }).encryptReply({
          plaintext: "{}",
          nonce: "1",
          now,
        }),
      ).toEqual(error("WEBHOOK_DECRYPT_FAILED"));
    }
  });
});

describe("微信消息协议：原始解密字节摘要", () => {
  it("相同对象的原始空格和键序产生两个固定不同摘要", () => {
    const vectors = [
      ['{"a":1,"b":2}', "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"],
      [' { "b":2, "a":1 } \n', "0f56bebcfd6f1cc5aa9eb15d115f8fd09d5b175dcfd90074f07c0aafc71112d2"],
    ] as const;
    for (const [literal, plaintextDigest] of vectors) {
      expect(createHash("sha256").update(Buffer.from(literal)).digest("hex")).toBe(plaintextDigest);
      const request = post(seal(frame(Buffer.from(literal))));
      expect(crypto().decryptPostDetailed(request)).toEqual({
        ok: true,
        value: { message: { a: 1, b: 2 }, plaintextDigest },
      });
      expect(crypto().decryptPost(request)).toEqual({ ok: true, value: { a: 1, b: 2 } });
    }
    expect(vectors[0][1]).not.toBe(vectors[1][1]);
  });
  it("中文、astral与组合字符按实际UTF8字节摘要，不能按重新序列化字符串", () => {
    const literal = '{"text":"狸🦊","key":"é"}';
    const plaintextDigest = "5bb3a1ffb11d25094dc1a3e689c88d2f622ad5a8dc1d05975ecbacda027d2660";
    expect(createHash("sha256").update(Buffer.from(literal)).digest("hex")).toBe(plaintextDigest);
    expect(crypto().decryptPostDetailed(post(seal(frame(Buffer.from(literal)))))).toEqual({
      ok: true,
      value: { message: JSON.parse(literal), plaintextDigest },
    });
  });
  it("官方合法cipher详细内容与旧method内容一致，只增加摘要没有原文string", () => {
    const service = crypto();
    const request = post();
    const detailed = service.decryptPostDetailed(request);
    expect(service.decryptPost(request)).toEqual({ ok: true, value: officialMessage });
    expect(detailed).toEqual({
      ok: true,
      value: {
        message: officialMessage,
        plaintextDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    if (detailed.ok)
      expect(Object.keys(detailed.value).sort()).toEqual(["message", "plaintextDigest"]);
  });
  it("详细与旧method保持四个失败符号及原错误优先级", () => {
    const request = post();
    const wrongKey = createWechatMessageCrypto({
      ...config,
      encodingAESKey: Buffer.alloc(32, 1).toString("base64").slice(0, -1),
    });
    for (const [service, input, symbol] of [
      [
        crypto(),
        { ...request, query: { ...request.query, msg_signature: "0".repeat(40) } },
        "WEBHOOK_SIGNATURE_INVALID",
      ],
      [
        crypto(),
        { ...request, now: new Date(now.getTime() + 300_001) },
        "WEBHOOK_TIMESTAMP_SKEWED",
      ],
      [wrongKey, request, "WEBHOOK_DECRYPT_FAILED"],
      [crypto(), { ...request, rawBody: Buffer.from([0xff]) }, "WEBHOOK_PAYLOAD_INVALID"],
    ] as const) {
      expect(service.decryptPostDetailed(input)).toEqual(error(symbol));
      expect(service.decryptPost(input)).toEqual(error(symbol));
    }
  });
});
