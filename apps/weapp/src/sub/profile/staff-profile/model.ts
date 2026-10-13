import type { Me } from "../../member/members/api";
import { currentMembership } from "../../member/members/model";
export function selfProfile(me: Me, storeId: string | null) {
  const member = currentMembership(me, storeId);
  return member?.role === "clerk" ? { user: me.user, member } : null;
}
