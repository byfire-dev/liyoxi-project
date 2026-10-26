import { createHash } from "node:crypto";
import { AppError, createIdentityContext, SessionMutexError } from "../../kernel/index.js";
import type { IdentityContext, SessionMutex, Tx } from "../../kernel/index.js";
import type { Media } from "../../media/index.js";
import type { RefundDeps } from "../refund/context.js";
import { calendarDate } from "@liyoxi/shared/time";

export interface ReconciliationDeps extends RefundDeps {
  readonly sessionMutex: SessionMutex;
  readonly systemFiles: Pick<Media, "putSystemFile">;
  readonly orderPrefix: "FK" | "TFK";
  readonly observeBillMissing: (day: string, ready: boolean) => Promise<void>;
}
export const system = (): IdentityContext =>
  createIdentityContext({ actor: { type: "system", job: "bill.download" } });
export const dateValue = (day: string) => new Date(`${day}T00:00:00Z`);
export const windowOf = (day: string) => {
  const start = new Date(`${day}T00:00:00+08:00`);
  return { gte: start, lt: new Date(start.getTime() + 86_400_000) };
};
export function sourceOf(deps: ReconciliationDeps) {
  const source = deps.wechatPay;
  if (!source?.provider.configured) throw new AppError("PROVIDER_UNAVAILABLE");
  return source;
}
export function ownTradeNo(deps: ReconciliationDeps, value: string) {
  return new RegExp(`^(${deps.orderPrefix}\\d{8}\\d{5,})-(0[1-9]|[1-9]\\d)-[0-9A-Z]{6}$`).exec(
    value,
  );
}
export async function dayLock(tx: Tx, mchid: string, day: string) {
  const key = createHash("sha256")
    .update(`billing:reconciliation:${mchid}:${day}`)
    .digest()
    .readBigInt64BE();
  const rows = await tx.$queryRawUnsafe<{ locked: boolean }[]>(
    "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked",
    key,
  );
  if (!rows[0]?.locked) throw new AppError("BUSY");
}
export async function underDay<T>(
  deps: ReconciliationDeps,
  day: string,
  fn: (signal: AbortSignal) => Promise<T>,
  signal?: AbortSignal,
) {
  const source = sourceOf(deps);
  if (day >= calendarDate(deps.clock.now())) throw new AppError("VALIDATION_FAILED");
  try {
    return await deps.sessionMutex.run(
      `billing:reconciliation:${source.mchid}:${day}`,
      (scope) => fn(scope.signal),
      { signal },
    );
  } catch (error) {
    if (error instanceof SessionMutexError) throw new AppError("BUSY", { cause: error });
    throw error;
  }
}
