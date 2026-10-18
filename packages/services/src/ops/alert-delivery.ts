import { z } from "zod";
import { assertNotInTransaction, uuidv7 } from "../kernel/index.js";
import type { Clock, Tx, TxRunner } from "../kernel/index.js";
import type {
  OpsAlertSendInput,
  OpsAlertSendResult,
  SystemAlertInput,
  SystemAlertResult,
} from "../notify/index.js";
import type { NotificationProviderResult, ProviderLogger } from "../providers/types.js";
import { ALERT_RULES } from "./alert-rules.js";
import { writeAlertFact } from "./alert-facts.js";

const Channel = z.strictObject({
  status: z.enum(["pending", "sending", "accepted", "not_accepted", "unknown", "disabled"]),
  attemptedAt: z.iso.datetime().nullable(),
  acceptedAt: z.iso.datetime().nullable(),
  failures: z.number().int().min(0).max(3),
});
const State = z.strictObject({
  v: z.literal(1),
  generation: z.uuid(),
  token: z.uuid(),
  noticeNo: z.number().int().positive(),
  severity: z.enum(["P1", "P2", "P3"]),
  phase: z.enum(["open", "recovered", "heartbeat"]),
  immediate: z.boolean(),
  startedAt: z.iso.datetime(),
  nextAt: z.iso.datetime().nullable(),
  occurrences: z.number().int().positive(),
  counted: z.boolean(),
  escalated: z.boolean(),
  robot: Channel,
  sms: Channel,
  bell: Channel,
  note: Channel,
});
type Delivery = z.infer<typeof State>;
type ChannelName = "robot" | "sms" | "bell" | "note";
const names: readonly ChannelName[] = ["robot", "sms", "bell", "note"];
interface Row {
  id: string;
  fingerprint: string;
  rule: string;
  severity: string;
  status: string;
  occurrences: number;
  lastValue: unknown;
  notifyCount: number;
}
interface Outcome {
  accepted: boolean;
  unknown: boolean;
  configured: boolean;
  disabled?: boolean;
}
interface Claim {
  row: Row;
  state: Delivery;
  channels: readonly ChannelName[];
}
export const DEFAULT_P2_IMMEDIATE: readonly string[] = [
  "webhook.backlog",
  "webhook.dead",
  "webhook.failing",
  "billing.unfulfilled",
  "billing.expired_order",
  "billing.refund_stuck",
  "billing.advance_failed",
  "invariant.unresolved",
  "recurring.missed",
  "notify.sms_balance_unconfigured",
  "notify.sms_suspect",
  "media.model_budget_exhausted",
  "media.model_budget_unavailable",
];
export interface AlertDispatcherOptions {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly logger: ProviderLogger;
  readonly holder: () => string | undefined;
  readonly config?: {
    readonly oncallPhones: readonly string[];
    readonly p2Immediate?: readonly string[];
  };
  readonly robot: (input: {
    title: string;
    content: string;
    mentionAll: boolean;
    signal?: AbortSignal;
  }) => Promise<NotificationProviderResult<void>>;
  readonly sms: (input: OpsAlertSendInput) => Promise<OpsAlertSendResult>;
  readonly bell: (tx: Tx, input: SystemAlertInput) => Promise<SystemAlertResult>;
  readonly budgetMs?: number;
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function phase(row: Row): Delivery["phase"] | null {
  if (row.rule === "ops.channel_heartbeat") return row.status === "resolved" ? null : "heartbeat";
  if (row.status !== "resolved") return "open";
  return ["normal", "quiet"].includes(String(object(row.lastValue)._recoveryReason))
    ? "recovered"
    : null;
}
function freshChannel(enabled: boolean): z.infer<typeof Channel> {
  return {
    status: enabled ? "pending" : "disabled",
    attemptedAt: null,
    acceptedAt: null,
    failures: 0,
  };
}
function interval(row: Row): number {
  return (row.severity === "P1" ? 15 : 60) * 60_000 * (row.status === "acked" ? 4 : 1);
}
function ready(channel: z.infer<typeof Channel>, at: number): boolean {
  return (
    channel.status === "pending" ||
    (channel.status === "not_accepted" && at >= Date.parse(channel.attemptedAt!) + 60_000)
  );
}
function nextAt(state: Delivery, row: Row, at: number): string | null {
  const values = names.flatMap((name) => {
    const channel = state[name];
    return channel.status === "pending"
      ? [at]
      : channel.status === "sending"
        ? [Date.parse(channel.attemptedAt!) + 30_000]
        : channel.status === "not_accepted"
          ? [Date.parse(channel.attemptedAt!) + 60_000]
          : [];
  });
  if (state.phase === "open" && state.immediate && state.severity !== "P3")
    values.push(Date.parse(state.startedAt) + interval(row));
  return values.length ? new Date(Math.max(at, Math.min(...values))).toISOString() : null;
}
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new Error("告警派发已取消"));
    };
    signal.addEventListener("abort", abort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) abort();
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

