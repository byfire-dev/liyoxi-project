import type { WEBHOOK_EVENT_MODE, WEBHOOK_EVENT_PROVIDER, EnumValue } from "@liyoxi/contract/enums";
import type { ErrorSymbol } from "@liyoxi/contract/errors";
import type { Alerts, Clock, IdentityContext, Tx, TxRunner } from "../../kernel/index.js";
import type { Events } from "../../events/index.js";

export type WebhookProvider = EnumValue<typeof WEBHOOK_EVENT_PROVIDER>;
export type WebhookPayload = { readonly [key: string]: WebhookJson };
export type WebhookJson =
  null | boolean | number | string | WebhookPayload | readonly WebhookJson[];
export type WebhookError = Extract<ErrorSymbol, `WEBHOOK_${string}` | "RATE_LIMITED">;
export type WebhookOutcome = "processed" | "ignored";
export interface WebhookReply {
  readonly kind: "reply";
  readonly status: number;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}
export interface WebhookRequest {
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly operationId: string;
  readonly query?: Readonly<Record<string, string>>;
}
export interface VerifiedWebhook {
  readonly eventId: string;
  readonly eventType: string;
  readonly data: WebhookJson;
  readonly keyVersion?: string;
  readonly timestamp?: Date;
}
export type WebhookVerification =
  | { readonly kind: "event"; readonly event: VerifiedWebhook }
  | (WebhookReply & { readonly timestamp?: Date })
  | {
      readonly kind: "skip";
      readonly reason: "unregistered_event" | "passive_reply";
      readonly reply: WebhookReply;
      readonly timestamp?: Date;
    }
  | { readonly kind: "error"; readonly error: WebhookError };
export interface WebhookStored {
  readonly id: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: WebhookPayload | null;
  readonly keyVersion: string | null;
}
/** 验证在事务外；restore 只能本地解密/解析，handle 只能经传入的 Tx 写。 */
export interface WebhookSource {
  readonly provider: WebhookProvider;
  readonly mode: EnumValue<typeof WEBHOOK_EVENT_MODE>;
  readonly enabled?: () => boolean;
  readonly fallbackToInbox?: boolean;
  readonly escalateAfter?: 5;
  verify(input: WebhookRequest & { readonly now: Date }): Promise<WebhookVerification>;
  payload(event: VerifiedWebhook): WebhookPayload | null;
  /**
   * 仅 inbox；accept 所属事务内的有界、只读本地投影。
   * 先验 payload 仍须合法；每次事务重试重新读取事实，不外呼或另开事务。
   * 返回去敏的可恢复 JSON 对象；身份未匹配可使用对象内的 null 字段。
   * 重放仍保持首次收件的载荷与举证；不增加跨领域锁或写业务状态。
   */
  projectPayload?(tx: Tx, event: VerifiedWebhook): Promise<WebhookPayload | null>;
  restore(row: WebhookStored): Promise<WebhookJson>;
  handle(
    tx: Tx,
    event: WebhookStored & { readonly data: WebhookJson },
    ctx: IdentityContext,
  ): Promise<WebhookOutcome>;
  reply(
    ok: boolean,
    error?: WebhookError,
    details?: Readonly<Record<string, unknown>>,
  ): WebhookReply;
}
/** 不公开可变的验签事实；accept 只认本实例私有 WeakMap 中的对象。 */
export interface PreparedWebhook {
  readonly kind: "ready";
}

export interface WebhookResult {
  readonly id: string;
  readonly state: string;
  readonly attempts: number;
  readonly failedNow?: boolean;
  readonly provider: string;
}
export interface WebhooksOptions {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly events: Pick<Events, "emit">;
  readonly sources?: readonly WebhookSource[];
  readonly alerts?: Alerts;
}
export interface Webhooks {
  reject(
    provider: string,
    error: WebhookError,
    details?: Readonly<Record<string, unknown>>,
  ): WebhookReply;
  prepare(provider: string, request: WebhookRequest): Promise<PreparedWebhook | WebhookReply>;
  accept(receipt: PreparedWebhook, ctx: IdentityContext): Promise<WebhookReply>;
  process(tx: Tx, id: string, ctx: IdentityContext): Promise<WebhookResult | null>;
  scan(beat?: () => void): Promise<number>;
  purge(tx: Tx, input: { readonly now: Date; readonly limit: number }): Promise<number>;
}
