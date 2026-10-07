import { createHash } from "node:crypto";
import { WEBHOOK_EVENT_PROVIDER } from "@liyoxi/contract/enums";
import { Prisma } from "@liyoxi/db";
import type { WebhookEvent } from "@liyoxi/db";
import {
  AppError,
  createIdentityContext,
  isRetryableDbError,
  noopAlerts,
  savepoint,
  uuidv7,
} from "../../kernel/index.js";
import type { IdentityContext, Tx } from "../../kernel/index.js";
import type {
  PreparedWebhook,
  VerifiedWebhook,
  WebhookPayload,
  WebhookReply,
  WebhookResult,
  Webhooks,
  WebhooksOptions,
  WebhookSource,
  WebhookStored,
} from "./types.js";

const MINUTE = 60_000;
const delays = [MINUTE, 5 * MINUTE, 15 * MINUTE, 60 * MINUTE, 360 * MINUTE];
const terminal = (state: string) => ["processed", "ignored", "dead"].includes(state);
const stored = (row: WebhookEvent): WebhookStored => ({
  ...row,
  payload: row.payload as WebhookPayload | null,
});
const result = (row: WebhookEvent, failedNow = false): WebhookResult => ({
  id: row.id,
  provider: row.provider,
  state: row.processState,
  attempts: row.attempts,
  failedNow,
});

