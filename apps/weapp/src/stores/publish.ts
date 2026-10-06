import { create } from "zustand";
import { catalogScope, scopeKey, createCatalogLifetime } from "./catalog";
export const createPublishLifetime = createCatalogLifetime;
export const usePublishStore = create<{
  scope: string;
  revision: number;
  ensureScope(): void;
  changed(): void;
}>()((set, get) => ({
  scope: "",
  revision: 0,
  ensureScope: () => {
    const scope = scopeKey(catalogScope());
    if (scope !== get().scope) set({ scope, revision: 0 });
  },
  changed: () => set({ revision: get().revision + 1 }),
}));
