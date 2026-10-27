// h01 §2.5/3.14：API进程直接只读取数；每项独立超时，失败不伪装为0。
import type { PrismaClient } from "@liyoxi/db";
import type { Clock } from "../kernel/index.js";

export interface FinanceHealth {
  status: "ok" | "degraded";
  time: string;
  breaches: string[];
  unappliedReceipt: { count: number; oldestAgeSec: number | null } | null;
  workerHeartbeatAgeSec: number | null;
  timerLagSec: number | null;
  webhookBacklog: {
    pendingCount: number;
    deadCount: number;
    oldestPendingAgeSec: number | null;
  } | null;
  certificates:
    { kind: "merchant_api_cert" | "platform_cert"; expiresAt: string; daysLeft: number }[] | null;
  billing: {
    sweepLagSec: number | null;
    invariantRunAgeSec: number | null;
    openViolationCount: number | null;
    valuationAgeSec: number | null;
    oldestBlockedFulfillmentSec: number | null;
  };
}
export interface FinanceCertificateFact {
  kind: "merchant_api_cert" | "platform_cert";
  expiresAt: Date;
}
export interface FinanceHealthOptions {
  db: Pick<PrismaClient, "$queryRaw">;
  clock: Clock;
  cacheMs: number;
  timeoutMs: number;
  /** 仅本地配置证书事实，不得联网或读取密钥正文；缺少商户证书事实保持null。 */
  certificates?: () => Promise<readonly FinanceCertificateFact[]>;
}
const integer = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new Error("资金指标无有效整数事实");
  return value;
};
const age = (now: Date, at: Date | null, empty: 0 | null): number | null => {
  if (at === null) return empty;
  if (!(at instanceof Date) || !Number.isFinite(at.getTime()))
    throw new Error("资金指标无有效时间事实");
  return Math.max(0, Math.floor((now.getTime() - at.getTime()) / 1000));
};
export function createFinanceHealth(options: FinanceHealthOptions): () => Promise<FinanceHealth> {
  const { db, clock, cacheMs, timeoutMs } = options;
  let cached: { at: number; value: Promise<FinanceHealth> } | undefined;
  async function metric<T>(read: () => Promise<T>): Promise<T | null> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(read),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("资金指标取数超时")), timeoutMs);
        }),
      ]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  async function compute(): Promise<FinanceHealth> {
    const now = clock.now();
    const [
      unappliedReceipt,
      workerHeartbeatAgeSec,
      timerLagSec,
      webhookBacklog,
      certificates,
      sweepLagSec,
      invariantRunAgeSec,
      openViolationCount,
      valuationAgeSec,
      oldestBlockedFulfillmentSec,
    ] = await Promise.all([
      metric(async () => {
        const [row] = await db.$queryRaw<{ count: number; oldest: Date | null }[]>`
          SELECT count(*)::int AS count, min(p.channel_success_at) AS oldest FROM payment_txn p
          WHERE p.status='succeeded' AND p.applied_at IS NULL AND p.refunded_fen < p.channel_amount_fen
            AND p.channel_success_at < ${new Date(now.getTime() - 600_000)}
            AND NOT EXISTS (SELECT 1 FROM payment_exception e WHERE e.payment_txn_id=p.id AND e.status IN ('open','resolving'))`;
        if (!row) throw new Error("资金指标无聚合事实");
        const count = integer(row.count),
          oldestAgeSec = age(now, row.oldest, null);
        if (count > 0 && oldestAgeSec === null) throw new Error("收款缺少成功时间事实");
        return { count, oldestAgeSec };
      }),
      metric(async () => {
        const [row] = await db.$queryRaw<{ value: number }[]>`
          SELECT greatest(0,floor(extract(epoch FROM clock_timestamp()-heartbeat_at)))::int AS value
          FROM worker_lease WHERE name='primary'`;
        return row ? integer(row.value) : null;
      }),
      metric(async () => {
        const [row] = await db.$queryRaw<{ at: Date | null }[]>`
          SELECT min(COALESCE(retry_at,fire_at)) AS at FROM timer
          WHERE status='scheduled' AND COALESCE(retry_at,fire_at)<=${now}`;
        if (!row) throw new Error("资金指标无聚合事实");
        return age(now, row.at, 0);
      }),
      metric(async () => {
        const [row] = await db.$queryRaw<{ pending: number; dead: number; oldest: Date | null }[]>`
          SELECT (count(*) FILTER(WHERE process_state IN ('received','failed') AND received_at<${new Date(now.getTime() - 300_000)}))::int AS pending,
            (count(*) FILTER(WHERE process_state='dead'))::int AS dead,
            min(received_at) FILTER(WHERE process_state IN ('received','failed')) AS oldest
          FROM webhook_event WHERE provider='wechatpay'`;
        if (!row) throw new Error("资金指标无聚合事实");
        return {
          pendingCount: integer(row.pending),
          deadCount: integer(row.dead),
          oldestPendingAgeSec: age(now, row.oldest, null),
        };
      }),
      metric(async () => {
        const facts = await options.certificates?.();
        if (!facts?.some((item) => item.kind === "merchant_api_cert"))
          throw new Error("缺少商户API证书事实");
        return facts.map((fact) => {
          if (!(fact.expiresAt instanceof Date) || !Number.isFinite(fact.expiresAt.getTime()))
            throw new Error("证书期限事实无效");
          return {
            kind: fact.kind,
            expiresAt: fact.expiresAt.toISOString(),
            daysLeft: Math.floor((fact.expiresAt.getTime() - now.getTime()) / 86_400_000),
          };
        });
      }),
      metric(async () => {
        const [row] = await db.$queryRaw<{ at: Date | null }[]>`
          SELECT min(next_due_at) AS at FROM billing_account WHERE next_due_at<=${now}`;
        if (!row) throw new Error("资金指标无聚合事实");
        return age(now, row.at, 0);
      }),
      metric(async () => {
        const [row] = await db.$queryRaw<{ at: Date | null }[]>`
          SELECT max(finished_at) AS at FROM invariant_run WHERE mode='full' AND trigger='schedule' AND status='succeeded'`;
        if (!row) throw new Error("资金指标无聚合事实");
        return age(now, row.at, null);
      }),
      metric(async () => {
        const [row] = await db.$queryRaw<{ count: number }[]>`
          SELECT count(*)::int AS count FROM invariant_violation WHERE module='billing' AND resolved_at IS NULL`;
        if (!row) throw new Error("资金指标无聚合事实");
        return integer(row.count);
      }),
      metric(async () => {
        const [row] = await db.$queryRaw<{ at: Date | null }[]>`
          SELECT max(fired_at) AS at FROM timer WHERE kind='billing.sweep.daily' AND status='fired'`;
        if (!row) throw new Error("资金指标无聚合事实");
        return age(now, row.at, null);
      }),
      metric(async () => {
        const [row] = await db.$queryRaw<{ count: number; at: Date | null }[]>`
          SELECT count(*)::int AS count, min(paid_at) AS at FROM billing_order WHERE fulfillment_status='blocked' AND status='paid'`;
        if (!row) throw new Error("资金指标无聚合事实");
        if (integer(row.count) === 0) return 0;
        return age(now, row.at, null);
      }),
    ]);
    const values = {
      unappliedReceipt,
      workerHeartbeatAgeSec,
      timerLagSec,
      webhookBacklog,
      certificates,
    };
    const billing = {
      sweepLagSec,
      invariantRunAgeSec,
      openViolationCount,
      valuationAgeSec,
      oldestBlockedFulfillmentSec,
    };
    const breaches: string[] = [];
    for (const [key, value] of Object.entries(values)) if (value === null) breaches.push(key);
    for (const [key, value] of Object.entries(billing))
      if (value === null) breaches.push(`billing.${key}`);
    const breach = (key: string, failed: boolean) => {
      if (failed && !breaches.includes(key)) breaches.push(key);
    };
    breach("unappliedReceipt", (unappliedReceipt?.count ?? 0) > 0);
    breach("workerHeartbeatAgeSec", workerHeartbeatAgeSec !== null && workerHeartbeatAgeSec > 180);
    breach("timerLagSec", timerLagSec !== null && timerLagSec > 300);
    breach(
      "webhookBacklog",
      !!webhookBacklog && (webhookBacklog.pendingCount > 0 || webhookBacklog.deadCount > 0),
    );
    breach("certificates", !!certificates?.some((item) => item.daysLeft < 30));
    breach("billing.sweepLagSec", sweepLagSec !== null && sweepLagSec > 600);
    breach(
      "billing.invariantRunAgeSec",
      invariantRunAgeSec !== null && invariantRunAgeSec > 26 * 3600,
    );
    breach("billing.openViolationCount", openViolationCount !== null && openViolationCount > 0);
    breach("billing.valuationAgeSec", valuationAgeSec !== null && valuationAgeSec > 26 * 3600);
    breach(
      "billing.oldestBlockedFulfillmentSec",
      oldestBlockedFulfillmentSec !== null && oldestBlockedFulfillmentSec > 24 * 3600,
    );
    return {
      status: breaches.length ? "degraded" : "ok",
      time: now.toISOString(),
      breaches,
      ...values,
      billing,
    };
  }
  return () => {
    const at = performance.now();
    if (!cached || at - cached.at >= cacheMs) cached = { at, value: compute() };
    return cached.value;
  };
}
