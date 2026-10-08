import { IdSchema, z } from "@liyoxi/contract";
import { assertPermission } from "../authz/index.js";
import { record } from "../audit/index.js";
import { AppError, createActor } from "../kernel/index.js";
import type { AppEnv, Clock, RecurringRunContext, Tx, TxRunner } from "../kernel/index.js";
import type { StorageProvider } from "../providers/types.js";
import { loadCliStaffContext } from "../staff/index.js";
import {
  analyticsMonth,
  analyticsPartitionName,
  analyticsRetention,
  currentAnalyticsMonth,
  offsetAnalyticsMonth,
} from "./partition-month.js";
import { archiveAnalyticsPartition, assertAnalyticsActive } from "./partition-archive.js";

export interface AnalyticsPartitionsDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly appEnv: AppEnv;
  /** 构造不调用它，组合根只在Provider实际完成装配后运行任务。 */
  readonly storage: () => StorageProvider;
}
const cliSchema = z.strictObject({
  month: z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/),
  staffId: IdSchema,
  appEnv: z.enum(["local", "test", "stg", "prod"]),
  note: z
    .string()
    .trim()
    .refine((text) => Array.from(text).length >= 5 && Array.from(text).length <= 200),
});
export type AnalyticsRepartitionInput = z.infer<typeof cliSchema>;
async function ensure(tx: Tx, month: string): Promise<void> {
  const result = await tx.$queryRawUnsafe<Array<{ name: string }>>(
    "SELECT public.lyx_14_analytics_event_ensure_partition($1::date) AS name",
    `${month}-01`,
  );
  if (result[0]?.name !== analyticsPartitionName(month))
    throw new TypeError("analytics受限能力返回结果不合法");
}
const meta = { requestId: null, ip: null, userAgent: null, authMethod: null, sessionId: null };

export function createAnalyticsPartitions(deps: AnalyticsPartitionsDeps) {
  return {
    async maintain(ctx: RecurringRunContext): Promise<Readonly<Record<string, unknown>>> {
      if (!ctx.runTx) throw new TypeError("analytics.partitions必须登记job模式");
      const runTx = ctx.runTx,
        now = deps.clock.now(),
        current = currentAnalyticsMonth(now);
      let built = 0,
        archived = 0,
        archivedRows = 0n;
      for (let offset = 0; offset <= 3; offset++) {
        assertAnalyticsActive(ctx.signal);
        await runTx(async (tx) => {
          assertAnalyticsActive(ctx.signal);
          await ensure(tx, offsetAnalyticsMonth(current, offset));
        });
        built++;
      }
      const eligible = await runTx(async (tx) => {
        assertAnalyticsActive(ctx.signal);
        const { boundary } = await analyticsRetention(tx, deps.clock.now());
        // 查询实际附属分区；DEFAULT、其他schema和任意关系名不进入归档候选。
        const rows = await tx.$queryRawUnsafe<Array<{ name: string }>>(`
          SELECT c.relname AS name FROM pg_catalog.pg_inherits i
          JOIN pg_catalog.pg_class c ON c.oid=i.inhrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE i.inhparent='public.analytics_event'::regclass AND n.nspname='public'
          AND c.relname ~ '^analytics_event_y[0-9]{4}m[0-9]{2}$' ORDER BY c.relname`);
        return rows
          .map((row) => analyticsMonth(row.name.slice(17).replace("m", "-")))
          .filter((month) => month < boundary);
      });
      for (const month of eligible) {
        assertAnalyticsActive(ctx.signal);
        // 先用已合入cap验证完整结构与只增guards，不持父锁等待对象存储。
        await runTx(async (tx) => {
          assertAnalyticsActive(ctx.signal);
          await ensure(tx, month);
        });
        const archive = await archiveAnalyticsPartition({
          month,
          runTx,
          storage: deps.storage(),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
        const retired = await runTx(async (tx) => {
          assertAnalyticsActive(ctx.signal);
          const at = deps.clock.now(),
            { months, boundary } = await analyticsRetention(tx, at);
          if (month >= boundary) throw new AppError("STATE_NOT_ALLOWED");
          const result = await tx.$queryRawUnsafe<Array<{ retired: boolean }>>(
            "SELECT public.lyx_14_analytics_event_retire_partition($1::date,$2::timestamptz,$3::integer,$4::bigint,$5::text) AS retired",
            `${month}-01`,
            at,
            months,
            archive.rows,
            archive.manifest.sha256,
          );
          if (result[0]?.retired)
            await record(tx, createActor({ type: "system", job: "analytics.partitions" }), meta, {
              stream: "ops",
              category: "system_ops",
              action: "analytics.partition.archive",
              summary: "埋点整月已归档并退役",
              target: { type: "analytics_event", id: month },
              meta: {
                manifestKey: archive.manifest.key,
                sha256: archive.manifest.sha256,
                rows: archive.rows.toString(),
                chunks: archive.chunks,
              },
            });
          return result[0]?.retired === true;
        });
        if (retired) {
          archived++;
          archivedRows += archive.rows;
        }
      }
      return { built, archived, archivedRows: archivedRows.toString() };
    },
    async repartition(input: AnalyticsRepartitionInput, signal?: AbortSignal) {
      const parsed = cliSchema.safeParse(input);
      if (!parsed.success || parsed.data.appEnv !== deps.appEnv)
        throw new AppError("VALIDATION_FAILED");
      assertAnalyticsActive(signal);
      const value = parsed.data;
      return deps.tx.run(async (tx) => {
        assertAnalyticsActive(signal);
        const ctx = await loadCliStaffContext(tx, value.staffId),
          at = deps.clock.now();
        assertPermission(ctx, "sys.super_admin", at);
        const { boundary } = await analyticsRetention(tx, at);
        if (
          value.month < boundary ||
          value.month > offsetAnalyticsMonth(currentAnalyticsMonth(at), 3)
        )
          throw new AppError("VALIDATION_FAILED");
        const rows = await tx.$queryRawUnsafe<Array<{ moved: bigint }>>(
          "SELECT public.lyx_14_analytics_event_repartition_month($1::date) AS moved",
          `${value.month}-01`,
        );
        const moved = rows[0]?.moved;
        if (typeof moved !== "bigint") throw new TypeError("analytics受限能力返回结果不合法");
        await record(
          tx,
          createActor({ type: "staff", id: ctx.staff.id, client: "cli" }),
          { ...meta, jobName: "cli.analytics_repartition", actorRole: ctx.staff.roleKey },
          {
            stream: "ops",
            category: "system_ops",
            action: "analytics.partition.repartition",
            summary: "修复埋点兜底分区",
            target: { type: "analytics_event", id: value.month },
            reason: { code: "other", text: value.note },
            meta: { moved: moved.toString() },
          },
        );
        return { month: value.month, moved: moved.toString() };
      });
    },
  };
}
export type AnalyticsPartitions = ReturnType<typeof createAnalyticsPartitions>;
