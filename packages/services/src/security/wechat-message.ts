import { createHash } from "node:crypto";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { createWechatMessageCrypto } from "./wechat-message-crypto.js";
import type { WechatMessageCryptoConfig } from "./wechat-message-crypto.js";
import type {
  VerifiedWebhook,
  WebhookJson,
  WebhookOutcome,
  WebhookReply,
  WebhookSource,
  WebhookVerification,
} from "./webhooks/types.js";

export type WechatSubscriptionEvent =
  "subscribe_msg_sent_event" | "subscribe_msg_change_event" | "subscribe_msg_popup_event";
export type WechatSubscriptionItem = Readonly<{
  templateId: string;
  msgId?: string;
  status?: string;
  errorCode?: string;
  errorStatus?: string;
  popupScene?: string;
}>;
export interface WechatImageCallback {
  readonly traceId: string;
  readonly result: Readonly<{ suggest: "pass" | "review" | "risky"; label: number }>;
  readonly receivedAt: Date;
}
export interface WechatSubscriptionCallback {
  readonly event: WechatSubscriptionEvent;
  readonly wechatIdentityId: string;
  readonly items: readonly WechatSubscriptionItem[];
  readonly receivedAt: Date;
}
export interface WechatMessageSourceOptions {
  readonly logger?: {
    info(fields: Readonly<Record<string, unknown>>, message: string): void;
  };
  readonly cryptoConfig: WechatMessageCryptoConfig;
  readonly findWechatIdentityId: (
    tx: Tx,
    input: Readonly<{ appid: string; openid: string }>,
  ) => Promise<string | null>;
  readonly handleImage?: (
    tx: Tx,
    input: WechatImageCallback,
    ctx: IdentityContext,
  ) => Promise<WebhookOutcome>;
  readonly handleSubscription?: (
    tx: Tx,
    input: WechatSubscriptionCallback,
    ctx: IdentityContext,
  ) => Promise<WebhookOutcome>;
}

