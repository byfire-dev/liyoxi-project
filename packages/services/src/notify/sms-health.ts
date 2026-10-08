// W222 私有保活直发，不实现 W217 dispatch/sendDirect；无 Provider 内重试。
import type { PrismaClient } from "@liyoxi/db";
import { maskPhone } from "@liyoxi/shared/mask";
import { createConfig, paramsAt } from "../config/index.js";
import type { Config } from "../config/index.js";
import { uuidv7 } from "../kernel/index.js";
import type { Alerts, Clock, RecurringRunContext, TxRunner } from "../kernel/index.js";
import type { SmsProvider, SmsTemplateBinding } from "../providers/types.js";
import { phoneBidx } from "../security/index.js";
import type { Keyring } from "../security/index.js";
import { SMS_FIELDS, smsTemplateReader } from "./sms-init.js";
import { lockSmsBudget, smsDayUsage } from "./sms-budget.js";

export interface SmsHealthDeps {
  db: Pick<PrismaClient, "smsTemplate">;
  tx: TxRunner;
  clock: Clock;
  config: Config;
  sms: SmsProvider;
  alerts: Alerts;
  keyring: () => Keyring | null;
  env: "local" | "test" | "stg" | "prod";
}
const dayOf = (date: Date) => new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
function windowOpen(now: Date, start: string, end: string) {
  const hm = new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(11, 16);
  return hm >= start && hm < end;
}
export function smsFailureSuspect(recent: readonly { status: string }[]): boolean {
  return (
    (recent.slice(0, 5).length === 5 && recent.slice(0, 5).every((d) => d.status === "failed")) ||
    (recent.length > 0 && recent.filter((d) => d.status === "failed").length / recent.length > 0.5)
  );
}
function sameBinding(a: SmsTemplateBinding, b: SmsTemplateBinding) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function createSmsHealth(deps: SmsHealthDeps) {
  const readTemplate = smsTemplateReader(deps.db);
  const enabled = () => deps.config.flags.isEnabled("notify.sms.enabled", {});
  let closed = false;
  let closing: Promise<void> | undefined;
  const pending = new Set<{
    controller: AbortController;
    done: Promise<Readonly<Record<string, unknown>>>;
  }>();
  function owned(
    ctx: RecurringRunContext,
    run: (context: RecurringRunContext) => Promise<Readonly<Record<string, unknown>>>,
  ) {
    if (closed) return Promise.resolve({ outcome: "cancelled" });
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (ctx.signal?.aborted) abort();
    else ctx.signal?.addEventListener("abort", abort, { once: true });
    const call = {
      controller,
      done: Promise.resolve<Readonly<Record<string, unknown>>>({}),
    };
    call.done = run({ ...ctx, signal: controller.signal }).finally(() => {
      ctx.signal?.removeEventListener("abort", abort);
      pending.delete(call);
    });
    pending.add(call);
    return call.done;
  }
  async function inspectSuspect(
    row: { templateKey: string; updatedAt: Date },
    finished: Date,
    runTx: NonNullable<RecurringRunContext["runTx"]>,
  ) {
    const changed = await runTx(async (tx) => {
      const recent = await tx.notificationDelivery.findMany({
        where: {
          channel: "sms",
          smsTemplateKey: row.templateKey,
          status: { in: ["sent", "failed"] },
          callStartedAt: { not: null },
          OR: [{ status: "sent" }, { reason: { in: ["provider_rejected", "unknown_outcome"] } }],
          finishedAt: { gte: new Date(finished.getTime() - 30 * 86_400_000) },
        },
        orderBy: [{ finishedAt: "desc" }, { id: "desc" }],
        take: 10,
        select: { status: true },
      });
      const bad = smsFailureSuspect(recent);
      if (!bad) return false;
      const update = await tx.smsTemplate.updateMany({
        where: { templateKey: row.templateKey, status: "active", updatedAt: row.updatedAt },
        data: { status: "suspect", updatedAt: finished },
      });
      return update.count > 0;
    });
    if (changed)
      await deps.alerts.raise({
        rule: "notify.sms_suspect",
        dimension: row.templateKey,
        severity: "P3",
        detail: { templateKey: row.templateKey, criterion: "5_consecutive_or_recent_gt_half" },
      });
    return changed;
  }
  const service = {
    async balance(ctx: RecurringRunContext): Promise<Readonly<Record<string, unknown>>> {
      if (ctx.signal?.aborted) return { outcome: "cancelled" };
      if (!(await enabled())) return { outcome: "disabled" };
      if (!deps.sms.configured || deps.sms.status === "local")
        return { outcome: "provider_unconfigured" };
      // 正式参数尚无阈值，统计 API 只有限定创建窗口；不能推导全账号余量。
      const detail = {
        outcome: "unsupported",
        reason: "complete_package_scope_and_threshold_unconfigured",
        queried: false,
      } as const;
      await deps.alerts.raise({ rule: "notify.sms_balance_unconfigured", severity: "P3", detail });
      return detail;
    },
    async keepalive(ctx: RecurringRunContext): Promise<Readonly<Record<string, unknown>>> {
      if (!ctx.runTx) throw new TypeError("短信保活须在 job 模式运行");
      if (ctx.signal?.aborted) return { outcome: "cancelled" };
      if (!(await enabled())) return { outcome: "disabled" };
      if (!deps.sms.configured || deps.sms.status === "local")
        return { outcome: "provider_unconfigured" };
      let keyring: Keyring | null;
      try {
        keyring = deps.keyring();
      } catch {
        return { outcome: "pii_keys_unconfigured" };
      }
      if (!keyring) return { outcome: "pii_keys_unconfigured" };
      const recipients = await deps.config.params.get("notify.test_recipients");
      const targets = recipients.filter(
        (recipient) => recipient.phone && /^1[3-9]\d{9}$/.test(recipient.phone),
      );
      if (!targets.length) return { outcome: "no_internal_target" };
      const now = deps.clock.now();
      const start = await deps.config.params.get("notify.window.start");
      const end = await deps.config.params.get("notify.window.end");
      if (!windowOpen(now, start, end)) return { outcome: "outside_window" };
      const days = await deps.config.params.get("notify.sms.keepalive_days");
      // 仅收回本实现的过期 sending；没开始与结果不明分开，均不自动重发。
      await ctx.runTx(async (tx) => {
        const stale = await tx.notificationDelivery.findMany({
          where: {
            channel: "sms",
            purpose: "keepalive",
            directKey: { startsWith: "sms_keepalive:" },
            status: "sending",
            leaseUntil: { lte: now },
          },
          take: 100,
          orderBy: { leaseUntil: "asc" },
          select: { id: true, callStartedAt: true },
        });
        for (const started of [false, true])
          await tx.notificationDelivery.updateMany({
            where: {
              id: {
                in: stale
                  .filter((row) => (row.callStartedAt !== null) === started)
                  .map((row) => row.id),
              },
              status: "sending",
              leaseUntil: { lte: now },
              callStartedAt: started ? { not: null } : null,
            },
            data: {
              status: "failed",
              reason: started ? "unknown_outcome" : "claim_exhausted",
              finishedAt: now,
              leaseUntil: null,
              updatedAt: now,
            },
          });
      });
      const templates = await deps.db.smsTemplate.findMany({
        where: { kind: "notice", status: "active" },
        orderBy: { templateKey: "asc" },
        take: 9,
      });
      let sent = 0,
        failed = 0,
        skipped = 0,
        suspect = 0;
      for (const row of templates) {
        if (ctx.signal?.aborted) break;
        if (await inspectSuspect(row, deps.clock.now(), ctx.runTx)) {
          suspect++;
          skipped++;
          continue;
        }
        if (now.getTime() - (row.lastOkAt ?? row.updatedAt).getTime() < days * 86_400_000) {
          skipped++;
          continue;
        }
        const binding = await readTemplate(row.templateKey);
        const fields = Object.hasOwn(SMS_FIELDS, row.templateKey)
          ? SMS_FIELDS[row.templateKey]
          : undefined;
        if (!binding || !fields) {
          skipped++;
          continue;
        }
        const params = Object.fromEntries(fields.map((field) => [field.name, field.test]));
        // 批准变量长度不足以容纳已知测试值，明确跳过；不截断变量。
        if (binding.params.some((p) => [...(params[p.name] ?? "")].length > p.maxLen)) {
          skipped++;
          continue;
        }
        let claimed: { id: string; phone: string; staffId: string; day: string } | null = null;
        for (const target of targets) {
          if (ctx.signal?.aborted) break;
          const phone = target.phone;
          if (!phone) continue;
          const ref = phoneBidx(keyring, phone).toString("hex");
          claimed = await ctx.runTx(async (tx) => {
            // 与其他短信 producer 共用实际种子锚；有效的未开始认领也预约同号日额度。
            if (!(await lockSmsBudget(tx, [row.templateKey]))) return null;
            if (ctx.signal?.aborted) return null;
            const claimTime = deps.clock.now();
            const values = await paramsAt(
              tx,
              [
                "notify.window.start",
                "notify.window.end",
                "notify.sms.daily_cap",
                "notify.sms.keepalive_days",
                "notify.test_recipients",
              ],
              claimTime,
            );
            if (
              !windowOpen(claimTime, values["notify.window.start"], values["notify.window.end"]) ||
              !values["notify.test_recipients"].some(
                (recipient) => recipient.staffId === target.staffId && recipient.phone === phone,
              )
            )
              return null;
            const day = dayOf(claimTime);
            const directKey = `sms_keepalive:${day}:${row.templateKey}`;
            const staff = await tx.staff.findUnique({
              where: { id: target.staffId },
              select: { status: true },
            });
            if (staff?.status !== "active") return null;
            const current = await tx.smsTemplate.findUnique({
              where: { templateKey: row.templateKey },
            });
            if (
              !current ||
              current.status !== "active" ||
              current.updatedAt.getTime() !== row.updatedAt.getTime() ||
              claimTime.getTime() - (current.lastOkAt ?? current.updatedAt).getTime() <
                values["notify.sms.keepalive_days"] * 86_400_000
            )
              return null;
            if (
              await tx.notificationDelivery.findUnique({
                where: { directKey },
                select: { id: true },
              })
            )
              return null;
            const count = await smsDayUsage(tx, { targetRef: ref, now: claimTime });
            if (count >= values["notify.sms.daily_cap"]) return null;
            const id = uuidv7();
            await tx.notificationDelivery.create({
              data: {
                id,
                isDirect: true,
                channel: "sms",
                origin: "direct",
                status: "sending",
                dueAt: claimTime,
                attemptNo: 1,
                maxAttempts: 1,
                leaseUntil: new Date(claimTime.getTime() + 30_000),
                callStartedAt: null,
                targetRef: ref,
                targetMasked: maskPhone(phone),
                purpose: "keepalive",
                directKey,
                smsTemplateKey: row.templateKey,
                providerTemplateId: binding.providerTemplateId,
                createdAt: claimTime,
                updatedAt: claimTime,
              },
            });
            return { id, phone, staffId: target.staffId, day };
          });
          if (claimed) break;
        }
        if (!claimed) {
          skipped++;
          continue;
        }
        const claim = claimed;
        const latest = await readTemplate(row.templateKey);
        const beforeSend = deps.clock.now();
        const sendWindow = await ctx.runTx((tx) =>
          paramsAt(tx, ["notify.window.start", "notify.window.end"], beforeSend),
        );
        const permitted =
          !ctx.signal?.aborted &&
          dayOf(beforeSend) === claim.day &&
          windowOpen(
            beforeSend,
            sendWindow["notify.window.start"],
            sendWindow["notify.window.end"],
          ) &&
          (await enabled()) &&
          latest &&
          sameBinding(binding, latest);
        if (permitted) {
          const started = await ctx.runTx(async (tx) => {
            if (!(await lockSmsBudget(tx, [row.templateKey]))) return false;
            await tx.$queryRaw`SELECT id FROM notification_delivery
              WHERE id = ${claim.id}::uuid FOR UPDATE`;
            const startedAt = deps.clock.now();
            const values = await paramsAt(
              tx,
              [
                "notify.window.start",
                "notify.window.end",
                "notify.sms.keepalive_days",
                "notify.test_recipients",
              ],
              startedAt,
            );
            const staff = await tx.staff.findUnique({
              where: { id: claim.staffId },
              select: { status: true },
            });
            const current = await tx.smsTemplate.findUnique({
              where: { templateKey: row.templateKey },
            });
            const liveBinding = await smsTemplateReader(tx)(row.templateKey);
            if (
              ctx.signal?.aborted ||
              dayOf(startedAt) !== claim.day ||
              !windowOpen(startedAt, values["notify.window.start"], values["notify.window.end"]) ||
              staff?.status !== "active" ||
              !values["notify.test_recipients"].some(
                (target) => target.staffId === claim.staffId && target.phone === claim.phone,
              ) ||
              !current ||
              current.status !== "active" ||
              current.updatedAt.getTime() !== row.updatedAt.getTime() ||
              startedAt.getTime() - (current.lastOkAt ?? current.updatedAt).getTime() <
                values["notify.sms.keepalive_days"] * 86_400_000 ||
              !liveBinding ||
              !sameBinding(binding, liveBinding) ||
              !(await createConfig({ db: tx, clock: deps.clock, redis: null }).flags.isEnabled(
                "notify.sms.enabled",
                {},
              ))
            ) {
              await tx.notificationDelivery.updateMany({
                where: {
                  id: claim.id,
                  status: "sending",
                  attemptNo: 1,
                  callStartedAt: null,
                  leaseUntil: { gt: startedAt },
                },
                data: {
                  status: "cancelled",
                  reason: "guard_invalid",
                  finishedAt: startedAt,
                  leaseUntil: null,
                  updatedAt: startedAt,
                },
              });
              return false;
            }
            const update = await tx.notificationDelivery.updateMany({
              where: {
                id: claim.id,
                attemptNo: 1,
                status: "sending",
                leaseUntil: { gt: startedAt },
                callStartedAt: null,
              },
              data: {
                callStartedAt: startedAt,
                leaseUntil: new Date(startedAt.getTime() + 30_000),
                updatedAt: startedAt,
              },
            });
            return update.count === 1;
          });
          if (!started) {
            skipped++;
            continue;
          }
        }
        // 条件标记成功后，立即在事务外调用，期间不再做异步查询。
        const result =
          permitted && !ctx.signal?.aborted
            ? await deps.sms.sendTemplate({
                phone: claim.phone,
                template: binding,
                params,
                ...(ctx.signal ? { signal: ctx.signal } : {}),
              })
            : null;
        let finished = deps.clock.now();
        const settled = await ctx.runTx(async (tx) => {
          await lockSmsBudget(tx, [row.templateKey]);
          await tx.$queryRaw`SELECT id FROM notification_delivery
            WHERE id = ${claim.id}::uuid FOR UPDATE`;
          finished = deps.clock.now();
          const update = await tx.notificationDelivery.updateMany({
            where: {
              id: claim.id,
              attemptNo: 1,
              status: "sending",
              leaseUntil: { gt: finished },
            },
            data: result?.ok
              ? {
                  status: "sent",
                  providerMsgId: result.value.providerMsgId,
                  sentAt: finished,
                  finishedAt: finished,
                  leaseUntil: null,
                  updatedAt: finished,
                }
              : {
                  status: result === null ? "cancelled" : "failed",
                  reason:
                    result === null
                      ? "guard_invalid"
                      : result.acceptance === "unknown"
                        ? "unknown_outcome"
                        : result.acceptance === "not_accepted" || result.reason === "rejected"
                          ? "provider_rejected"
                          : "unknown_outcome",
                  errorCode:
                    result && !result.ok ? (result.providerCode?.slice(0, 32) ?? null) : null,
                  errorMsg: result && !result.ok ? result.message.slice(0, 200) : "发前守卫失效",
                  finishedAt: finished,
                  leaseUntil: null,
                  updatedAt: finished,
                },
          });
          if (!update.count) return false;
          if (result?.ok)
            await tx.smsTemplate.updateMany({
              where: { templateKey: row.templateKey, status: "active", updatedAt: row.updatedAt },
              data: { lastOkAt: finished },
            });
          return true;
        });
        if (!settled) {
          skipped++;
          continue;
        }
        if (result?.ok) sent++;
        else if (result === null) skipped++;
        else failed++;
        if (await inspectSuspect(row, finished, ctx.runTx)) suspect++;
      }
      return {
        outcome: ctx.signal?.aborted ? "cancelled" : "completed",
        sent,
        failed,
        skipped,
        suspect,
      };
    },
  };
  return {
    balance: (ctx: RecurringRunContext) => owned(ctx, service.balance),
    keepalive: (ctx: RecurringRunContext) => owned(ctx, service.keepalive),
    close() {
      if (closing) return closing;
      closed = true;
      const calls = [...pending];
      closing = Promise.resolve().then(async () => {
        for (const call of calls) call.controller.abort();
        await Promise.allSettled(calls.map((call) => call.done));
      });
      return closing;
    },
  };
}
export type SmsHealth = ReturnType<typeof createSmsHealth>;
let binding: SmsHealth | undefined;
export function bindSmsHealth(health: SmsHealth): () => void {
  binding = health;
  return () => {
    if (binding === health) binding = undefined;
  };
}
export function boundSmsHealth(): SmsHealth {
  if (!binding) throw new TypeError("短信保活任务尚未装配");
  return binding;
}
