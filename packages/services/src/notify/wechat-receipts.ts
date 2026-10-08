import type { Clock, IdentityContext, Tx } from "../kernel/index.js";

export interface WechatReceiptInput {
  readonly event:
    "subscribe_msg_sent_event" | "subscribe_msg_change_event" | "subscribe_msg_popup_event";
  readonly wechatIdentityId: string;
  readonly items: readonly {
    readonly templateId: string;
    readonly msgId?: string;
    readonly status?: string;
    readonly errorCode?: string;
    readonly errorStatus?: string;
    readonly popupScene?: string;
  }[];
  readonly receivedAt: Date;
}
export type WechatReceiptHandler = (
  tx: Tx,
  input: WechatReceiptInput,
  ctx: IdentityContext,
) => Promise<"processed" | "ignored">;

const text = (value: string | undefined, max: number): value is string =>
  value !== undefined && value.length > 0 && [...value].length <= max;

export function createWechatReceiptHandler(deps: {
  readonly clock: Clock;
  readonly logger: { info(fields: Readonly<Record<string, unknown>>, message: string): void };
}): WechatReceiptHandler {
  return async (tx, input, _ctx) => {
    let matched = 0;
    const items = [...input.items].sort(
      (a, b) =>
        a.templateId.localeCompare(b.templateId) || (a.msgId ?? "").localeCompare(b.msgId ?? ""),
    );
    for (const item of items) {
      if (!text(item.templateId, 64)) continue;
      if (input.event === "subscribe_msg_sent_event") {
        if (!text(item.msgId, 64) || !text(item.errorCode, 16)) continue;
        matched += await tx.$executeRaw`UPDATE notification_delivery d
          SET receipt_status = ${item.errorCode}, receipt_reported_at = ${input.receivedAt}::timestamptz
          WHERE d.channel = 'wx_subscribe' AND d.provider_msg_id = ${item.msgId}
            AND d.provider_template_id = ${item.templateId}
            AND d.receipt_status IS NULL AND d.receipt_reported_at IS NULL
            AND EXISTS (SELECT 1 FROM wechat_identity wi JOIN notification n ON n.id = d.notification_id
              WHERE wi.id = ${input.wechatIdentityId}::uuid AND d.target_ref = wi.id::text
                AND n.merchant_user_id = wi.merchant_user_id)`;
      } else if (input.event === "subscribe_msg_change_event") {
        const slots = await tx.wxTemplateSlot.findMany({
          where: { providerTemplateId: item.templateId },
          select: { slotKey: true },
          orderBy: { slotKey: "asc" },
        });
        for (const slot of slots)
          matched += await tx.$executeRaw`UPDATE wx_subscribe_quota q
            SET state = 'rejected', est_remaining = 0, updated_at = ${deps.clock.now()}::timestamptz
            WHERE q.wechat_identity_id = ${input.wechatIdentityId}::uuid
              AND q.wx_template_slot_key = ${slot.slotKey}
              AND (q.state <> 'rejected' OR q.est_remaining <> 0)
              AND EXISTS (SELECT 1 FROM wechat_identity wi JOIN wx_template_slot s ON s.slot_key = q.wx_template_slot_key
                WHERE wi.id = q.wechat_identity_id AND wi.merchant_user_id = q.merchant_user_id
                  AND s.provider_template_id = ${item.templateId})`;
      }
    }
    deps.logger.info(
      {
        evt: "wechat_subscription_receipt",
        event: input.event,
        itemCount: input.items.length,
        matchedCount: matched,
      },
      "微信订阅回执处理计数",
    );
    return input.event === "subscribe_msg_popup_event" || matched > 0 ? "processed" : "ignored";
  };
}
