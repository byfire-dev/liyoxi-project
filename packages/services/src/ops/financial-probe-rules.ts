import { z } from "zod";
import type { AlertInput } from "../kernel/index.js";
import type { SqlRunner } from "./binding.js";
import type { ProbeRule } from "./probe-rules.js";

const count = z.number().int().nonnegative();
const facts = z.object({
  oldest: z.date().nullable(),
  expired: count,
  processing: count,
  abnormal: count,
  createdFailed: count,
});

/** D7 §9.4 第3–5项及D2 §16：只取持久资金事实，不查渠道、不入账或驱动退款。 */
export function financialProbeRules(db: SqlRunner): readonly ProbeRule[] {
  return [
    {
      key: "billing",
      targets: [
        { rule: "billing.unfulfilled" },
        { rule: "billing.expired_order" },
        { rule: "billing.refund_stuck" },
      ],
      async sample(at) {
        const [v] = z
          .array(facts)
          .length(1)
          .parse(
            await db.$queryRawUnsafe(
              `SELECT
        (SELECT min(p.channel_success_at) FROM payment_txn p
          LEFT JOIN billing_order b ON b.id=p.billing_order_id
          WHERE p.status='succeeded' AND p.refunded_fen < p.channel_amount_fen
            AND (p.applied_at IS NULL OR b.fulfillment_status <> 'done')) AS oldest,
        (SELECT count(*)::int FROM billing_order
          WHERE status='pending_payment' AND expires_at < $1::timestamptz - interval '10 minute') AS expired,
        (SELECT count(*)::int FROM refund_txn
          WHERE status='processing' AND COALESCE(last_submit_at,created_at) < $1::timestamptz - interval '3 day') AS processing,
        (SELECT count(*)::int FROM refund_txn WHERE status='abnormal') AS abnormal,
        (SELECT count(*)::int FROM refund_txn
          WHERE status='created' AND fail_code IS NOT NULL AND fail_code <> ''
            AND COALESCE(last_submit_at,created_at) < $1::timestamptz - interval '1 hour') AS "createdFailed"`,
              at,
            ),
          );
        const result: AlertInput[] = [];
        const seconds = v!.oldest ? Math.max(0, (at.getTime() - v!.oldest.getTime()) / 1000) : 0;
        if (seconds > 120)
          result.push({
            rule: "billing.unfulfilled",
            severity: seconds > 600 ? "P1" : "P2",
            detail: { oldestAgeSec: seconds },
          });
        if (v!.expired > 0)
          result.push({
            rule: "billing.expired_order",
            severity: "P2",
            detail: { count: v!.expired },
          });
        if (v!.processing > 0 || v!.abnormal > 0 || v!.createdFailed > 0)
          result.push({
            rule: "billing.refund_stuck",
            severity: v!.abnormal > 0 ? "P1" : "P2",
            detail: {
              processing: v!.processing,
              abnormal: v!.abnormal,
              createdFailed: v!.createdFailed,
            },
          });
        return result;
      },
    },
  ];
}
