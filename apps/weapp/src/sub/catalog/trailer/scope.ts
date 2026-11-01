import type { Me } from "@/lib/account-api";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";

export const trailerScopeKey = () => {
  const context = useContextStore.getState(),
    session = useSessionStore.getState();
  const me = session.me as Me | null;
  return JSON.stringify({
    storeId: context.currentStoreId,
    rev: context.contextRev,
    token: session.accessToken,
    userId: me?.user.merchantUserId,
    memberships: me?.memberships,
  });
};
export function useTrailerIdentity() {
  useContextStore((state) => state.contextRev);
  useContextStore((state) => state.currentStoreId);
  useSessionStore((state) => state.accessToken);
  useSessionStore((state) => state.me);
  return trailerScopeKey();
}
