import { z } from "zod";
import type { AlertInput } from "../kernel/index.js";
import type { SqlRunner } from "./binding.js";

export interface ProbeRule {
  readonly key: string;
  readonly targets: readonly Pick<AlertInput, "rule" | "dimension">[];
  sample(at: Date): Promise<readonly AlertInput[]>;
}
const count = z.number().int().nonnegative();
const timestamp = z.date().nullable();
const age = (now: Date, since: Date | null) =>
  since ? Math.max(0, (now.getTime() - since.getTime()) / 1000) : 0;
function breach(
  rule: string,
  value: number,
  p2: number,
  p1 = Infinity,
  dimension?: string,
): AlertInput[] {
  return value > p2
    ? [
        {
          rule,
          severity: value > p1 ? "P1" : "P2",
          detail: { value },
          ...(dimension ? { dimension } : {}),
        },
      ]
    : [];
}

/** 仅登记已实现的真实测量；缺行/错误类型抛错，绝不把失败当健康零值。 */
export function sqlProbeRules(db: SqlRunner): readonly ProbeRule[] {
  async function query<T>(sql: string, schema: z.ZodType<T>, at: Date): Promise<T> {
    const rows = await db.$queryRawUnsafe<unknown[]>(sql, at);
    if (rows.length !== 1) throw new TypeError("探针聚合结果不完整");
    return schema.parse(rows[0]);
  }
  return [
    {
      key: "outbox",
      targets: [
        { rule: "outbox.unpublished" },
        { rule: "outbox.delivery_lag" },
        { rule: "outbox.dead" },
      ],
      async sample(at) {
        const v = await query(
          `SELECT
          (SELECT min(occurred_at) FROM outbox_event WHERE published_at IS NULL) AS event,
          (SELECT min(next_attempt_at) FROM outbox_delivery WHERE status IN ('pending','retry','leased') AND next_attempt_at <= $1) AS delivery,
          (SELECT count(*)::int FROM outbox_delivery WHERE status='dead') AS dead`,
          z.object({ event: timestamp, delivery: timestamp, dead: count }),
          at,
        );
        return [
          ...breach("outbox.unpublished", age(at, v.event), 60, 300),
          ...breach("outbox.delivery_lag", age(at, v.delivery), 300, 900),
          ...breach("outbox.dead", v.dead, 0, 0),
        ];
      },
    },
    {
      key: "timer",
      targets: [{ rule: "timer.lag" }, { rule: "timer.failures" }, { rule: "timer.lost_dispatch" }],
      async sample(at) {
        const v = await query(
          `SELECT
          min(COALESCE(retry_at,fire_at)) FILTER (WHERE status='scheduled' AND COALESCE(retry_at,fire_at) < $1) AS oldest,
          count(*) FILTER (WHERE status='failed')::int AS failed,
          count(*) FILTER (WHERE status='dispatched' AND lease_until < $1 AND is_enqueued)::int AS lost FROM timer`,
          z.object({ oldest: timestamp, failed: count, lost: count }),
          at,
        );
        return [
          ...breach("timer.lag", age(at, v.oldest), 120, 600),
          ...breach("timer.failures", v.failed, 0),
          ...breach("timer.lost_dispatch", v.lost, 0),
        ];
      },
    },
    {
      key: "invariant",
      targets: [
        { rule: "invariant.unresolved", dimension: "P1" },
        { rule: "invariant.unresolved", dimension: "P2" },
      ],
      async sample(at) {
        const v = await query(
          `SELECT count(*) FILTER (WHERE severity='P1')::int AS p1,
          count(*) FILTER (WHERE severity<>'P1')::int AS p2 FROM invariant_violation
          WHERE resolved_at IS NULL AND $1::timestamptz IS NOT NULL`,
          z.object({ p1: count, p2: count }),
          at,
        );
        return [
          ...breach("invariant.unresolved", v.p1, 0, 0, "P1"),
          ...breach("invariant.unresolved", v.p2, 0, Infinity, "P2"),
        ];
      },
    },
    {
      key: "webhook",
      targets: [{ rule: "webhook.backlog" }],
      async sample(at) {
        const v = await query(
          `SELECT count(*) FILTER (WHERE process_state='dead')::int AS dead,
          count(*) FILTER (WHERE process_state='failed' OR (process_state='received' AND received_at < $1::timestamptz - interval '10 minute'))::int AS lag FROM webhook_event`,
          z.object({ dead: count, lag: count }),
          at,
        );
        return breach("webhook.backlog", v.dead + v.lag, 0, v.dead > 0 ? 0 : Infinity);
      },
    },
  ];
}
