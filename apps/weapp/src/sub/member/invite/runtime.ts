import type { Invitation, TenantApi } from "../members/api";
export const invitationSharePath = (card: Invitation) =>
  `/sub/member/join/index?token=${encodeURIComponent(card.token)}`;
export function createInvitationFlow(api: TenantApi, key: () => string) {
  let attempted = false;
  return {
    shared: () => attempted,
    async share(card: Invitation) {
      attempted = true; // 仅表示发起原生分享，绝不推断accepted。
      await api.markShared(card.invitationId, key());
    },
    async leave(card: Invitation) {
      if (!attempted) await api.revoke(card.invitationId, "unshared_leave", key());
    },
  };
}
