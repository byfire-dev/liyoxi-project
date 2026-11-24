import type { Prisma } from "@liyoxi/db";
import { AppError } from "../../kernel/index.js";
import type { AppEnv, Tx } from "../../kernel/index.js";

/** Immutable policy ids: changing future defaults must not reinterpret approved history. */
const policies = {
  local: { id: "bank-delay-v1:local:0s", seconds: 0 },
  test: { id: "bank-delay-v1:test:0s", seconds: 0 },
  stg: { id: "bank-delay-v1:stg:30s", seconds: 30 },
  prod: { id: "bank-delay-v1:prod:24h", seconds: 86_400 },
} as const;

export const bankAccountActivationPolicy = (appEnv: AppEnv) => policies[appEnv].id;
export const bankAccountApprovalDelaySeconds = (appEnv: AppEnv) => policies[appEnv].seconds;

export function financeConfigActivationDelaySeconds(
  configKey: string,
  payload: unknown,
  appEnv?: AppEnv,
): number {
  const record = payload && typeof payload === "object" ? payload : {};
  if (!("activationPolicy" in record)) return configKey === "bank_account" ? 86_400 : 0;
  if (configKey !== "bank_account") throw new AppError("PRECONDITION_CHANGED");
  const selected = Object.entries(policies).find(
    ([, policy]) => policy.id === record.activationPolicy,
  );
  if (!selected || (appEnv !== undefined && selected[0] !== appEnv))
    throw new AppError("PRECONDITION_CHANGED");
  return selected[1].seconds;
}

/** Once a later approval becomes effective, an earlier slow approval cannot replace it. */
export const financeConfigCurrentOrder = [
  { approvalRequest: { decidedAt: "desc" } },
  { id: "desc" },
] satisfies Prisma.FinanceConfigRevisionOrderByWithRelationInput[];

export function currentFinanceConfig(tx: Tx, configKey: string, at: Date) {
  return tx.financeConfigRevision.findFirst({
    where: { configKey, effectiveAt: { lte: at }, approvalRequest: { status: "approved" } },
    orderBy: financeConfigCurrentOrder,
    include: { approvalRequest: { select: { decidedAt: true } } },
  });
}