/** 短事务只认领与记录受理；外部通道不在事务中，铃铛不会冒充机器人/短信成功。 */
export function createAlertDispatcher(options: AlertDispatcherOptions) {
  const whitelist = options.config?.p2Immediate ?? DEFAULT_P2_IMMEDIATE;
  if (whitelist.some((rule) => !ALERT_RULES.includes(rule)))
    throw new TypeError("告警即时白名单含未登记规则");
  const immediate = (row: Row) =>
    row.rule === "config.flag_changed" ||
    row.severity === "P1" ||
    (row.severity === "P2" && whitelist.includes(row.rule));
  const budgetMs = Math.min(options.budgetMs ?? 15_000, 15_000);
  if (!Number.isInteger(budgetMs) || budgetMs < 1) throw new TypeError("告警派发预算不合法");
  const lifetime = new AbortController();
  let closed = false,
    running: Promise<{ inspected: number; accepted: number; unconfigured: number }> | undefined,
    closing: Promise<void> | undefined;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>) => {
    pending.add(work);
    void work.finally(() => pending.delete(work)).catch(() => undefined);
    return work;
  };
  const log = (channel: string, id?: string) => {
    try {
      options.logger.error(
        { evt: "ops.alert_channel_failed", channel, ...(id ? { alertId: id } : {}) },
        "告警通道未确认受理",
      );
    } catch {
      /* 不覆盖派发失败。 */
    }
  };
  function withLease<T>(
    holder: string,
    signal: AbortSignal,
    action: (tx: Tx) => Promise<T>,
  ): Promise<T> {
    return options.tx.run(
      async (tx) => {
        signal.throwIfAborted();
        if (options.holder() !== holder) throw new Error("告警主租约已失效");
        const rows = await tx.$queryRawUnsafe<{ holder: string }[]>(
          `SELECT holder FROM worker_lease WHERE name='primary' AND holder=$1
          AND heartbeat_at >= clock_timestamp()-interval '30 second' FOR SHARE`,
          holder,
        );
        if (rows.length !== 1) throw new Error("告警主租约已失效");
        const result = await action(tx);
        signal.throwIfAborted();
        if (options.holder() !== holder) throw new Error("告警主租约已失效");
        return result;
      },
      { timeoutMs: 2000 },
    );
  }
  async function persist(tx: Tx, id: string, state: Delivery, at: Date) {
    await tx.$executeRawUnsafe(
      `UPDATE alert_event SET last_value=COALESCE(last_value,'{}'::jsonb)
      ||jsonb_build_object('_delivery',$2::jsonb),updated_at=$3 WHERE id=$1::uuid`,
      id,
      JSON.stringify(state),
      at,
    );
  }
  async function claim(id: string, holder: string, signal: AbortSignal): Promise<Claim | null> {
    return withLease(holder, signal, async (tx) => {
      await tx.$queryRawUnsafe(`SELECT id FROM alert_event WHERE id=$1::uuid FOR UPDATE`, id);
      const row = await tx.alertEvent.findUnique({ where: { id } });
      if (!row) return null;
      const currentPhase = phase(row);
      if (!currentPhase || !["P1", "P2", "P3"].includes(row.severity)) return null;
      const at = options.clock.now(),
        now = at.getTime(),
        raw = object(row.lastValue)._delivery;
      const parsed = raw === undefined ? null : State.safeParse(raw);
      if (parsed && !parsed.success) {
        log("state", id);
        return null;
      }
      const previous = parsed?.success ? parsed.data : undefined;
      const isImmediate = currentPhase !== "open" || immediate(row);
      const repeat =
        previous?.phase === "open" &&
        isImmediate &&
        row.severity !== "P3" &&
        now >= Date.parse(previous.startedAt) + interval(row);
      let state: Delivery;
      if (
        !previous ||
        previous.phase !== currentPhase ||
        previous.severity !== row.severity ||
        previous.immediate !== isImmediate ||
        repeat ||
        (row.rule === "config.flag_changed" && previous.occurrences !== row.occurrences)
      ) {
        state = {
          v: 1,
          generation: uuidv7(),
          token: uuidv7(),
          noticeNo: (previous?.noticeNo ?? row.notifyCount) + 1,
          severity: row.severity as Delivery["severity"],
          phase: currentPhase,
          immediate: isImmediate,
          startedAt: at.toISOString(),
          nextAt: at.toISOString(),
          occurrences: row.occurrences,
          counted: false,
          escalated:
            previous?.phase === currentPhase && previous.severity === row.severity
              ? previous.escalated
              : false,
          robot: freshChannel(isImmediate),
          sms: freshChannel(row.severity === "P1" && currentPhase !== "heartbeat"),
          bell: freshChannel(true),
          note: freshChannel(false),
        };
        if (previous && previous.phase === currentPhase && previous.severity === row.severity)
          state.robot.failures = previous.robot.failures;
      } else state = previous;
      for (const name of names)
        if (
          state[name].status === "sending" &&
          now >= Date.parse(state[name].attemptedAt!) + 30_000
        )
          state[name].status = "unknown"; // 崩溃后不盲重发可能已经受理的同一通道意图。
      if (
        state.severity === "P2" &&
        state.robot.failures >= 3 &&
        !state.escalated &&
        state.sms.status === "disabled"
      )
        state.sms = freshChannel(true);
      if (
        state.severity === "P1" &&
        ["not_accepted", "unknown"].includes(state.sms.status) &&
        state.note.status === "disabled"
      )
        state.note = freshChannel(true);
      const channels = names.filter((name) => ready(state[name], now));
      if (channels.length) state.token = uuidv7();
      for (const name of channels) {
        state[name].status = "sending";
        state[name].attemptedAt = at.toISOString();
      }
      state.nextAt = nextAt(state, row, now);
      await persist(tx, id, state, at);
      return channels.length ? { row, state, channels } : null;
    });
  }
  function text(intent: Claim, note = false) {
    if (intent.state.phase === "heartbeat")
      return `每日通道心跳：昨日P3及汇总P2告警 ${Number(object(intent.row.lastValue).summaryCount ?? 0)} 条`;
    return `${intent.state.phase === "recovered" ? "已恢复" : "告警"} ${intent.state.severity} ${intent.row.fingerprint}${note ? "；值班短信未确认受理，请人工联系值班人" : ""}`;
  }
  async function assertIntent(tx: Tx, intent: Claim, name: ChannelName): Promise<void> {
    await tx.$queryRawUnsafe(
      `SELECT id FROM alert_event WHERE id=$1::uuid FOR UPDATE`,
      intent.row.id,
    );
    const row = await tx.alertEvent.findUnique({ where: { id: intent.row.id } });
    const parsed = State.safeParse(object(row?.lastValue)._delivery);
    if (
      !row ||
      !parsed.success ||
      parsed.data.generation !== intent.state.generation ||
      parsed.data.token !== intent.state.token ||
      parsed.data.severity !== intent.state.severity ||
      parsed.data.phase !== intent.state.phase ||
      parsed.data[name].status !== "sending" ||
      row.severity !== intent.state.severity ||
      phase(row) !== intent.state.phase ||
      (row.rule === "config.flag_changed" && row.occurrences !== intent.state.occurrences)
    )
      throw new Error("告警派发意图已失效");
  }
  async function call(
    name: ChannelName,
    intent: Claim,
    holder: string,
    signal: AbortSignal,
  ): Promise<Outcome> {
    try {
      signal.throwIfAborted();
      if (name === "bell") {
        const result = await withLease(holder, signal, async (tx) => {
          // 版本校验与铃铛写入共用行锁和事务，旧意图不能产生站内通知。
          await assertIntent(tx, intent, name);
          return options.bell(tx, {
            alertId: intent.row.id,
            fingerprint: intent.row.fingerprint,
            severity: intent.state.severity,
            recovered: intent.state.phase === "recovered",
            noticeNo: intent.state.noticeNo,
            at: options.clock.now(),
          });
        });
        return {
          accepted: result.status === "sent",
          unknown: false,
          configured: true,
          disabled: result.status !== "sent",
        };
      }
      // 外呼前重新核租约与当前意图；网络调用仍在短事务提交后执行。
      await withLease(holder, signal, (tx) => assertIntent(tx, intent, name));
      signal.throwIfAborted();
      if (name === "sms")
        return await options.sms({
          generation: intent.state.generation,
          phase: intent.state.severity === "P2" ? "channel" : intent.state.phase,
          phones: options.config?.oncallPhones ?? [],
          title: intent.state.severity === "P2" ? "告警通道失效" : "狸有戏运维告警",
          signal,
        });
      const result = await options.robot({
        title: "狸有戏运维",
        content: text(intent, name === "note"),
        mentionAll: intent.state.severity === "P1",
        signal,
      });
      return {
        accepted: result.ok,
        unknown: !result.ok && result.notification?.acceptance !== "not_accepted",
        configured: result.ok || !["unconfigured", "unsupported"].includes(result.reason),
      };
    } catch {
      return { accepted: false, unknown: name !== "bell", configured: true };
    }
  }
  async function finish(
    intent: Claim,
    results: readonly Outcome[],
    holder: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    return withLease(holder, signal, async (tx) => {
      await tx.$queryRawUnsafe(
        `SELECT id FROM alert_event WHERE id=$1::uuid FOR UPDATE`,
        intent.row.id,
      );
      const row = await tx.alertEvent.findUnique({ where: { id: intent.row.id } });
      const parsed = State.safeParse(object(row?.lastValue)._delivery);
      if (
        !row ||
        !parsed.success ||
        parsed.data.generation !== intent.state.generation ||
        parsed.data.token !== intent.state.token ||
        row.severity !== intent.state.severity ||
        phase(row) !== intent.state.phase
      )
        return false;
      const state = parsed.data,
        at = options.clock.now();
      for (const [index, name] of intent.channels.entries()) {
        const result = results[index]!,
          channel = state[name];
        channel.status = result.accepted
          ? "accepted"
          : result.disabled
            ? "disabled"
            : result.unknown
              ? "unknown"
              : "not_accepted";
        channel.acceptedAt = result.accepted ? at.toISOString() : null;
        if (name === "robot") {
          channel.failures = result.accepted
            ? 0
            : result.configured
              ? Math.min(3, channel.failures + 1)
              : channel.failures;
          if (result.accepted) state.escalated = false;
        }
        if (name === "sms" && state.severity === "P2" && result.configured) state.escalated = true;
        if (!result.accepted && !result.disabled) log(name, row.id);
      }
      if (
        state.severity === "P2" &&
        state.robot.failures >= 3 &&
        !state.escalated &&
        state.sms.status === "disabled"
      )
        state.sms = freshChannel(true);
      if (
        state.severity === "P1" &&
        ["not_accepted", "unknown"].includes(state.sms.status) &&
        state.note.status === "disabled"
      )
        state.note = freshChannel(true);
      const accepted =
        state.phase === "heartbeat"
          ? state.robot.status === "accepted"
          : state.immediate
            ? state.robot.status === "accepted" || state.sms.status === "accepted"
            : state.bell.status === "accepted";
      const count = accepted && !state.counted;
      state.counted ||= accepted;
      state.nextAt = nextAt(state, row, at.getTime());
      await persist(tx, row.id, state, at);
      if (count)
        await tx.$executeRawUnsafe(
          `UPDATE alert_event SET last_notified_at=$2,notify_count=notify_count+1,
        last_value=last_value||jsonb_build_object('_notifiedSeverity',$3::text),updated_at=$2 WHERE id=$1::uuid`,
          row.id,
          at,
          state.severity,
        );
      if (
        state.phase === "heartbeat" &&
        state.robot.status === "accepted" &&
        ["accepted", "disabled"].includes(state.bell.status)
      )
        await tx.$executeRawUnsafe(
          `UPDATE alert_event SET status='resolved',resolved_at=$2,updated_at=$2 WHERE id=$1::uuid`,
          row.id,
          at,
        );
      return count;
    });
  }
  async function heartbeat(holder: string, signal: AbortSignal): Promise<string | null> {
    const at = options.clock.now(),
      local = new Date(at.getTime() + 8 * 3600_000),
      day = local.toISOString().slice(0, 10);
    if (local.getUTCHours() < 9 || (local.getUTCHours() === 9 && local.getUTCMinutes() < 30))
      return null;
    const end = new Date(`${day}T00:00:00+08:00`),
      start = new Date(end.getTime() - 86400_000),
      scheduled = new Date(`${day}T09:30:00+08:00`);
    return withLease(holder, signal, async (tx) => {
      const existing = await tx.alertEvent.findFirst({
        where: { fingerprint: `ops.channel_heartbeat:${day}` },
        orderBy: [{ firstSeenAt: "desc" }, { id: "desc" }],
        select: { id: true, status: true },
      });
      if (existing) return existing.status === "resolved" ? null : existing.id;
      const count = await tx.alertEvent.count({
        where: {
          rule: { not: "ops.channel_heartbeat" },
          firstSeenAt: { lt: end },
          lastSeenAt: { gte: start },
          OR: [{ severity: "P3" }, { severity: "P2", rule: { notIn: [...whitelist] } }],
        },
      });
      await writeAlertFact(
        tx,
        {
          rule: "ops.channel_heartbeat",
          dimension: day,
          severity: "P3",
          detail: { summaryCount: count },
        },
        "event",
        at,
        scheduled,
      );
      return (
        (
          await tx.alertEvent.findFirst({
            where: { fingerprint: `ops.channel_heartbeat:${day}` },
            orderBy: [{ firstSeenAt: "desc" }, { id: "desc" }],
            select: { id: true },
          })
        )?.id ?? null
      );
    });
  }
  async function round(parent?: AbortSignal) {
    assertNotInTransaction("ops.alert.dispatch");
    const holder = options.holder();
    if (!holder) return { inspected: 0, accepted: 0, unconfigured: 0 };
    const controller = new AbortController(),
      signal = AbortSignal.any([lifetime.signal, controller.signal, ...(parent ? [parent] : [])]);
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let inspected = 0,
      accepted = 0,
      unconfigured = 0;
    try {
      const beat = await heartbeat(holder, signal),
        at = options.clock.now();
      const rows = await withLease(holder, signal, (tx) =>
        tx.$queryRawUnsafe<{ id: string }[]>(
          `SELECT id FROM alert_event WHERE rule<>'ops.channel_heartbeat'
          AND (status IN ('open','acked') OR (status='resolved' AND last_value->>'_recoveryReason' IN ('normal','quiet')))
          AND (last_value->'_delivery' IS NULL OR last_value->'_delivery'->>'severity' IS DISTINCT FROM severity
            OR last_value->'_delivery'->>'phase' IS DISTINCT FROM CASE WHEN status='resolved' THEN 'recovered' ELSE 'open' END
            OR last_value->'_delivery'->>'immediate' IS DISTINCT FROM CASE WHEN status='resolved' OR severity='P1' OR rule='config.flag_changed' OR (severity='P2' AND rule=ANY($2::text[])) THEN 'true' ELSE 'false' END
            OR last_value->'_delivery'->>'nextAt' <= $1::text
            OR (rule='config.flag_changed' AND last_value->'_delivery'->>'occurrences' IS DISTINCT FROM occurrences::text))
          ORDER BY COALESCE(last_value->'_delivery'->>'nextAt',
            to_char(first_seen_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
            severity,first_seen_at,id LIMIT $3::int`,
          at.toISOString(),
          [...whitelist],
          beat ? 2 : 3,
        ),
      );
      for (const id of [...(beat ? [beat] : []), ...rows.map((row) => row.id)]) {
        for (let pass = 0; pass < 2; pass++) {
          signal.throwIfAborted();
          const intent = await claim(id, holder, signal);
          if (!intent) break;
          if (pass === 0) inspected++;
          const work = track(
            Promise.all(intent.channels.map((name) => call(name, intent, holder, signal))),
          );
          const results = await bounded(work, signal);
          if (results.some((result) => !result.configured)) unconfigured++;
          if (await finish(intent, results, holder, signal)) accepted++;
        }
      }
    } catch {
      log("round");
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    return { inspected, accepted, unconfigured };
  }
  return {
    run(signal?: AbortSignal) {
      if (closed) return Promise.reject(new Error("告警派发已经关闭"));
      if (!running) {
        running = round(signal);
        const current = running;
        void current
          .finally(() => {
            if (running === current) running = undefined;
          })
          .catch(() => undefined);
      }
      return running;
    },
    close() {
      closed = true;
      lifetime.abort();
      return (closing ??= (async () => {
        await running?.catch(() => undefined);
        await Promise.allSettled([...pending]);
      })());
    },
  };
}
