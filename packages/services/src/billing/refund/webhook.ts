import { z } from "zod";
import { alertsOf, AppError } from "../../kernel/index.js";
import type { WebhookSource } from "../../security/index.js";
import type { WechatPayProvider, WechatPayRefund } from "../../providers/types.js";
import type { RefundDeps } from "./context.js";
import { recordRefundResult } from "./result.js";

const cipher = z.object({
  algorithm: z.literal("AEAD_AES_256_GCM"),
  ciphertext: z.string().min(1),
  nonce: z.string().min(1),
  associated_data: z.string().optional(),
  original_type: z.string().optional(),
});
const stored = z.object({ summary: z.record(z.string(), z.json()), resourceCipher: cipher });
const data = stored.extend({ resource: z.record(z.string(), z.json()) });
const resource = z.object({
  mchid: z.string().min(1),
  out_trade_no: z.string().min(1),
  out_refund_no: z.string().min(1),
  refund_id: z.string().min(1),
  refund_status: z.enum(["SUCCESS", "CLOSED", "ABNORMAL"]),
  amount: z.object({ refund: z.int().positive(), total: z.int().positive() }),
  success_time: z.iso.datetime({ offset: true }).optional(),
  user_received_account: z.string().optional(),
});
/** 共用wechatpay唯一来源；交易分支原样委托，不另注册一个同名provider。 */
export function createWechatRefundSource(options: {
  base: WebhookSource;
  provider: () => WechatPayProvider;
  identity: () => { mchid: string } | undefined;
  deps: () => RefundDeps;
}): WebhookSource {
  const base = options.base;
  return {
    ...base,
    async verify(input) {
      if (input.operationId !== "hooks.wechatpay.refund.notify") return base.verify(input);
      const crypto = options.provider().notificationCrypto;
      if (!crypto || !options.identity())
        return { kind: "error", error: "WEBHOOK_SOURCE_DISABLED" };
      const result = crypto.verifyNotification(input);
      if (!result.ok) {
        if (!result.probe)
          await alertsOf(options.deps().assembly).raise({
            rule: "webhook.failing",
            dimension: "wechatpay",
            severity: result.kind === "decrypt_failed" ? "P1" : "P2",
            detail: { reason: result.kind },
          });
        const errors = {
          signature_invalid: "WEBHOOK_SIGNATURE_INVALID",
          timestamp_skewed: "WEBHOOK_TIMESTAMP_SKEWED",
          key_not_found: "WEBHOOK_KEY_NOT_FOUND",
          decrypt_failed: "WEBHOOK_DECRYPT_FAILED",
          payload_invalid: "WEBHOOK_PAYLOAD_INVALID",
        } as const;
        return { kind: "error", error: errors[result.kind] };
      }
      if (
        result.notification?.kind !== "refund" ||
        !["REFUND.SUCCESS", "REFUND.CLOSED", "REFUND.ABNORMAL"].includes(result.eventType)
      )
        return { kind: "error", error: "WEBHOOK_PAYLOAD_INVALID" };
      const parsed = resource.safeParse(result.resource);
      if (
        !parsed.success ||
        parsed.data.mchid !== options.identity()?.mchid ||
        (parsed.data.refund_status === "SUCCESS" && !parsed.data.success_time)
      )
        return { kind: "error", error: "WEBHOOK_PAYLOAD_INVALID" };
      return {
        kind: "event",
        event: {
          eventId: result.id,
          eventType: result.eventType,
          keyVersion: result.kid,
          data: data.parse({
            resource: result.resource,
            summary: result.summary,
            resourceCipher: result.resourceCipher,
          }),
        },
      };
    },
    payload(event) {
      if (!event.eventType.startsWith("REFUND.")) return base.payload(event);
      const parsed = data.parse(event.data);
      return { summary: parsed.summary, resourceCipher: parsed.resourceCipher };
    },
    async restore(row) {
      if (!row.eventType.startsWith("REFUND.")) return base.restore(row);
      const parsed = stored.parse(row.payload),
        crypto = options.provider().notificationCrypto;
      if (!crypto || !row.keyVersion) throw new AppError("WEBHOOK_DECRYPT_FAILED");
      const opened = crypto.reopenResource(parsed.resourceCipher, row.keyVersion);
      if (!opened) throw new AppError("WEBHOOK_DECRYPT_FAILED");
      return data.parse({ ...parsed, resource: opened });
    },
    async handle(tx, event, ctx) {
      if (!event.eventType.startsWith("REFUND.")) return base.handle(tx, event, ctx);
      const raw = resource.parse(data.parse(event.data).resource);
      if (
        raw.mchid !== options.identity()?.mchid ||
        event.eventType !== `REFUND.${raw.refund_status}`
      )
        return "ignored";
      const txn = await tx.refundTxn.findUnique({ where: { outRefundNo: raw.out_refund_no } });
      if (!txn?.refundRequestId || txn.channel !== "wechat_jsapi") {
        await alertsOf(options.deps().assembly).raise({
          rule: "webhook.failing",
          dimension: "wechatpay",
          severity: "P1",
          detail: { reason: "unknown_refund", outRefundNo: raw.out_refund_no },
        });
        return "ignored";
      }
      const fact: WechatPayRefund = {
        outRefundNo: raw.out_refund_no,
        outTradeNo: raw.out_trade_no,
        refundId: raw.refund_id,
        status: raw.refund_status,
        refundFen: raw.amount.refund,
        ...(raw.success_time ? { successAt: new Date(raw.success_time) } : {}),
        ...(raw.user_received_account ? { userReceivedAccount: raw.user_received_account } : {}),
      };
      await recordRefundResult(tx, options.deps(), ctx, {
        refundTxnId: txn.id,
        fact,
        detectedBy: "callback",
      });
      return "processed";
    },
  };
}
