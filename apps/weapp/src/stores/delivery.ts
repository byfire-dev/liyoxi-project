import type { components } from "@liyoxi/contract/types/merchant";
import { useContextStore } from "./context";
import { useSessionStore } from "./session";
export const deliveryScope = () => {
  const context = useContextStore.getState(),
    session = useSessionStore.getState();
  const me = session.me as components["schemas"]["MeView"] | null;
  const role = me?.memberships.find((m) =>
    m.stores.some((s) => s.storeId === context.currentStoreId),
  )?.role;
  return {
    store: context.currentStoreId,
    rev: context.contextRev,
    token: session.accessToken,
    role,
  };
};
export const deliveryScopeKey = () => JSON.stringify(deliveryScope());
/** 每页独立生命期、同步互斥与意图键；不持久化签名地址或跨门店数据。 */
export function createDeliveryGuard(read: () => string, newKey: (action: string) => string) {
  let live = true,
    generation = 0,
    locked = false;
  const intents = new Map<string, { fingerprint: string; key: string }>();
  const capture = (readVersion = false) => {
    const scope = read(),
      version = generation;
    return () => live && read() === scope && (!readVersion || generation === version);
  };
  return {
    capture,
    nextRead: () => {
      generation++;
      return capture(true);
    },
    invalidate: () => {
      generation++;
    },
    dispose: () => {
      live = false;
      generation++;
    },
    mount: () => {
      live = true;
    },
    begin: () => {
      if (locked || !live) return null;
      locked = true;
      return capture();
    },
    finish: () => {
      locked = false;
    },
    intent: (action: string, value: unknown) => {
      const fingerprint = JSON.stringify(value),
        previous = intents.get(action);
      if (previous?.fingerprint === fingerprint) return previous.key;
      const key = newKey(action);
      intents.set(action, { fingerprint, key });
      return key;
    },
  };
}
