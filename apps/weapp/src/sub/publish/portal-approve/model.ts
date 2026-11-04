import type { Me } from "@/lib/account-api";

/** 同令牌下成员/主体/可用门店变化也清除确认；仅用于本页内存所有权比较。 */
export function approvalIdentity(
  scope: { token: string | null; store: string | null; rev: number; role?: string },
  me: Me | null,
): string {
  const member = me?.memberships.find((item) =>
    item.stores.some((store) => store.storeId === scope.store),
  );
  return JSON.stringify([
    scope,
    me?.user.merchantUserId,
    member?.memberId,
    member?.entity.entityId,
    member?.stores.map((store) => [store.storeId, store.lifecycle]).sort(),
  ]);
}

/** QR payloads only supply a ticket code; they never select an API host or authorize a device. */
export function portalCode(input: string): string | null {
  const value = input.trim();
  if (/^[A-Za-z0-9_-]{22}$/.test(value)) return value;
  const short = value.replace(/[\s-]/g, "").toUpperCase();
  if (/^[0-9A-HJKMNP-TV-Z]{8}$/.test(short)) return short;
  const landing = value.match(/^(?:https?:\/\/[^/?#]+)?\/a\?([^#]*)$/);
  if (!landing) return null;
  const tickets = landing[1]!.split("&").filter((part) => part.startsWith("t="));
  if (tickets.length !== 1) return null;
  try {
    const ticket = decodeURIComponent(tickets[0]!.slice(2));
    return /^[A-Za-z0-9_-]{22}$/.test(ticket) ? ticket : null;
  } catch {
    return null;
  }
}

export function ticketExpired(expiresAt: string, now: number): boolean {
  const expiry = Date.parse(expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

/** Recheck the visible preview against the current merchant scope before either decision. */
export function assertPortalDecision(
  preview: { storeId: string; expiresAt: string; pairChoices: readonly string[] },
  scope: { store: string | null; role?: string },
  now: number,
  pair?: string,
): void {
  if (scope.role !== "owner") throw new Error("仅老板可授权电脑，请切换到老板门店");
  if (preview.storeId !== scope.store) throw new Error("当前门店已变化，请重新打开电脑下载授权");
  if (ticketExpired(preview.expiresAt, now))
    throw new Error("登录码已过期，请在电脑上刷新后重新输入");
  if (pair !== undefined && !preview.pairChoices.includes(pair))
    throw new Error("请先选择电脑上显示的两位数字");
}
