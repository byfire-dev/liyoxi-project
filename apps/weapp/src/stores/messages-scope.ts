import type { Me } from "@/lib/account-api";

export function messageScope(input: {
  token: string | null;
  storeId: string | null;
  contextRev: number;
  me: Me | null;
}) {
  const memberships =
    input.me?.memberships
      .map((member) => ({
        id: member.memberId,
        entityId: member.entity.entityId,
        role: member.role,
        stores: member.stores.map((store) => `${store.storeId}:${store.lifecycle}`).sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)) ?? [];
  return JSON.stringify([
    input.token,
    input.contextRev,
    input.storeId,
    input.me?.user.merchantUserId ?? null,
    memberships,
  ]);
}
