import { IdSchema } from "../../common/index.js";
import { z } from "../../zod.js";

export const WechatVerifyQuerySchema = z.object({
  signature: z.string().regex(/^[a-fA-F0-9]{40}$/),
  timestamp: z.string().regex(/^\d+$/),
  nonce: z.string().min(1).max(256),
  echostr: z.string().max(4096),
});
export const WechatMessageQuerySchema = z.object({
  signature: z.string().regex(/^[a-fA-F0-9]{40}$/),
  timestamp: z.string().regex(/^\d+$/),
  nonce: z.string().min(1).max(256),
  encrypt_type: z.literal("aes"),
  msg_signature: z.string().regex(/^[a-fA-F0-9]{40}$/),
});
export const WechatEncryptedMessageSchema = z.object({
  ToUserName: z.string().min(1),
  Encrypt: z.string().min(1),
});
export const WechatEncryptedReplySchema = z.strictObject({
  Encrypt: z.string(),
  MsgSignature: z.string(),
  TimeStamp: z.int().nonnegative(),
  Nonce: z.string(),
});
export const WechatSubscriptionItemSchema = z.strictObject({
  templateId: z.string().min(1),
  msgId: z.string().optional(),
  status: z.string().optional(),
  errorCode: z.string().optional(),
  errorStatus: z.string().optional(),
  popupScene: z.string().optional(),
});
export const WechatMessagePayloadSchema = z.discriminatedUnion("event", [
  z.strictObject({
    event: z.literal("wxa_media_check"),
    traceId: z.string().min(1),
    result: z.strictObject({ suggest: z.enum(["pass", "review", "risky"]), label: z.int() }),
  }),
  z.strictObject({
    event: z.enum([
      "subscribe_msg_sent_event",
      "subscribe_msg_change_event",
      "subscribe_msg_popup_event",
    ]),
    wechatIdentityId: IdSchema.nullable(),
    items: z.array(WechatSubscriptionItemSchema),
  }),
]);
