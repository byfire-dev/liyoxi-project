// 支付来源只消费真实密码学判别；明文仅在内存/业务列，收件箱只存摘要和密文。
import { z } from "zod";
import { AppError } from "../../kernel/index.js";
import type { Alerts } from "../../kernel/index.js";
import type { WebhookSource } from "../../security/index.js";
import type { WechatPayProvider, WechatPayTransaction } from "../../providers/types.js";
import type { WechatChannel } from "./wechat-channel.js";
const cipher = z.object({
  algorithm: z.literal("AEAD_AES_256_GCM"),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
  associated_data: z.string().optional(),
  original_type: z.string().optional(),
});
const summary = z.record(z.string(), z.json());
const eventData = z.object({
  resource: z.record(z.string(), z.json()),
  summary,
  resourceCipher: cipher,
});
const transaction = z.object({
  appid: z.string().min(1),
  mchid: z.string().min(1),
  out_trade_no: z.string().min(1),
  trade_state: z.literal("SUCCESS"),
  transaction_id: z.string().min(1),
  amount: z.object({
    total: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.literal("CNY").optional(),
  }),
  payer: z.object({ openid: z.string().min(1) }),
  attach: z.string().max(128).optional(),
  success_time: z.iso.datetime({ offset: true }),
  bank_type: z.string().optional(),
});
export function createWechatPaymentSource(options: {
  provider: () => WechatPayProvider;
  identity: () => { appid: string; mchid: string } | undefined;
  channel: () => WechatChannel;
  alerts: Alerts;
}): WebhookSource {
  const warn = async (reason: string, severity: "P1" | "P2" = "P2") => {
    await options.alerts
      .raise({ rule: "webhook.failing", dimension: "wechatpay", severity, detail: { reason } })
      .catch(() => {});
  };
  return {
    provider: "wechatpay",
    mode: "inline",
    fallbackToInbox: true,
    escalateAfter: 5,
    enabled: () => !!options.identity() && !!options.provider().notificationCrypto,
    async verify(input) {
      const crypto = options.provider().notificationCrypto;
      if (!crypto) return { kind: "error", error: "WEBHOOK_SOURCE_DISABLED" };
      const verified = crypto.verifyNotification(input);
      if (!verified.ok) {
        if (!verified.probe)
          await warn(verified.kind, verified.kind === "decrypt_failed" ? "P1" : "P2");
        const errors = {
          signature_invalid: "WEBHOOK_SIGNATURE_INVALID",
          timestamp_skewed: "WEBHOOK_TIMESTAMP_SKEWED",
          key_not_found: "WEBHOOK_KEY_NOT_FOUND",
          decrypt_failed: "WEBHOOK_DECRYPT_FAILED",
          payload_invalid: "WEBHOOK_PAYLOAD_INVALID",
        } as const;
        return { kind: "error", error: errors[verified.kind] };
      }
      if (!verified.notification)
        return {
          kind: "skip",
          reason: "unregistered_event",
          reply: { kind: "reply", status: 200, body: "" },
        };
      if (input.operationId !== "hooks.wechatpay.transaction.notify")
        return { kind: "error", error: "WEBHOOK_PAYLOAD_INVALID" };
      const data = eventData.parse({
        resource: verified.resource,
        summary: verified.summary,
        resourceCipher: verified.resourceCipher,
      });
      if (
        verified.eventType !== "TRANSACTION.SUCCESS" ||
        data.resource.appid !== options.identity()?.appid ||
        data.resource.mchid !== options.identity()?.mchid
      )
        await warn("unexpected_source");
      return {
        kind: "event",
        event: {
          eventId: verified.id,
          eventType: verified.eventType,
          keyVersion: verified.kid,
          data,
        },
      };
    },
    payload(event) {
      const data = eventData.parse(event.data);
      return { summary: data.summary, resourceCipher: data.resourceCipher };
    },
    async restore(row) {
      const payload = z.object({ summary, resourceCipher: cipher }).parse(row.payload);
      const crypto = options.provider().notificationCrypto;
      if (!crypto || !row.keyVersion) throw new AppError("WEBHOOK_DECRYPT_FAILED");
      const resource = crypto.reopenResource(payload.resourceCipher, row.keyVersion);
      if (!resource) throw new AppError("WEBHOOK_DECRYPT_FAILED");
      return eventData.parse({ ...payload, resource });
    },
    async handle(tx, event, ctx) {
      if (event.eventType !== "TRANSACTION.SUCCESS") return "ignored";
      const data = eventData.parse(event.data);
      const raw = transaction.parse(data.resource),
        identity = options.identity();
      if (!identity || raw.appid !== identity.appid || raw.mchid !== identity.mchid)
        return "ignored";
      const receipt = await tx.paymentTxn.findUnique({ where: { outTradeNo: raw.out_trade_no } });
      // PITR后的未知单号不凭回调虚造付款单或资格；账单/人工恢复另属明确入口。
      if (!receipt?.billingOrderId || receipt.channel !== "wechat_jsapi") return "ignored";
      const fact: WechatPayTransaction = {
        appid: raw.appid,
        mchid: raw.mchid,
        outTradeNo: raw.out_trade_no,
        tradeState: "SUCCESS",
        transactionId: raw.transaction_id,
        amountFen: raw.amount.total,
        payerOpenid: raw.payer.openid,
        successAt: new Date(raw.success_time),
        ...(raw.attach ? { attach: raw.attach } : {}),
        ...(raw.bank_type ? { bankType: raw.bank_type } : {}),
      };
      // inbox重处理不经过首收T1入口，仍需限制其领域锁等待。
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
      await options.channel().record(tx, receipt, fact, ctx, "callback");
      return "processed";
    },
    reply(ok, error) {
      return {
        kind: "reply",
        status: ok
          ? 200
          : error === "WEBHOOK_SOURCE_DISABLED"
            ? 404
            : error === "WEBHOOK_TIMESTAMP_SKEWED" ||
                error === "WEBHOOK_SIGNATURE_INVALID" ||
                error === "WEBHOOK_KEY_NOT_FOUND"
              ? 401
              : error === "WEBHOOK_PAYLOAD_INVALID"
                ? 400
                : error === "RATE_LIMITED"
                  ? 429
                  : 500,
        body: ok
          ? ""
          : JSON.stringify({ code: "FAIL", message: error ?? "WEBHOOK_PERSIST_FAILED" }),
        headers: { "Content-Type": "application/json; charset=utf-8" },
      };
    },
  };
}