/** 来源由组合根注入；未登记来源拒绝，不把业务模块导入 security。 */
export function createWebhooks(deps: WebhooksOptions): Webhooks {
  const sources = new Map<string, WebhookSource>();
  for (const source of deps.sources ?? []) {
    if (!WEBHOOK_EVENT_PROVIDER.values.includes(source.provider) || sources.has(source.provider))
      throw new TypeError("回调来源非法或重复");
    if (source.fallbackToInbox && (source.provider !== "wechatpay" || source.mode !== "inline"))
      throw new TypeError("只有支付内联来源可登记收件箱兜底");
    sources.set(source.provider, source);
  }
  const issued = new WeakMap<
    PreparedWebhook,
    {
      provider: WebhookSource["provider"];
      event: VerifiedWebhook;
      receivedAt: Date;
      digest: Uint8Array<ArrayBuffer>;
    }
  >();
  const alerts = deps.alerts ?? noopAlerts;
  const reply = (
    source: WebhookSource,
    ok: boolean,
    error?: Parameters<WebhookSource["reply"]>[1],
    details?: Readonly<Record<string, unknown>>,
  ): WebhookReply => {
    const value = source.reply(ok, error, details);
    if (
      !Number.isInteger(value.status) ||
      (ok ? value.status < 200 || value.status >= 300 : value.status < 400 || value.status >= 600)
    )
      throw new TypeError("回调协议应答状态不合成功/失败语义");
    return value;
  };
  const notify = async (row: WebhookResult) => {
    if (!row.failedNow) return;
    const source = sources.get(row.provider);
    if (
      row.state === "dead" ||
      row.attempts === (source?.escalateAfter ?? (row.provider === "wechatpay" ? 5 : undefined))
    )
      await alerts
        .raise({
          rule: row.state === "dead" ? "webhook.dead" : "webhook.failing",
          dimension: row.id,
          severity: "P1",
          detail: { provider: row.provider, attempts: row.attempts },
        })
        .catch(() => {}); // 告警端口契约：失败不改变已提交的收件应答。
  };
  const lock = async (tx: Tx, id: string): Promise<WebhookEvent | null> => {
    const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
      "SELECT id FROM webhook_event WHERE id = $1::uuid FOR UPDATE",
      id,
    );
    return rows.length ? tx.webhookEvent.findUniqueOrThrow({ where: { id } }) : null;
  };
  const fail = async (tx: Tx, row: WebhookEvent): Promise<WebhookResult> => {
    const attempts = row.attempts + 1;
    const now = deps.clock.now();
    return result(
      await tx.webhookEvent.update({
        where: { id: row.id },
        data: {
          processState: attempts >= 8 ? "dead" : "failed",
          attempts,
          processedAt: null,
          error: "WEBHOOK_HANDLER_FAILED",
          nextAttemptAt:
            attempts >= 8
              ? null
              : new Date(now.getTime() + delays[Math.min(attempts - 1, delays.length - 1)]!),
          updatedAt: now,
        },
      }),
      true,
    );
  };
  const handle = async (
    tx: Tx,
    row: WebhookEvent,
    source: WebhookSource,
    ctx: IdentityContext,
    event?: VerifiedWebhook,
  ) => {
    const value = stored(row);
    const data = event === undefined ? await source.restore(value) : event.data;
    const state = await source.handle(tx, { ...value, data }, ctx);
    if (state !== "processed" && state !== "ignored")
      throw new TypeError("处理函数只能返回已处理或已忽略");
    const now = deps.clock.now();
    return result(
      await tx.webhookEvent.update({
        where: { id: row.id },
        data: {
          processState: state,
          processedAt: now,
          nextAttemptAt: null,
          error: null,
          updatedAt: now,
        },
      }),
    );
  };
  const processLocked = async (
    tx: Tx,
    row: WebhookEvent,
    ctx: IdentityContext,
  ): Promise<WebhookResult> => {
    if (terminal(row.processState)) return result(row);
    const source = sources.get(row.provider);
    if (
      !source ||
      source.enabled?.() === false ||
      (row.nextAttemptAt && row.nextAttemptAt > deps.clock.now())
    )
      return result(row);
    try {
      // 收件锁在保存点之前；领域写回滚后，外层事务仍能安全提交失败计数。
      return await savepoint(tx, () => handle(tx, row, source, ctx));
    } catch (error) {
      if (isRetryableDbError(error)) throw error;
      return fail(tx, row);
    }
  };
  const insert = async (
    tx: Tx,
    receipt: {
      provider: WebhookSource["provider"];
      event: VerifiedWebhook;
      receivedAt: Date;
      digest: Uint8Array<ArrayBuffer>;
    },
    payload: WebhookPayload | null,
    mode: "inline" | "inbox",
    failed = false,
  ) => {
    const now = receipt.receivedAt;
    const attemptedAt = failed ? deps.clock.now() : now;
    const id = uuidv7();
    const state = failed ? "failed" : mode === "inline" ? "processed" : "received";
    const count = await tx.webhookEvent.createMany({
      skipDuplicates: true,
      data: {
        id,
        provider: receipt.provider,
        eventId: receipt.event.eventId,
        eventType: receipt.event.eventType,
        mode,
        receivedAt: now,
        payload: payload ?? Prisma.DbNull,
        payloadDigest: receipt.digest,
        keyVersion: receipt.event.keyVersion ?? null,
        processState: state,
        attempts: failed ? 1 : 0,
        processedAt: mode === "inline" ? now : null,
        nextAttemptAt:
          mode === "inline" ? null : new Date(attemptedAt.getTime() + (failed ? MINUTE : 0)),
        error: failed ? "WEBHOOK_HANDLER_FAILED" : null,
        payloadPurgeAt: payload
          ? new Date(now.getTime() + (receipt.provider === "wechatpay" ? 180 : 90) * 86_400_000)
          : null,
        createdAt: now,
        updatedAt: attemptedAt,
      },
    });
    const row = await tx.webhookEvent.findUniqueOrThrow({
      where: { provider_eventId: { provider: receipt.provider, eventId: receipt.event.eventId } },
    });
    return { row: (await lock(tx, row.id)) as WebhookEvent, fresh: count.count === 1 };
  };
  return {
    reject(provider, error, details) {
      const source = sources.get(provider);
      if (!source) throw new AppError("WEBHOOK_SOURCE_DISABLED");
      return reply(source, false, error, details);
    },
    async prepare(provider, request) {
      const source = sources.get(provider);
      if (!source) throw new AppError("WEBHOOK_SOURCE_DISABLED");
      if (source.enabled?.() === false) return reply(source, false, "WEBHOOK_SOURCE_DISABLED");
      if (request.rawBody.byteLength > 1_048_576)
        return reply(source, false, "WEBHOOK_PAYLOAD_INVALID");
      const rawBody = new Uint8Array(request.rawBody);
      const digest = new Uint8Array(createHash("sha256").update(rawBody).digest());
      const now = deps.clock.now();
      let checked;
      try {
        checked = await source.verify({ ...request, rawBody, now });
      } catch {
        return reply(source, false, "WEBHOOK_PAYLOAD_INVALID");
      }
      if (checked.kind === "error") return reply(source, false, checked.error);
      const timestamp = checked.kind === "event" ? checked.event.timestamp : checked.timestamp;
      if (
        timestamp &&
        (!Number.isFinite(timestamp.getTime()) ||
          Math.abs(timestamp.getTime() - now.getTime()) > 5 * MINUTE)
      )
        return reply(source, false, "WEBHOOK_TIMESTAMP_SKEWED");
      if (checked.kind === "reply" || checked.kind === "skip") {
        const value = checked.kind === "reply" ? checked : checked.reply;
        // h01§2.1 第9步的两种免收件成功必须显式登记；普通POST不能绕过两模式。
        const allowed =
          checked.kind === "reply"
            ? request.method === "GET"
            : request.method === "POST" &&
              ["unregistered_event", "passive_reply"].includes(checked.reason);
        return allowed &&
          Number.isInteger(value.status) &&
          value.status >= 200 &&
          value.status < 300
          ? value
          : reply(source, false, "WEBHOOK_PAYLOAD_INVALID");
      }
      if (request.method !== "POST") return reply(source, false, "WEBHOOK_PAYLOAD_INVALID");
      const event = checked.event;
      if (!event.eventId || event.eventId.length > 200 || !event.eventType)
        return reply(source, false, "WEBHOOK_PAYLOAD_INVALID");
      const receipt: PreparedWebhook = { kind: "ready" };
      issued.set(receipt, {
        provider: source.provider,
        event: structuredClone(event),
        receivedAt: now,
        digest,
      });
      return receipt;
    },
    async accept(prepared, ctx) {
      const receipt = issued.get(prepared);
      if (!receipt || ctx.actor.type !== "system")
        throw new TypeError("收件只接受本实例验签结果与系统操作人");
      const source = sources.get(receipt.provider)!;
      if (source.enabled?.() === false) return reply(source, false, "WEBHOOK_SOURCE_DISABLED");
      const payload = structuredClone(source.payload(receipt.event));
      if (
        ((source.mode === "inbox" || source.provider === "wechatpay") && payload === null) ||
        (["ci", "asr"].includes(source.provider) && payload !== null)
      )
        return reply(source, false, "WEBHOOK_PAYLOAD_INVALID");
      if (source.fallbackToInbox) {
        const cipher = payload?.["resourceCipher"];
        if (
          !cipher ||
          typeof cipher !== "object" ||
          Array.isArray(cipher) ||
          !["ciphertext", "nonce", "associated_data"].every(
            (key) => typeof (cipher as WebhookPayload)[key] === "string",
          ) ||
          !receipt.event.keyVersion
        )
          return reply(source, false, "WEBHOOK_PAYLOAD_INVALID");
      }
      try {
        await deps.tx.run(async (tx) => {
          const { row, fresh } = await insert(tx, receipt, payload, source.mode);
          if (!fresh && terminal(row.processState)) return;
          if (source.mode === "inbox") {
            if (fresh)
              await deps.events.emit(tx, ctx, {
                type: "webhook.received",
                aggregate: { type: "webhook_event", id: row.id },
                payload: { v: 1, webhookEventId: row.id, provider: source.provider },
                dedupeKey: `webhook.received:${row.id}`,
              });
          } else {
            if (row.eventType !== receipt.event.eventType)
              throw new AppError("WEBHOOK_PAYLOAD_INVALID");
            await handle(tx, row, source, ctx, receipt.event);
          }
        });
        return reply(source, true);
      } catch {
        if (!source.fallbackToInbox) return reply(source, false, "WEBHOOK_PERSIST_FAILED");
        try {
          const failure = await deps.tx.run(async (tx) => {
            const { row, fresh } = await insert(tx, receipt, payload, "inbox", true);
            return fresh || terminal(row.processState) ? result(row, fresh) : fail(tx, row);
          });
          await notify(failure);
          return reply(source, true);
        } catch {
          return reply(source, false, "WEBHOOK_PERSIST_FAILED");
        }
      }
    },
    async process(tx, id, ctx) {
      const row = await lock(tx, id);
      if (!row) return null;
      const outcome = await processLocked(tx, row, ctx);
      await notify(outcome);
      return outcome;
    },
    async scan(beat) {
      const eligible = [...sources.values()]
        .filter((source) => source.enabled?.() !== false)
        .map((source) => source.provider);
      if (eligible.length === 0) return 0;
      const seen: string[] = [];
      for (let i = 0; i < 50; i++) {
        const outcome = await deps.tx.run(async (tx) => {
          const rows = await tx.$queryRawUnsafe<Array<{ id: string }>>(
            "SELECT id FROM webhook_event WHERE process_state IN ('received','failed') AND next_attempt_at <= $1 AND NOT (id = ANY($2::uuid[])) AND provider = ANY($3::text[]) ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED",
            deps.clock.now(),
            seen,
            eligible,
          );
          if (!rows[0]) return null;
          return processLocked(
            tx,
            await tx.webhookEvent.findUniqueOrThrow({ where: { id: rows[0].id } }),
            createIdentityContext({ actor: { type: "system", job: "webhook.reprocess" } }),
          );
        });
        if (!outcome) break;
        seen.push(outcome.id);
        await notify(outcome);
        beat?.();
      }
      return seen.length;
    },
    async purge(tx, { now, limit }) {
      return tx.$executeRawUnsafe(
        "WITH due AS (SELECT id FROM webhook_event WHERE payload_purge_at <= $1 AND payload_purged_at IS NULL ORDER BY payload_purge_at,id LIMIT $2 FOR UPDATE SKIP LOCKED) UPDATE webhook_event w SET payload = CASE WHEN w.payload ? 'summary' THEN jsonb_build_object('summary', w.payload -> 'summary') ELSE NULL END, payload_purged_at = $1, updated_at = $1 FROM due WHERE w.id = due.id",
        now,
        limit,
      );
    },
  };
}
