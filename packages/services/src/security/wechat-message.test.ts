import { createCipheriv, createHash, createDecipheriv } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@liyoxi/db";
import { isInTransaction, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import {
  createFakeProviders,
  createSampleEvents,
  sampleSystemContext,
  useTestDatabase,
} from "../testing/index.js";
import { createWebhooks } from "./webhooks/runtime.js";
import type { WechatImageCallback, WechatMessageSourceOptions } from "./wechat-message.js";
import { sealPhone } from "./pii.js";
import { ringA } from "./__fixtures__/keys.js";
import { createWechatMessageSource } from "./wechat-message.js";
import type { WebhookRequest, WebhookStored } from "./webhooks/types.js";

// 公开官方crypto示例假配置；不使用环境文件或真实平台。
const config = {
  token: "AAAAA",
  encodingAESKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  appid: "wxba5fad812f8e6fb9",
};
const now = new Date("2026-01-05T08:00:00Z");
const sha1 = (...parts: string[]) => createHash("sha1").update(parts.sort().join("")).digest("hex");
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// 独立测试打包，防止生产加密与适配器共享错误。
function encrypt(text: string, appid = config.appid): string {
  const message = Buffer.from(text);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(message.length);
  const frame = Buffer.concat([Buffer.alloc(16, 97), length, message, Buffer.from(appid)]);
  const pad = 32 - (frame.length % 32);
  const cipher = createCipheriv("aes-256-cbc", Buffer.alloc(32), Buffer.alloc(16));
  cipher.setAutoPadding(false);
  return Buffer.concat([
    cipher.update(Buffer.concat([frame, Buffer.alloc(pad, pad)])),
    cipher.final(),
  ]).toString("base64");
}
function request(
  message: unknown,
  options: { raw?: string; appid?: string; at?: Date } = {},
): WebhookRequest {
  const at = options.at ?? now;
  const timestamp = String(Math.floor(at.getTime() / 1000));
  const encoded = encrypt(options.raw ?? JSON.stringify(message), options.appid);
  return {
    method: "POST",
    operationId: "hooks.wechat.message.receive",
    headers: {},
    rawBody: Buffer.from(JSON.stringify({ ToUserName: "gh_test", Encrypt: encoded })),
    query: {
      signature: "0".repeat(40),
      timestamp,
      nonce: "fixed-nonce",
      encrypt_type: "aes",
      msg_signature: sha1(config.token, timestamp, "fixed-nonce", encoded),
    },
  };
}
const subscription = (event = "subscribe_msg_sent_event", extra: Record<string, unknown> = {}) => ({
  MsgType: "event",
  Event: event,
  FromUserName: "fixture-private-openid",
  List: [{ TemplateId: "template-test", MsgID: "42", ErrorCode: 0, ErrorStatus: "ok" }],
  ...extra,
});
const image = (extra: Record<string, unknown> = {}) => ({
  MsgType: "event",
  Event: "wxa_media_check",
  trace_id: "trace-test",
  result: { suggest: "risky", label: 100 },
  ...extra,
});
const source = () =>
  createWechatMessageSource({
    cryptoConfig: config,
    findWechatIdentityId: vi.fn(async () => null),
  });
const verify = (value: unknown, options?: Parameters<typeof request>[1]) =>
  source().verify({ ...request(value, options), now });
const restored = (payload: unknown): WebhookStored => ({
  id: "00000000-0000-7000-8000-000000000001",
  eventId: "test",
  eventType: "subscribe_msg_sent_event",
  keyVersion: null,
  payload: payload as WebhookStored["payload"],
});

describe("微信消息来源协议：真实加密输入", () => {
  it("GET 验签原样回复，不提供入箱载荷", async () => {
    const timestamp = String(Math.floor(now.getTime() / 1000));
    const reply = await source().verify({
      method: "GET",
      operationId: "hooks.wechat.message.verify",
      headers: {},
      rawBody: new Uint8Array(),
      now,
      query: {
        timestamp,
        nonce: "get-nonce",
        echostr: "raw-echo",
        signature: sha1(config.token, timestamp, "get-nonce"),
      },
    });
    expect(reply).toEqual({
      kind: "reply",
      status: 200,
      body: "raw-echo",
      headers: { "Content-Type": "text/plain" },
    });
  });

  it.each(["text", "image", "miniprogrampage", "event"])(
    "客服 %s 加密转接，正文和媒体字段不进入回复",
    async (type) => {
      const reply = await verify({
        MsgType: type,
        Event: "user_enter_tempsession",
        ToUserName: "gh_test",
        FromUserName: "customer-test",
        CreateTime: 1,
        Content: "private-body",
        PicUrl: "https://private.test/path",
        PagePath: "private/path",
      });
      expect(reply.kind).toBe("skip");
      if (reply.kind !== "skip") throw new Error("客服未转接");
      expect(reply.reason).toBe("passive_reply");
      const envelope = JSON.parse(reply.reply.body) as {
        Encrypt: string;
        TimeStamp: number;
        Nonce: string;
        MsgSignature: string;
      };
      expect(envelope.MsgSignature).toBe(
        sha1(config.token, String(envelope.TimeStamp), envelope.Nonce, envelope.Encrypt),
      );
      const decipher = createDecipheriv("aes-256-cbc", Buffer.alloc(32), Buffer.alloc(16));
      decipher.setAutoPadding(false);
      const decoded = Buffer.concat([
        decipher.update(Buffer.from(envelope.Encrypt, "base64")),
        decipher.final(),
      ]);
      const text = decoded.subarray(20, 20 + decoded.readUInt32BE(16)).toString();
      expect(JSON.parse(text)).toEqual({
        ToUserName: "customer-test",
        FromUserName: "gh_test",
        CreateTime: Math.floor(now.getTime() / 1000),
        MsgType: "transfer_customer_service",
      });
      expect(text).not.toContain("private");
    },
  );

  it.each([{ MsgType: "event", Event: "future-event" }, { MsgType: "video" }])(
    "未登记消息 %# 成功忽略",
    async (value) => {
      expect(await verify(value)).toEqual({
        kind: "skip",
        reason: "unregistered_event",
        reply: { kind: "reply", status: 200, body: "success" },
      });
    },
  );

  it("图片按trace安全hash，结果只保留正式字段", async () => {
    const service = source();
    const checked = await service.verify({
      ...request(
        image({ result: { suggest: "risky", label: 100, detail: "private" }, extra: "private" }),
      ),
      now,
    });
    expect(checked.kind).toBe("event");
    if (checked.kind !== "event") throw new Error("图片未验签");
    expect(checked.event.eventId).toBe(sha256("wxa_media_check:trace-test"));
    expect(service.payload(checked.event)).toEqual({
      event: "wxa_media_check",
      traceId: "trace-test",
      result: { suggest: "risky", label: 100 },
    });
  });

  it.each(["subscribe_msg_sent_event", "subscribe_msg_change_event", "subscribe_msg_popup_event"])(
    "%s 订阅先验模板不含openid或扩展",
    async (event) => {
      const service = source();
      const message = subscription(event, {
        List: [
          {
            TemplateId: "template-test",
            MsgID: 42,
            ErrorCode: 0,
            ErrorStatus: "ok",
            SubscribeStatusString: "reject",
            PopupScene: 2,
            Content: "private",
          },
        ],
        extra: "private",
      });
      const raw = `  ${JSON.stringify(message)}\n`;
      const checked = await service.verify({ ...request(message, { raw }), now });
      expect(checked.kind).toBe("event");
      if (checked.kind !== "event") throw new Error("订阅未验签");
      expect(checked.event.eventId).toBe(sha256(raw));
      expect(service.payload(checked.event)).toEqual({
        event,
        wechatIdentityId: null,
        items: [
          {
            templateId: "template-test",
            msgId: "42",
            errorCode: "0",
            errorStatus: "ok",
            status: "reject",
            popupScene: "2",
          },
        ],
      });
      expect(JSON.stringify(service.payload(checked.event))).not.toMatch(
        /openid|private|FromUserName|Content/,
      );
    },
  );

  it("正式可选字段缺省仍有效，不猜默认成功", async () => {
    const checked = await verify(
      subscription(undefined, { List: [{ TemplateId: "template-test" }] }),
    );
    expect(checked.kind).toBe("event");
    if (checked.kind !== "event") throw new Error("optional错误");
    expect(source().payload(checked.event)).toEqual({
      event: "subscribe_msg_sent_event",
      wechatIdentityId: null,
      items: [{ templateId: "template-test" }],
    });
  });

  it.each([
    { MsgType: "event" },
    image({ trace_id: "" }),
    image({ result: { suggest: "other", label: 1 } }),
    image({ result: { suggest: "pass", label: 1.5 } }),
    subscription(undefined, { FromUserName: "" }),
    subscription(undefined, { List: null }),
    subscription(undefined, { List: [{}] }),
    subscription(undefined, { List: [{ TemplateId: "t", MsgID: Number.MAX_SAFE_INTEGER + 1 }] }),
    subscription(undefined, { List: [{ TemplateId: "t", ErrorCode: {} }] }),
    subscription(undefined, { List: [{ TemplateId: "t", ErrorStatus: "x".repeat(257) }] }),
    subscription(undefined, { List: [{ TemplateId: "t", SubscribeStatusString: "x".repeat(65) }] }),
    subscription(undefined, { List: Array.from({ length: 101 }, () => ({ TemplateId: "t" })) }),
    subscription(undefined, { List: [{ TemplateId: "界".repeat(86) }] }),
  ])("登记/必要字段不合法 %# 受控拒绝", async (message) => {
    expect(await verify(message)).toEqual({ kind: "error", error: "WEBHOOK_PAYLOAD_INVALID" });
  });

  it.each(["constructor", "__proto__", "toString"])(
    "特殊事件名 %s 不从原型表命中",
    async (name) => {
      expect((await verify({ MsgType: "event", Event: name })).kind).toBe("skip");
    },
  );
  it("有限整数与边界UTF8/List100可接收，MsgID不舍入", async () => {
    expect(
      (
        await verify(
          subscription(undefined, {
            List: Array.from({ length: 100 }, () => ({
              TemplateId: "界".repeat(85),
              MsgID: Number.MAX_SAFE_INTEGER,
              ErrorStatus: "x".repeat(256),
              ErrorCode: "x".repeat(64),
            })),
          }),
        )
      ).kind,
    ).toBe("event");
  });
  it("appid/签名/时间错误保持401类，配置异常不是用户400", async () => {
    expect(await verify(image(), { appid: "other-appid" })).toEqual({
      kind: "error",
      error: "WEBHOOK_SIGNATURE_INVALID",
    });
    const bad = request(image());
    expect(
      await source().verify({
        ...bad,
        now,
        query: { ...bad.query, msg_signature: "0".repeat(40) },
      }),
    ).toEqual({ kind: "error", error: "WEBHOOK_SIGNATURE_INVALID" });
    expect(await verify(image(), { at: new Date(now.getTime() - 301_000) })).toEqual({
      kind: "error",
      error: "WEBHOOK_TIMESTAMP_SKEWED",
    });
    expect(() =>
      createWechatMessageSource({
        cryptoConfig: { ...config, encodingAESKey: "bad" },
        findWechatIdentityId: async () => null,
      }),
    ).toThrow("配置");
    expect(source().reply(false, "WEBHOOK_SIGNATURE_INVALID")).toEqual({
      kind: "reply",
      status: 401,
      body: "",
    });
    expect(source().reply(false, "WEBHOOK_PERSIST_FAILED")).toEqual({
      kind: "reply",
      status: 500,
      body: "",
    });
  });
  it("回复加密随机失败保持500，不吞成成功", async () => {
    const service = createWechatMessageSource({
      cryptoConfig: {
        ...config,
        randomBytes: () => {
          throw new Error("private-random");
        },
      },
      findWechatIdentityId: async () => null,
    });
    expect(
      await service.verify({
        ...request({ MsgType: "text", ToUserName: "gh", FromUserName: "customer", CreateTime: 1 }),
        now,
      }),
    ).toEqual({ kind: "error", error: "WEBHOOK_DECRYPT_FAILED" });
  });

  it.each([
    null,
    { event: "subscribe_msg_sent_event", wechatIdentityId: "bad", items: [] },
    {
      event: "subscribe_msg_sent_event",
      wechatIdentityId: null,
      items: [],
      FromUserName: "private",
    },
    {
      event: "subscribe_msg_sent_event",
      wechatIdentityId: null,
      items: [{ templateId: "t", openid: "private" }],
    },
    {
      event: "wxa_media_check",
      traceId: "t",
      result: { suggest: "pass", label: 1, raw: "private" },
    },
  ])("restore 不复活坏/敏感载荷 %#", async (payload) => {
    await expect(source().restore(restored(payload))).rejects.toThrow("载荷");
  });
});

it("官方原生risky审核值进入安全payload，尚不在来源映射block", async () => {
  const service = source();
  const checked = await service.verify({
    ...request(image({ result: { suggest: "risky", label: 100 } })),
    now,
  });
  expect(checked.kind).toBe("event");
  if (checked.kind !== "event") throw new Error("原生risky拒绝");
  expect(service.payload(checked.event)).toEqual({
    event: "wxa_media_check",
    traceId: "trace-test",
    result: { suggest: "risky", label: 100 },
  });
});
it("非原生block不是协议suggest，来源受控拒绝", async () => {
  expect(await verify(image({ result: { suggest: "block", label: 100 } }))).toEqual({
    kind: "error",
    error: "WEBHOOK_PAYLOAD_INVALID",
  });
});

it("官方List单对象归一成数组，保留64位MsgID字符串", async () => {
  const service = source();
  const checked = await service.verify({
    ...request(
      subscription(undefined, {
        List: {
          TemplateId: "official-t",
          MsgID: "1864323726461255680",
          ErrorCode: "0",
          ErrorStatus: "success",
        },
      }),
    ),
    now,
  });
  expect(checked.kind).toBe("event");
  if (checked.kind !== "event") throw new Error("单对象List拒绝");
  expect(service.payload(checked.event)).toEqual({
    event: "subscribe_msg_sent_event",
    wechatIdentityId: null,
    items: [
      {
        templateId: "official-t",
        msgId: "1864323726461255680",
        errorCode: "0",
        errorStatus: "success",
      },
    ],
  });
});

describe("微信消息来源：真实同事务收件与处理", () => {
  const database = useTestDatabase("services");
  const ctx = sampleSystemContext("hooks.wechat.message.receive");
  let prisma: PrismaClient;
  let userId: string;
  beforeAll(async () => {
    prisma = await database.prisma();
    userId = uuidv7();
    const phone = sealPhone(ringA, "merchant_user.phone_enc", "13800001111");
    await prisma.merchantUser.create({
      data: {
        id: userId,
        phoneEnc: phone.enc,
        phoneBidx: phone.bidx,
        phoneMask: phone.mask,
        phoneLast4: phone.last4,
        status: "active",
        sourceType: "organic",
        lastActiveAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  }, 120_000);
  const makeIdentity = (openid: string) =>
    prisma.wechatIdentity.create({
      data: {
        id: uuidv7(),
        merchantUserId: userId,
        appid: config.appid,
        openid,
        silentLoginEnabled: false,
        lastActiveAt: now,
        lastLoginAt: now,
        createdAt: now,
        updatedAt: now,
      },
    });
  // 测试注入与生产公开resolver相同的真实自然键查询，security不向上import identity。
  const resolve: WechatMessageSourceOptions["findWechatIdentityId"] = async (tx, input) => {
    const row = await tx.wechatIdentity.findUnique({
      where: { appid_openid: input },
      select: { id: true },
    });
    return row?.id ?? null;
  };
  const make = (overrides: Partial<WechatMessageSourceOptions> = {}) => {
    const sample = createSampleEvents(prisma);
    sample.clock.set(now);
    const service = createWechatMessageSource({
      cryptoConfig: config,
      findWechatIdentityId: resolve,
      ...overrides,
    });
    const hooks = createWebhooks({ ...sample, sources: [service] });
    return { sample, service, hooks };
  };
  const ready = async (hooks: ReturnType<typeof createWebhooks>, message: unknown) => {
    const input = request(message);
    const receipt = await hooks.prepare("wechat", input);
    if (receipt.kind !== "ready") throw new Error("本地合法消息未准备成功");
    return receipt;
  };
  const stored = (eventId: string) =>
    prisma.webhookEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: "wechat", eventId } },
    });
  const newSubscription = (openid: string) =>
    subscription(undefined, {
      FromUserName: openid,
      List: [{ TemplateId: "t-test", MsgID: uuidv7(), ErrorCode: "0" }],
      arbitrary: "private-extra",
    });
  const write = (tx: Tx, prefix: string) =>
    tx.bizSequence.upsert({
      where: { prefix_bizDate: { prefix, bizDate: now } },
      create: { prefix, bizDate: now, nextVal: 1 },
      update: { nextVal: { increment: 1 } },
    });

  it("GET/4客服/unknown真实prepare零事务零入箱与出站", async () => {
    const { sample, hooks } = make();
    const run = vi.spyOn(sample.tx, "run");
    const before = [await prisma.webhookEvent.count(), await prisma.outboxEvent.count()];
    const timestamp = String(Math.floor(now.getTime() / 1000));
    expect(
      await hooks.prepare("wechat", {
        method: "GET",
        operationId: "hooks.wechat.message.verify",
        headers: {},
        rawBody: new Uint8Array(),
        query: {
          timestamp,
          nonce: "get",
          echostr: "echo",
          signature: sha1(config.token, timestamp, "get"),
        },
      }),
    ).toMatchObject({ status: 200, body: "echo" });
    for (const MsgType of ["text", "image", "miniprogrampage", "event"]) {
      expect(
        await hooks.prepare(
          "wechat",
          request({
            MsgType,
            Event: "user_enter_tempsession",
            ToUserName: "gh",
            FromUserName: "private-customer",
            CreateTime: 1,
            Content: "private-body",
          }),
        ),
      ).toMatchObject({ status: 200 });
    }
    expect(
      await hooks.prepare("wechat", request({ MsgType: "event", Event: "future" })),
    ).toMatchObject({ status: 200, body: "success" });
    expect(run).not.toHaveBeenCalled();
    expect([await prisma.webhookEvent.count(), await prisma.outboxEvent.count()]).toEqual(before);
  });

  it("官方非0errcode审核回调400零事务/入箱，不让无效pass进入领域", async () => {
    const handler = vi.fn(async () => "processed" as const);
    const { sample, hooks } = make({ handleImage: handler });
    const run = vi.spyOn(sample.tx, "run");
    const count = await prisma.webhookEvent.count();
    const outboxCount = await prisma.outboxEvent.count();
    expect(
      await hooks.prepare(
        "wechat",
        request(image({ errcode: -1008, result: { suggest: "pass", label: 100 } })),
      ),
    ).toEqual({ kind: "reply", status: 400, body: "" });
    expect(run).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(await prisma.webhookEvent.count()).toBe(count);
    expect(await prisma.outboxEvent.count()).toBe(outboxCount);
  });

  it("prepare后才绑定的当前身份在accept同TX投影与emit，openid/extra零持久化", async () => {
    const txids: string[] = [];
    let failure: unknown;
    const sample = createSampleEvents(prisma);
    sample.clock.set(now);
    const idOf = async (tx: Tx) =>
      (await tx.$queryRawUnsafe<Array<{ id: string }>>("SELECT txid_current()::text AS id"))[0]!.id;
    const lookup = vi.fn(async (tx: Tx, input: { appid: string; openid: string }) => {
      try {
        expect(isInTransaction()).toBe(true);
        expect(input.appid).toBe(config.appid);
        txids.push(await idOf(tx));
        return resolve(tx, input);
      } catch (error) {
        failure = error;
        throw error;
      }
    });
    const service = createWechatMessageSource({
      cryptoConfig: config,
      findWechatIdentityId: lookup,
    });
    const hooks = createWebhooks({
      ...sample,
      sources: [service],
      events: {
        emit: async (tx, ...args) => {
          txids.push(await idOf(tx));
          return sample.events.emit(tx, ...args);
        },
      },
    });
    const openid = `private-${uuidv7()}`;
    const message = newSubscription(openid);
    const receipt = await ready(hooks, message);
    expect(lookup).not.toHaveBeenCalled();
    const identity = await makeIdentity(openid);
    expect(await hooks.accept(receipt, ctx)).toEqual({
      kind: "reply",
      status: 200,
      body: "success",
    });
    expect(failure).toBeUndefined();
    expect(lookup).toHaveBeenCalledOnce();
    expect(txids).toHaveLength(2);
    expect(new Set(txids).size).toBe(1);
    const row = await stored(sha256(JSON.stringify(message)));
    expect(row.payload).toEqual({
      event: "subscribe_msg_sent_event",
      wechatIdentityId: identity.id,
      items: [{ templateId: "t-test", msgId: message.List[0]!.MsgID, errorCode: "0" }],
    });
    expect(Buffer.from(row.payloadDigest)).toEqual(
      createHash("sha256").update(request(message).rawBody).digest(),
    );
    expect(row).toMatchObject({
      receivedAt: now,
      processState: "received",
      attempts: 0,
      payloadPurgeAt: new Date(now.getTime() + 90 * 86400000),
    });
    const outbox = await prisma.outboxEvent.findMany({
      where: { dedupeKey: `webhook.received:${row.id}` },
    });
    expect(outbox).toHaveLength(1);
    const safe = JSON.stringify([row.payload, outbox[0]!.payload]);
    expect(safe).not.toContain(openid);
    expect(safe).not.toMatch(/private-extra|FromUserName|Encrypt|openid/);
  });

  it("projection失败以及emit失败都整TX回滚，真实合法消息仍回500空包体", async () => {
    for (const stage of ["lookup", "emit"]) {
      const { sample, service } = make({
        findWechatIdentityId: async (tx, input) => {
          if (stage === "lookup") throw new Error("private-openid-error");
          return resolve(tx, input);
        },
      });
      const hooks = createWebhooks({
        ...sample,
        sources: [service],
        events:
          stage === "emit"
            ? {
                emit: async () => {
                  throw new Error("private-emit-error");
                },
              }
            : sample.events,
      });
      const message = newSubscription(`unknown-${uuidv7()}`);
      expect(await hooks.accept(await ready(hooks, message), ctx)).toEqual({
        kind: "reply",
        status: 500,
        body: "",
      });
      expect(
        await prisma.webhookEvent.count({ where: { eventId: sha256(JSON.stringify(message)) } }),
      ).toBe(0);
    }
  });

  it("不匹配身份落合法null模板，整条ignored且不调handler或再次身份查", async () => {
    const handleSubscription = vi.fn(async () => "processed" as const);
    const lookup = vi.fn(resolve);
    const { sample, hooks } = make({ findWechatIdentityId: lookup, handleSubscription });
    const message = newSubscription(`noidentity-${uuidv7()}`);
    await hooks.accept(await ready(hooks, message), ctx);
    const row = await stored(sha256(JSON.stringify(message)));
    expect(row.payload).toMatchObject({ wechatIdentityId: null });
    expect(await sample.tx.run((tx) => hooks.process(tx, row.id, ctx))).toMatchObject({
      state: "ignored",
    });
    expect(handleSubscription).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("同一图片并发20收件/处理，只落一次入箱/emit/领域事实且first receivedAt保真", async () => {
    const handler = vi.fn(async (tx: Tx, input: WechatImageCallback) => {
      expect(input).toEqual({ traceId, result: { suggest: "risky", label: 100 }, receivedAt: now });
      await write(tx, "WSA");
      return "processed" as const;
    });
    const { sample, hooks } = make({ handleImage: handler });
    const traceId = uuidv7();
    const message = image({ trace_id: traceId });
    const eventId = sha256(`wxa_media_check:${traceId}`);
    const receipts = await Promise.all(Array.from({ length: 20 }, () => ready(hooks, message)));
    expect(
      (await Promise.all(receipts.map((receipt) => hooks.accept(receipt, ctx)))).every(
        (reply) => reply.status === 200,
      ),
    ).toBe(true);
    const row = await stored(eventId);
    expect(await prisma.webhookEvent.count({ where: { eventId } })).toBe(1);
    expect(
      await prisma.outboxEvent.count({ where: { dedupeKey: `webhook.received:${row.id}` } }),
    ).toBe(1);
    sample.clock.advance(1234);
    await Promise.all(
      Array.from({ length: 20 }, () => sample.tx.run((tx) => hooks.process(tx, row.id, ctx))),
    );
    expect(handler).toHaveBeenCalledOnce();
    expect((await prisma.bizSequence.findFirstOrThrow({ where: { prefix: "WSA" } })).nextVal).toBe(
      1,
    );
    const first = await stored(eventId);
    sample.clock.advance(3000);
    await hooks.accept(
      await ready(hooks, image({ trace_id: traceId, result: { suggest: "pass", label: 0 } })),
      ctx,
    );
    expect(await stored(eventId)).toEqual(first);
  });

  it("handler保存点回滚后重试，使用真实持久receivedAt且只提交一次领域写", async () => {
    const openid = `receipt-${uuidv7()}`;
    const identity = await makeIdentity(openid);
    let broken = true;
    const received: Date[] = [];
    const handler = vi.fn(async (tx: Tx, input: { receivedAt: Date; wechatIdentityId: string }) => {
      received.push(input.receivedAt);
      expect(input.wechatIdentityId).toBe(identity.id);
      await write(tx, "WSB");
      if (broken) throw new Error("private-handler-error");
      return "processed" as const;
    });
    const { sample, hooks } = make({ handleSubscription: handler });
    const message = newSubscription(openid);
    await hooks.accept(await ready(hooks, message), ctx);
    const row = await stored(sha256(JSON.stringify(message)));
    sample.clock.advance(1234);
    expect(await sample.tx.run((tx) => hooks.process(tx, row.id, ctx))).toMatchObject({
      state: "failed",
      attempts: 1,
    });
    expect(await prisma.bizSequence.count({ where: { prefix: "WSB" } })).toBe(0);
    expect((await stored(row.eventId)).error).toBe("WEBHOOK_HANDLER_FAILED");
    broken = false;
    sample.clock.advance(60000);
    expect(await sample.tx.run((tx) => hooks.process(tx, row.id, ctx))).toMatchObject({
      state: "processed",
    });
    expect(received).toEqual([now, now]);
    expect((await prisma.bizSequence.findFirstOrThrow({ where: { prefix: "WSB" } })).nextVal).toBe(
      1,
    );
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("未装配领域handler受控failed，不假processed或ignored", async () => {
    const { sample, hooks } = make();
    const traceId = uuidv7();
    await hooks.accept(await ready(hooks, image({ trace_id: traceId })), ctx);
    const row = await stored(sha256(`wxa_media_check:${traceId}`));
    expect(await sample.tx.run((tx) => hooks.process(tx, row.id, ctx))).toMatchObject({
      state: "failed",
      attempts: 1,
    });
    expect(await stored(row.eventId)).toMatchObject({
      processState: "failed",
      error: "WEBHOOK_HANDLER_FAILED",
      processedAt: null,
    });
  });

  it("真实40001重试重新查身份，不缓存投影也不丢私有openid", async () => {
    const openid = `retry-${uuidv7()}`;
    const identity = await makeIdentity(openid);
    const txids: string[] = [];
    const seen: string[] = [];
    const { hooks } = make({
      findWechatIdentityId: async (tx, input) => {
        seen.push(input.openid);
        txids.push(
          (await tx.$queryRawUnsafe<Array<{ id: string }>>("SELECT txid_current()::text AS id"))[0]!
            .id,
        );
        const id = await resolve(tx, input);
        if (seen.length === 1)
          await tx.$executeRawUnsafe(
            "DO $$ BEGIN RAISE EXCEPTION 'fixture retry' USING ERRCODE='40001'; END $$",
          );
        return id;
      },
    });
    const message = newSubscription(openid);
    expect(await hooks.accept(await ready(hooks, message), ctx)).toMatchObject({ status: 200 });
    expect(seen).toEqual([openid, openid]);
    expect(new Set(txids).size).toBe(2);
    const row = await stored(sha256(JSON.stringify(message)));
    expect(row).toMatchObject({
      payload: { wechatIdentityId: identity.id },
      attempts: 0,
      error: null,
    });
    expect(
      await prisma.outboxEvent.count({ where: { dedupeKey: `webhook.received:${row.id}` } }),
    ).toBe(1);
  });

  it("重放期间解绑重绑不覆盖第一次安全身份投影和收件举证", async () => {
    const openid = `rebind-${uuidv7()}`;
    const firstIdentity = await makeIdentity(openid);
    const { hooks } = make();
    const message = newSubscription(openid);
    await hooks.accept(await ready(hooks, message), ctx);
    const first = await stored(sha256(JSON.stringify(message)));
    await prisma.wechatIdentity.delete({ where: { id: firstIdentity.id } });
    const secondIdentity = await makeIdentity(openid);
    expect(secondIdentity.id).not.toBe(firstIdentity.id);
    expect(await hooks.accept(await ready(hooks, message), ctx)).toMatchObject({ status: 200 });
    expect(await stored(first.eventId)).toEqual(first);
    expect(first.payload).toMatchObject({ wechatIdentityId: firstIdentity.id });
    expect(
      await prisma.outboxEvent.count({ where: { dedupeKey: `webhook.received:${first.id}` } }),
    ).toBe(1);
  });

  it("处理器TX中调用Provider仍被正式guard拒绝，零外呼且保留受控重试", async () => {
    const sample = createSampleEvents(prisma);
    sample.clock.set(now);
    const providers = createFakeProviders({ clock: sample.clock });
    const source = createWechatMessageSource({
      cryptoConfig: config,
      findWechatIdentityId: resolve,
      handleImage: async () => {
        await providers.wechat.checkImage({
          mediaUrl: "https://fixture.invalid/image",
          scene: "profile",
          openid: "guard-fixture",
        });
        return "processed";
      },
    });
    const hooks = createWebhooks({ ...sample, sources: [source] });
    const traceId = uuidv7();
    await hooks.accept(await ready(hooks, image({ trace_id: traceId })), ctx);
    const row = await stored(sha256(`wxa_media_check:${traceId}`));
    expect(await sample.tx.run((tx) => hooks.process(tx, row.id, ctx))).toMatchObject({
      state: "failed",
    });
    expect(providers.wechat.calls).toHaveLength(0);
    expect((await stored(row.eventId)).error).toBe("WEBHOOK_HANDLER_FAILED");
  });

  it("恢复载荷敏感扩展拒绝且不进入领域handler", async () => {
    const handler = vi.fn(async () => "processed" as const);
    const { sample, hooks } = make({ handleImage: handler });
    const traceId = uuidv7();
    await hooks.accept(await ready(hooks, image({ trace_id: traceId })), ctx);
    const row = await stored(sha256(`wxa_media_check:${traceId}`));
    await prisma.webhookEvent.update({
      where: { id: row.id },
      data: {
        payload: {
          event: "wxa_media_check",
          traceId,
          result: { suggest: "risky", label: 100 },
          FromUserName: "private-injected",
        },
      },
    });
    expect(await sample.tx.run((tx) => hooks.process(tx, row.id, ctx))).toMatchObject({
      state: "failed",
    });
    expect(handler).not.toHaveBeenCalled();
    expect((await stored(row.eventId)).error).toBe("WEBHOOK_HANDLER_FAILED");
  });
});

it("正式optional字符串允许空值，不抬成必填或默认成功", async () => {
  const service = source();
  const checked = await service.verify({
    ...request(
      subscription(undefined, {
        List: [
          {
            TemplateId: "t",
            ErrorStatus: "",
            MsgID: "",
            ErrorCode: "",
            SubscribeStatusString: "",
            PopupScene: "",
          },
        ],
      }),
    ),
    now,
  });
  expect(checked.kind).toBe("event");
  if (checked.kind !== "event") throw new Error("optional空值拒绝");
  const payload = service.payload(checked.event);
  expect(payload).toEqual({
    event: "subscribe_msg_sent_event",
    wechatIdentityId: null,
    items: [
      { templateId: "t", errorStatus: "", msgId: "", errorCode: "", status: "", popupScene: "" },
    ],
  });
  expect(await service.restore(restored(payload))).toEqual(payload);
});

it("未知事件只记录固定计数，不记录输入事件或敏感消息", async () => {
  const logger = { info: vi.fn() };
  const service = createWechatMessageSource({
    cryptoConfig: config,
    findWechatIdentityId: async () => null,
    logger,
  });
  expect(
    await service.verify({
      ...request({
        MsgType: "event",
        Event: "private-unknown-event",
        FromUserName: "private-openid",
        Content: "private-body",
      }),
      now,
    }),
  ).toMatchObject({ kind: "skip" });
  expect(logger.info).toHaveBeenCalledExactlyOnceWith(
    { kind: "wechat_unregistered_event", count: 1 },
    "微信未登记消息",
  );
  expect(JSON.stringify(logger.info.mock.calls)).not.toContain("private");
});

it.each([-1008, 1, "0", false, null, {}])(
  "官方result无效errcode %# 时拒绝伪pass",
  async (errcode) => {
    expect(await verify(image({ errcode, result: { suggest: "pass", label: 100 } }))).toEqual({
      kind: "error",
      error: "WEBHOOK_PAYLOAD_INVALID",
    });
  },
);
it("官方errcode0的有效result与h01缺省errcode保持兼容", async () => {
  expect((await verify(image({ errcode: 0 }))).kind).toBe("event");
  expect((await verify(image())).kind).toBe("event");
});
