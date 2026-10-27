import { capabilityByKey } from "@liyoxi/contract/authz";
import { calendarDate, parseLocalDate } from "@liyoxi/shared/time";
import type { Me } from "@/lib/account-api";
import { ApiError } from "@/lib/request";
import { messageScope } from "@/stores/messages-scope";
import type { LedgerApi, LedgerPage, LedgerTab } from "./api";

export function ledgerContext(input: {
  token: string | null;
  storeId: string | null;
  contextRev: number;
  me: Me | null;
}) {
  const member = input.me?.memberships.find((m) =>
    m.stores.some((s) => s.storeId === input.storeId),
  );
  const store = member?.stores.find((s) => s.storeId === input.storeId);
  const capability = capabilityByKey("ledger.read");
  const access =
    member?.role === "owner"
      ? store?.lifecycle === "archived"
        ? capability?.archivedOwner
        : store?.lifecycle === "active"
          ? capability?.owner
          : undefined
      : member?.role === "clerk"
        ? capability?.clerk
        : undefined;
  return { key: messageScope(input), allowed: !!input.token && access?.allowed === true };
}

/** 先取公共北京时间日，再取日历月份；不截取UTC时刻字符串。 */
export const ledgerMonth = (now: Date) => calendarDate(now).slice(0, 7);
export const LEDGER_TABS = [
  { key: "all", label: "全部" },
  { key: "gain", label: "获得" },
  { key: "use", label: "使用" },
  { key: "expire", label: "过期" },
] as const;
export interface LedgerState {
  filter: { tab: LedgerTab; month: string };
  page: LedgerPage | null;
  loading: boolean;
  moreBusy: boolean;
  restricted: boolean;
  error: string | null;
  moreError: string | null;
}

export function createLedgerModel(deps: {
  api: LedgerApi;
  prepare(): Promise<unknown>;
  context(): { key: string; allowed: boolean };
  now(): Date;
}) {
  const empty = (): LedgerState => ({
    filter: { tab: "all", month: ledgerMonth(deps.now()) },
    page: null,
    loading: false,
    moreBusy: false,
    restricted: false,
    error: null,
    moreError: null,
  });
  let state = empty(),
    active = false,
    generation = 0,
    scope = "";
  const listeners = new Set<() => void>();
  const set = (patch: Partial<LedgerState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const guard = () => {
    const own = generation,
      key = deps.context().key;
    return () => active && generation === own && deps.context().key === key;
  };
  async function load(more = false) {
    if (
      !active ||
      scope !== deps.context().key ||
      state.loading ||
      (more && (state.moreBusy || !state.page?.hasMore))
    )
      return;
    if (!more) {
      generation++;
      set({ page: null, loading: true, moreBusy: false, error: null, moreError: null });
    } else set({ moreBusy: true, moreError: null });
    const current = guard(),
      filter = { ...state.filter };
    const cursor = more ? (state.page?.nextCursor ?? undefined) : undefined;
    try {
      await deps.prepare();
      if (!current()) return;
      if (!deps.context().allowed) {
        set({ restricted: true, page: null });
        return;
      }
      const page = await deps.api.list({ ...filter, ...(cursor ? { cursor } : {}) });
      if (!current()) return;
      if (page.month !== filter.month || (page.hasMore && !page.nextCursor))
        throw new Error("流水分页不完整");
      const items = more ? [...(state.page?.items ?? [])] : [];
      const seen = new Set(items.map((item) => item.rowKey));
      for (const item of page.items) {
        if (!seen.has(item.rowKey)) items.push(item);
        seen.add(item.rowKey);
      }
      set({ page: { ...page, items }, restricted: false });
    } catch (failure) {
      if (!current()) return;
      if (
        failure instanceof ApiError &&
        [
          "ROLE_FORBIDDEN",
          "PERMISSION_DENIED",
          "NOT_A_MEMBER",
          "STORE_ARCHIVED",
          "NOT_FOUND",
        ].includes(failure.error)
      )
        set({ restricted: true, page: null });
      else
        set(
          more
            ? { moreError: "暂时无法加载更多流水，请重试" }
            : { error: "暂时无法加载积分流水，请重试" },
        );
    } finally {
      // 刷新、切店、换身份或隐藏后，旧finally不能解开新请求的锁。
      if (current()) set({ loading: false, moreBusy: false });
    }
  }
  function reset(filter: LedgerState["filter"]) {
    generation++;
    state = { ...empty(), filter };
    set({});
    return load();
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async show() {
      if (active && scope === deps.context().key) return;
      active = true;
      scope = deps.context().key;
      await reset(empty().filter);
    },
    hide() {
      active = false;
      generation++;
      state = empty();
      set({});
    },
    isActive: () => active,
    refresh: () => load(),
    more: () => load(true),
    filter(tab: LedgerTab, month = state.filter.month) {
      if (!active) return;
      try {
        parseLocalDate(`${month}-01`);
      } catch {
        return;
      }
      if (month > ledgerMonth(deps.now())) return;
      if (tab === state.filter.tab && month === state.filter.month) return;
      return reset({ tab, month });
    },
    clear() {
      if (!active) return;
      const filter = empty().filter;
      if (state.filter.tab === filter.tab && state.filter.month === filter.month) return;
      return reset(filter);
    },
    previous() {
      if (state.page?.prevMonth) return this.filter(state.filter.tab, state.page.prevMonth);
    },
  };
}