type ImagePayload = {
  event: "wxa_media_check";
  traceId: string;
  result: { suggest: "pass" | "review" | "risky"; label: number };
};
type SubscriptionPayload = {
  event: WechatSubscriptionEvent;
  wechatIdentityId: string | null;
  items: WechatSubscriptionItem[];
};
type SafePayload = ImagePayload | SubscriptionPayload;
const subscriptions: readonly string[] = [
  "subscribe_msg_sent_event",
  "subscribe_msg_change_event",
  "subscribe_msg_popup_event",
];
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value) as object | null);
const own = (value: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(value, key) ? value[key] : undefined;
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
// 项目防御界限，非平台公布的最大值；原 HTTP 入口仍负责流式字节限量。
const text = (value: unknown, max = 256): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  Buffer.byteLength(value, "utf8") <= max &&
  Buffer.from(value, "utf8").toString("utf8") === value;
const decimalText = (value: unknown, max: number): string | null => {
  const normalized =
    typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  return normalized === "" || text(normalized, max) ? normalized : null;
};
const invalid = (): WebhookVerification => ({ kind: "error", error: "WEBHOOK_PAYLOAD_INVALID" });
const success = (): WebhookReply => ({ kind: "reply", status: 200, body: "success" });
const payloadError = () => new TypeError("微信回调载荷非法");

function imageResult(value: unknown, strict: boolean): ImagePayload["result"] | null {
  if (!record(value) || (strict && !keys(value, ["suggest", "label"]))) return null;
  const suggest = own(value, "suggest");
  const label = own(value, "label");
  if (
    (suggest !== "pass" && suggest !== "review" && suggest !== "risky") ||
    typeof label !== "number" ||
    !Number.isSafeInteger(label)
  )
    return null;
  return { suggest, label };
}
function items(value: unknown, wire: boolean): WechatSubscriptionItem[] | null {
  if (wire && record(value)) value = [value];
  if (!Array.isArray(value) || value.length > 100) return null;
  const result: WechatSubscriptionItem[] = [];
  const mapping = [
    ["MsgID", "msgId", 256],
    ["SubscribeStatusString", "status", 64],
    ["ErrorCode", "errorCode", 64],
    ["ErrorStatus", "errorStatus", 256],
    ["PopupScene", "popupScene", 64],
  ] as const;
  for (const valueItem of value) {
    if (!record(valueItem)) return null;
    const templateId = own(valueItem, wire ? "TemplateId" : "templateId");
    if (!text(templateId)) return null;
    const item: {
      templateId: string;
      msgId?: string;
      status?: string;
      errorCode?: string;
      errorStatus?: string;
      popupScene?: string;
    } = { templateId };
    if (!wire && !keys(valueItem, ["templateId", ...mapping.map((entry) => entry[1])])) return null;
    for (const [raw, key, maximum] of mapping) {
      const field = wire ? raw : key;
      if (!Object.hasOwn(valueItem, field)) continue;
      const converted = wire
        ? decimalText(valueItem[field], maximum)
        : valueItem[field] === "" || text(valueItem[field], maximum)
          ? valueItem[field]
          : null;
      if (typeof converted !== "string") return null;
      item[key] = converted;
    }
    result.push(item);
  }
  return result;
}
function safePayload(value: unknown): SafePayload | null {
  if (!record(value)) return null;
  const event = own(value, "event");
  if (event === "wxa_media_check") {
    const traceId = own(value, "traceId");
    const result = imageResult(own(value, "result"), true);
    return keys(value, ["event", "traceId", "result"]) && text(traceId) && result
      ? { event, traceId, result }
      : null;
  }
  if (
    typeof event !== "string" ||
    !subscriptions.includes(event) ||
    !keys(value, ["event", "wechatIdentityId", "items"])
  )
    return null;
  const id = own(value, "wechatIdentityId");
  const list = items(own(value, "items"), false);
  if ((id !== null && !uuid(id)) || !list) return null;
  return { event: event as WechatSubscriptionEvent, wechatIdentityId: id, items: list };
}
const restoredPayload = (value: unknown): SafePayload => {
  const parsed = safePayload(value);
  if (!parsed) throw payloadError();
  return parsed;
};

/** h01 小程序消息：本地验签、同 TX 去敏身份投影；领域处理仅经注入的 Tx 口。 */
export function createWechatMessageSource(options: WechatMessageSourceOptions): WebhookSource {
  const crypto = createWechatMessageCrypto(options.cryptoConfig);
  const appid = options.cryptoConfig.appid;
  if (typeof options.findWechatIdentityId !== "function")
    throw new TypeError("微信身份投影配置非法");
  const preflight = (event: VerifiedWebhook): SafePayload => {
    if (!record(event.data)) throw payloadError();
    return restoredPayload(own(event.data, "payload"));
  };
  return {
    provider: "wechat",
    mode: "inbox",
    async verify(input) {
      if (input.method === "GET") {
        const checked = crypto.verifyGet({ query: input.query ?? {}, now: input.now });
        return checked.ok
          ? {
              kind: "reply",
              status: 200,
              body: checked.value,
              headers: { "Content-Type": "text/plain" },
            }
          : { kind: "error", error: checked.error };
      }
      if (input.method !== "POST") return invalid();
      const checked = crypto.decryptPostDetailed({
        query: input.query ?? {},
        rawBody: input.rawBody,
        now: input.now,
      });
      if (!checked.ok) return { kind: "error", error: checked.error };
      const message = checked.value.message;
      const msgType = own(message, "MsgType");
      const event = own(message, "Event");
      if (!text(msgType, 64) || (msgType === "event" && !text(event, 64))) return invalid();
      if (
        ["text", "image", "miniprogrampage"].includes(msgType) ||
        (msgType === "event" && event === "user_enter_tempsession")
      ) {
        const to = own(message, "ToUserName");
        const from = own(message, "FromUserName");
        const created = own(message, "CreateTime");
        if (
          !text(to) ||
          !text(from) ||
          typeof created !== "number" ||
          !Number.isSafeInteger(created) ||
          created < 0
        )
          return invalid();
        const reply = crypto.encryptReply({
          plaintext: JSON.stringify({
            ToUserName: from,
            FromUserName: to,
            CreateTime: Math.floor(input.now.getTime() / 1000),
            MsgType: "transfer_customer_service",
          }),
          nonce: input.query?.["nonce"] ?? "",
          now: input.now,
        });
        return reply.ok
          ? {
              kind: "skip",
              reason: "passive_reply",
              reply: {
                kind: "reply",
                status: 200,
                body: JSON.stringify(reply.value),
                headers: { "Content-Type": "application/json" },
              },
            }
          : { kind: "error", error: reply.error };
      }
      if (
        msgType !== "event" ||
        (event !== "wxa_media_check" &&
          (typeof event !== "string" || !subscriptions.includes(event)))
      ) {
        options.logger?.info({ kind: "wechat_unregistered_event", count: 1 }, "微信未登记消息");
        return { kind: "skip", reason: "unregistered_event", reply: success() };
      }
      let payload: SafePayload;
      let openid: string | null = null;
      let eventId = checked.value.plaintextDigest;
      if (event === "wxa_media_check") {
        if (Object.hasOwn(message, "errcode") && own(message, "errcode") !== 0) return invalid();
        const traceId = own(message, "trace_id");
        const result = imageResult(own(message, "result"), false);
        if (!text(traceId) || !result) return invalid();
        payload = { event, traceId, result };
        eventId = createHash("sha256").update(`wxa_media_check:${traceId}`).digest("hex");
      } else {
        const from = own(message, "FromUserName");
        const list = items(own(message, "List"), true);
        if (!text(from) || !list) return invalid();
        openid = from;
        payload = { event: event as WechatSubscriptionEvent, wechatIdentityId: null, items: list };
      }
      return {
        kind: "event",
        event: { eventId, eventType: payload.event, data: { payload, openid } },
      };
    },
    payload: preflight,
    async projectPayload(tx, event) {
      const payload = preflight(event);
      if (payload.event === "wxa_media_check") return payload;
      if (!record(event.data) || !text(own(event.data, "openid"))) throw payloadError();
      const id = await options.findWechatIdentityId(tx, {
        appid,
        openid: event.data["openid"] as string,
      });
      if (id !== null && !uuid(id)) throw payloadError();
      return { ...payload, wechatIdentityId: id };
    },
    restore: async (row): Promise<WebhookJson> => restoredPayload(row.payload),
    async handle(tx, event, ctx) {
      const payload = restoredPayload(event.data);
      if (event.eventType !== payload.event) throw payloadError();
      if (payload.event !== "wxa_media_check" && payload.wechatIdentityId === null)
        return "ignored";
      const row = await tx.webhookEvent.findUnique({
        where: { id: event.id },
        select: { receivedAt: true },
      });
      if (!row) throw new Error("微信回调收件事实缺失");
      if (payload.event === "wxa_media_check") {
        if (!options.handleImage) throw new Error("微信图片回调处理尚未装配");
        return options.handleImage(
          tx,
          { traceId: payload.traceId, result: payload.result, receivedAt: row.receivedAt },
          ctx,
        );
      }
      if (!options.handleSubscription) throw new Error("微信订阅回调处理尚未装配");
      return options.handleSubscription(
        tx,
        {
          event: payload.event,
          wechatIdentityId: payload.wechatIdentityId!,
          items: payload.items,
          receivedAt: row.receivedAt,
        },
        ctx,
      );
    },
    reply(ok, error) {
      if (ok) return success();
      const status =
        error === "WEBHOOK_SIGNATURE_INVALID" ||
        error === "WEBHOOK_TIMESTAMP_SKEWED" ||
        error === "WEBHOOK_KEY_NOT_FOUND"
          ? 401
          : error === "WEBHOOK_PAYLOAD_INVALID"
            ? 400
            : error === "WEBHOOK_SOURCE_DISABLED"
              ? 404
              : 500;
      return { kind: "reply", status, body: "" };
    },
  };
}
