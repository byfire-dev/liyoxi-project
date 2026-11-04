import type { PortalSessionStore } from "../session/model";
import { safePortalError } from "../../lib/api-errors";
import type { AdPage, ItemsApi, OrderPage } from "./api";

export interface PageState<T> {
  readonly page: T | null;
  readonly loading: boolean;
  readonly error: string;
}
export interface ItemsSnapshot {
  readonly orders: PageState<OrderPage>;
  readonly ads: PageState<AdPage>;
}

/** Each section owns its cursor and request; neither can erase the other section. */
export function createItemsModel(api: ItemsApi, session: PortalSessionStore) {
  let snapshot: ItemsSnapshot = {
    orders: { page: null, loading: true, error: "" },
    ads: { page: null, loading: true, error: "" },
  };
  const listeners = new Set<() => void>();
  const active = new Map<keyof ItemsSnapshot, AbortController>();
  const publish = (next: ItemsSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  async function load(section: keyof ItemsSnapshot, more = false) {
    const scope = session.captureScope();
    if (!scope || active.has(section)) return;
    const old = snapshot[section];
    if (more && !old.page?.nextCursor) return;
    const controller = new AbortController();
    active.set(section, controller);
    const signal = AbortSignal.any([scope.signal, controller.signal]);
    const current = () => scope.isCurrent() && !signal.aborted;
    publish({ ...snapshot, [section]: { ...old, loading: true, error: "" } });
    try {
      const page = await api[section](more ? old.page!.nextCursor! : undefined, signal);
      if (!current()) return;
      publish({
        ...snapshot,
        [section]: {
          page: { ...page, items: more ? [...old.page!.items, ...page.items] : page.items },
          loading: false,
          error: "",
        },
      });
    } catch (error) {
      if (current())
        publish({
          ...snapshot,
          [section]: {
            ...old,
            loading: false,
            error: safePortalError(error).message,
          },
        });
    } finally {
      if (active.get(section) === controller) active.delete(section);
    }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load,
    stop() {
      for (const controller of active.values()) controller.abort();
      active.clear();
    },
  };
}
