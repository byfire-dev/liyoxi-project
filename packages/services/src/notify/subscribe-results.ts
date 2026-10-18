import { SubscribeResultBodySchema } from "@liyoxi/contract";
import type { Bootstrap, SubscribeResultBody, SubscribeResultOutcome } from "@liyoxi/contract";
import { SUBSCRIBE_POINTS } from "@liyoxi/contract/notify";
import type { SubscribePoint } from "@liyoxi/contract/notify";
import { AppError } from "../kernel/index.js";
import type { Alerts, Clock, IdempotencyContext, Tx, TxRunner } from "../kernel/index.js";
import type { Params } from "../config/index.js";
import type { WxTemplateSlotKey } from "./seed-data.js";

const POINT_SLOTS = {
  profile_submit: ["review_result"],
  pay_success: ["pay_result", "svc_expiry", "quota_change"],
  transfer_submit: ["pay_result"],
  order_submit: ["order_result", "service_progress", "quota_change"],
  plan_confirm: ["service_progress", "todo_remind"],
  ad_submit: ["service_progress", "quota_change"],
  ad_confirm: ["service_progress", "quota_change"],
  sample_confirm: ["service_progress", "todo_remind"],
  package_download: ["todo_remind", "review_result"],
  link_submit: ["review_result", "todo_remind"],
  offline_confirm: ["review_result"],
  ticket_submit: ["ticket_reply"],
  ticket_reply: ["ticket_reply"],
  invoice_apply: ["invoice_result"],
  renew_enter: ["svc_expiry", "pay_result"],
  member_invite: ["member_change"],
  member_join: ["member_change"],
  asset_upload: ["asset_feedback"],
  notify_settings: [
    "pay_result",
    "order_result",
    "refund_result",
    "invoice_result",
    "service_progress",
    "todo_remind",
    "review_result",
    "svc_expiry",
    "quota_change",
    "ticket_reply",
    "member_change",
    "asset_feedback",
  ],
} as const satisfies Record<SubscribePoint, readonly WxTemplateSlotKey[]>;

/** 固定次序，仅实际 active 且已配置槽位。模式由 owning billing 的正式策略读取后传入。 */
export async function readSubscribePlan(
  tx: Tx,
  input: { purchaseMode: "in_app" | "offline_contract" | "hidden" },
): Promise<NonNullable<Bootstrap["subscribePlan"]>> {
  const rows = await tx.wxTemplateSlot.findMany({
    where: { status: "active", providerTemplateId: { not: null } },
    select: { slotKey: true, providerTemplateId: true },
  });
  const templates = new Map(rows.map((row) => [row.slotKey, row.providerTemplateId]));
  return SUBSCRIBE_POINTS.flatMap(({ key: point }) => {
    if (input.purchaseMode !== "in_app" && (point === "pay_success" || point === "renew_enter"))
      return [];
    const slots = POINT_SLOTS[point].flatMap((slotKey) => {
      if (
        input.purchaseMode === "hidden" &&
        (slotKey === "svc_expiry" || slotKey === "quota_change")
      )
        return [];
      const tmplId = templates.get(slotKey);
      return tmplId ? [{ slotKey, tmplId }] : [];
    });
    return slots.length === 0 ? [] : [{ point, slots }];
  });
}

export interface SubscribeResultsDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly params: Pick<Params, "get">;
  readonly alerts: Alerts;
  readonly logger: { info(fields: Readonly<Record<string, unknown>>, message?: string): void };
}
export interface SubscribePrincipal {
  readonly merchantUserId: string;
  readonly wechatIdentityId: string;
}
export function createSubscribeResults(deps: SubscribeResultsDeps) {
  return {
    async apply(
      principal: SubscribePrincipal,
      raw: SubscribeResultBody,
      options: { idem: IdempotencyContext },
    ): Promise<SubscribeResultOutcome> {
      const checked = SubscribeResultBodySchema.safeParse(raw);
      if (!checked.success) throw new AppError("VALIDATION_FAILED");
      const body = checked.data;
      if (
        options.idem.mode !== "required" ||
        options.idem.scope !== "m.subscribeResult.create" ||
        options.idem.key !== `subscribeReport:${body.reportId}`
      )
        throw new AppError("VALIDATION_FAILED");
      const now = deps.clock.now();
      const cap = await deps.params.get("notify.wx.quota_cap");
      const pendingAlerts: { rule: string; slotKey: string; result: string }[] = [];
      const outcome = await deps.tx.run(
        async (tx) => {
          pendingAlerts.length = 0;
          const identity = await tx.wechatIdentity.findFirst({
            where: { id: principal.wechatIdentityId, merchantUserId: principal.merchantUserId },
            select: { id: true },
          });
          if (!identity) throw new AppError("AUTH_REQUIRED");
          const rows = await tx.wxTemplateSlot.findMany({
            where: { providerTemplateId: { in: body.results.map((item) => item.tmplId) } },
            select: { slotKey: true, providerTemplateId: true },
          });
          const slots = new Map(rows.map((row) => [row.providerTemplateId, row.slotKey]));
          const result = { appliedCount: 0, ignoredCount: 0 };
          for (const item of body.results) {
            const slot = slots.get(item.tmplId);
            if (slot && (item.result === "ban" || item.result === "filter"))
              pendingAlerts.push({
                rule: item.result === "ban" ? "notify.wx_banned" : "notify.wx_filtered",
                slotKey: slot,
                result: item.result,
              });
            if (!slot || item.result === "reject" || item.result === "filter") {
              result.ignoredCount++;
              continue;
            }
            const ban = item.result === "ban";
            await tx.$executeRaw`INSERT INTO wx_subscribe_quota (wechat_identity_id, wx_template_slot_key, merchant_user_id, est_remaining, state, last_accept_at, created_at, updated_at)
            VALUES (${principal.wechatIdentityId}::uuid, ${slot}, ${principal.merchantUserId}::uuid, ${ban ? 0 : 1}, ${ban ? "banned" : "ok"}, ${ban ? null : now}::timestamptz, ${now}::timestamptz, ${now}::timestamptz)
            ON CONFLICT (wechat_identity_id, wx_template_slot_key) DO UPDATE SET
              est_remaining = CASE WHEN ${ban} THEN 0 ELSE LEAST(wx_subscribe_quota.est_remaining + 1, ${cap}) END,
              state = ${ban ? "banned" : "ok"}, last_accept_at = CASE WHEN ${ban} THEN wx_subscribe_quota.last_accept_at ELSE ${now}::timestamptz END,
              updated_at = ${now}::timestamptz`;
            result.appliedCount++;
          }
          return result;
        },
        { idem: options.idem },
      );
      if (!options.idem.replayed) {
        // 日志与独立告警只在业务提交之后发生；不记模板编号、微信凭据或原始 body。
        for (const item of body.results) {
          deps.logger.info(
            { evt: "subscribe_report", point: body.point, result: item.result },
            "订阅授权结果已受理",
          );
        }
        for (const alert of pendingAlerts)
          await deps.alerts.raise({
            rule: alert.rule,
            dimension: alert.slotKey,
            severity: "P3",
            detail: { point: body.point, slotKey: alert.slotKey, result: alert.result },
          });
      }
      return outcome;
    },
  };
}
export type SubscribeResults = ReturnType<typeof createSubscribeResults>;
