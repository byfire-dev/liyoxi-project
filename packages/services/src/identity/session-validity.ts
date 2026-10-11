/** 两个会话入口共用的纯有效性规则；顺序与原 bearer 校验一致。 */
export function sessionInvalidReason(
  facts: {
    revoked: boolean;
    absoluteExpiresAt: Date;
    idleExpiresAt: Date;
    accountStatus: string;
  },
  now: Date,
): "revoked" | "absolute_expired" | "idle_expired" | "account_inactive" | undefined {
  if (facts.revoked) return "revoked";
  if (now.getTime() >= facts.absoluteExpiresAt.getTime()) return "absolute_expired";
  if (now.getTime() >= facts.idleExpiresAt.getTime()) return "idle_expired";
  if (facts.accountStatus !== "active") return "account_inactive";
  return undefined;
}
