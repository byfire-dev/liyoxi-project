import type { Message, MessagesApi, MessageTab, Settings, Summary } from "./api";
import type { createSubscribe } from "@/lib/subscribe";

export const settingsSubscription = (
  subscribe: ReturnType<typeof createSubscribe>["withSubscribe"],
  refresh: () => Promise<void>,
  onReportCommitted?: () => Promise<void>,
) => subscribe("notify_settings", refresh, onReportCommitted);

export interface MessagesState {
  tab: MessageTab;
  items: Message[];
  cursor: string | null;
  hasMore: boolean;
  loaded: boolean;
  loading: boolean;
  loadingMore: boolean;
  writing: boolean;
  error: string | null;
  summary: Summary | null;
  settings: Settings | null;
  settingsLoading: boolean;
  settingsError: string | null;
}
export function createMessagesController(deps: {
  api: MessagesApi;
  scope: () => string;
  initialScope?: string;
  key: () => string;
  publish: (summary: Summary | null, scope: string) => void;
}) {
  const scope = deps.initialScope ?? deps.scope();
  let alive = true,
    revision = 0,
    summaryRevision = 0,
    settingsRevision = 0;
  let state: MessagesState = {
    tab: "all",
    items: [],
    cursor: null,
    hasMore: false,
    loaded: false,
    loading: false,
    loadingMore: false,
    writing: false,
    error: null,
    summary: null,
    settings: null,
    settingsLoading: false,
    settingsError: null,
  };
  const listeners = new Set<() => void>();
  const keys = new Map<string, { key: string; readAt?: string }>();
  const reads = new Map<string, Promise<boolean>>();
  let batch: { tab: MessageTab; upToMessageId: string; key: string } | null = null;
  const current = () => alive && deps.scope() === scope;
  const reconcileRead = (row: Message): Message => {
    const readAt = keys.get(row.messageId)?.readAt;
    return readAt ? { ...row, isRead: true, readAt } : row;
  };
  const update = (patch: Partial<MessagesState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  const errorText = (error: unknown) =>
    error instanceof Error ? error.message : "暂时加载失败，请重试";
  const publish = (value: Summary | null) => {
    if (current()) {
      update({ summary: value });
      deps.publish(value, scope);
    }
  };
  const refresh = async () => {
    if (!current()) return;
    const run = ++revision,
      summaryRun = ++summaryRevision,
      tab = state.tab;
    update({
      loading: true,
      loadingMore: false,
      error: null,
      items: [],
      cursor: null,
      hasMore: false,
    });
    try {
      const [page, summary] = await Promise.all([deps.api.list(tab, null), deps.api.summary()]);
      if (current() && run === revision) {
        update({
          items: page.items.map(reconcileRead),
          cursor: page.nextCursor,
          hasMore: page.hasMore,
        });
        if (summaryRun === summaryRevision) publish(summary);
      }
    } catch (error) {
      if (run === revision) update({ error: errorText(error) });
    } finally {
      if (run === revision) update({ loading: false, loaded: true });
    }
  };
  const calibrate = async () => {
    const run = ++summaryRevision;
    try {
      const value = await deps.api.summary();
      if (run === summaryRevision) publish(value);
    } catch {
      update({ error: "消息已读成功，未读计数暂未更新，请刷新" });
    }
  };
  return {
    snapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh,
    select: async (tab: MessageTab) => {
      if (!current() || tab === state.tab) return;
      batch = null;
      update({ tab });
      await refresh();
    },
    more: async () => {
      if (!current() || state.loading || state.loadingMore || !state.hasMore || !state.cursor)
        return;
      const run = revision,
        cursor = state.cursor,
        tab = state.tab;
      update({ loadingMore: true, error: null });
      try {
        const page = await deps.api.list(tab, cursor);
        if (current() && run === revision) {
          const ids = new Set(state.items.map((item) => item.messageId));
          update({
            items: [
              ...state.items,
              ...page.items.map(reconcileRead).filter((item) => {
                if (ids.has(item.messageId)) return false;
                ids.add(item.messageId);
                return true;
              }),
            ],
            cursor: page.nextCursor,
            hasMore: page.hasMore,
          });
        }
      } catch (error) {
        if (run === revision) update({ error: errorText(error) });
      } finally {
        if (run === revision) update({ loadingMore: false });
      }
    },
    read: (item: Message): Promise<boolean> => {
      if (!current()) return Promise.resolve(false);
      const existing = reads.get(item.messageId);
      if (existing) return existing;
      const intent = keys.get(item.messageId) ?? { key: deps.key() };
      keys.set(item.messageId, intent);
      const pending = (async () => {
        update({ error: null });
        try {
          const result = await deps.api.read(item.messageId, intent.key);
          if (!current()) return false;
          intent.readAt = result.readAt;
          update({
            items: state.items.map(reconcileRead),
          });
          publish(null);
          await calibrate();
          return current();
        } catch (error) {
          update({ error: errorText(error) });
          return false;
        } finally {
          reads.delete(item.messageId);
        }
      })();
      reads.set(item.messageId, pending);
      return pending;
    },
    batchRead: async () => {
      if (!current() || state.writing || !state.items[0]) return;
      batch ??= { tab: state.tab, upToMessageId: state.items[0].messageId, key: deps.key() };
      const intent = batch;
      update({ writing: true, error: null });
      try {
        const result = await deps.api.batchRead(
          { tab: intent.tab, upToMessageId: intent.upToMessageId },
          intent.key,
        );
        if (!current()) return;
        publish(result.summary);
        batch = null;
        // 重新读取服务端状态；不推算批次 readAt，也不把新到消息乐观标读。
        await refresh();
      } catch (error) {
        update({ error: errorText(error) });
      } finally {
        update({ writing: false });
      }
    },
    settings: async () => {
      if (!current()) return;
      const run = ++settingsRevision;
      update({ settingsLoading: true, settingsError: null });
      try {
        const settings = await deps.api.settings();
        if (run === settingsRevision) update({ settings });
      } catch (error) {
        if (run === settingsRevision) update({ settingsError: errorText(error) });
      } finally {
        if (run === settingsRevision) update({ settingsLoading: false });
      }
    },
    dispose: () => {
      alive = false;
      revision++;
      listeners.clear();
      keys.clear();
      batch = null;
    },
  };
}
