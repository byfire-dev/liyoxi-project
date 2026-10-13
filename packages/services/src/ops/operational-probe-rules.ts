import { z } from "zod";
import type { AlertInput } from "../kernel/index.js";
import { recurringKey, slotAtOrBefore } from "../timers/index.js";
import type { ScheduledJob } from "../timers/index.js";
import type { SqlRunner } from "./binding.js";
import type { ProbeRule } from "./probe-rules.js";

const recurringRow = z.object({
  kind: z.string(),
  status: z.string().nullable(),
  failed: z.boolean(),
});

/** 只检查所属环境真实装配的周期任务；没有完成期限的登记仍检查失败事实。 */
export function operationalProbeRules(
  db: SqlRunner,
  recurring: readonly ScheduledJob[],
  ping?: () => Promise<boolean>,
): readonly ProbeRule[] {
  const jobs = recurring.filter((job) => job.missSeverity !== undefined);
  const recurringRule: ProbeRule = {
    key: "recurring",
    targets: jobs.map((job) => ({ rule: "recurring.missed", dimension: job.kind })),
    async sample(at) {
      if (!jobs.length) return [];
      const checks = jobs.map((job) => {
        // 取最近已超过完成期限的一期，避免10分钟节奏/30分钟期限永远不超时。
        const cutoff = new Date(at.getTime() - (job.deadlineMin ?? 0) * 60_000 - 1);
        return {
          kind: job.kind,
          key: recurringKey(job.kind, slotAtOrBefore(job.schedule, cutoff)),
        };
      });
      const rows = z.array(recurringRow).parse(
        await db.$queryRawUnsafe(
          `SELECT j.kind, latest.status,
          EXISTS(SELECT 1 FROM timer f WHERE f.kind=j.kind AND f.subject_type IS NULL AND f.status='failed') AS failed
         FROM jsonb_to_recordset($1::jsonb) AS j(kind text,key text)
         LEFT JOIN LATERAL (SELECT status FROM timer t WHERE t.kind=j.kind AND t.subject_type IS NULL
           AND t.dedupe_key=j.key ORDER BY t.created_at DESC,t.id DESC LIMIT 1) latest ON true`,
          JSON.stringify(checks),
        ),
      );
      if (rows.length !== jobs.length || new Set(rows.map((row) => row.kind)).size !== jobs.length)
        throw new TypeError("周期探针结果不完整");
      const alerts: AlertInput[] = [];
      for (const job of jobs) {
        const row = rows.find((one) => one.kind === job.kind);
        if (!row) throw new TypeError("周期探针缺少登记项");
        if (row.failed || (job.deadlineMin !== undefined && row.status !== "fired"))
          alerts.push({
            rule: "recurring.missed",
            dimension: job.kind,
            severity: job.missSeverity!,
            detail: { failed: row.failed, status: row.status ?? "missing" },
          });
      }
      return alerts;
    },
  };
  return [
    recurringRule,
    {
      key: "database",
      targets: [{ rule: "db.long_transaction" }],
      async sample() {
        const rows = z
          .array(
            z.object({
              count: z.number().int().nonnegative(),
              hidden: z.number().int().nonnegative(),
            }),
          )
          .length(1)
          .parse(
            await db.$queryRawUnsafe(`SELECT
              count(*) FILTER(WHERE xact_start < clock_timestamp()-interval '60 second')::int AS count,
              count(*) FILTER(WHERE state IS NULL)::int AS hidden
            FROM pg_stat_activity WHERE datname=current_database()
              AND usename=session_user AND pid<>pg_backend_pid()`),
          );
        // SET ROLE 后登录角色仍为session_user；看不到兄弟连接状态时不能把未知当健康。
        if (rows[0]!.hidden > 0) throw new Error("数据库探针缺少同登录角色的统计可见性");
        return rows[0]!.count > 0
          ? [{ rule: "db.long_transaction", severity: "P2", detail: { count: rows[0]!.count } }]
          : [];
      },
    },
    ...(ping
      ? [
          {
            key: "redis",
            targets: [{ rule: "redis.unavailable" }],
            async sample(): Promise<readonly AlertInput[]> {
              const alive = await ping().catch(() => false);
              return alive
                ? []
                : [{ rule: "redis.unavailable", severity: "P2", detail: { available: false } }];
            },
          },
        ]
      : []),
  ];
}
