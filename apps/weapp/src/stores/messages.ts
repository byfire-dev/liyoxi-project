import { useCallback, useEffect } from "react";
import { useDidShow } from "@tarojs/taro";
import { create } from "zustand";
import type { Data } from "@/lib/account-api";
import { account, useAccount } from "@/lib/account-runtime";
import { request } from "@/lib/runtime";
import type { RequestLayer } from "@/lib/request";
import { useContextStore } from "./context";
import { useSessionStore } from "./session";
import { messageScope } from "./messages-scope";

export const currentMessageScope = () =>
  messageScope({
    token: useSessionStore.getState().accessToken,
    ...useContextStore.getState(),
    storeId: useContextStore.getState().currentStoreId,
    me: account.snapshot().me,
  });
export function useMessageScope() {
  const contextRev = useContextStore((s) => s.contextRev),
    storeId = useContextStore((s) => s.currentStoreId);
  const token = useSessionStore((s) => s.accessToken),
    { me } = useAccount();
  return messageScope({ token, storeId, contextRev, me });
}
export const useMessagesStore = create<{
  scope: string;
  summary: Data<"m.message.summary"> | null;
}>(() => ({ scope: "", summary: null }));
let summaryRevision = 0;
export function publishMessageSummary(summary: Data<"m.message.summary"> | null, scope: string) {
  if (scope === currentMessageScope()) {
    summaryRevision++;
    useMessagesStore.setState({ scope, summary });
  }
}
let sceneCall: RequestLayer["request"] | null = null;
export const messageRequest: RequestLayer["request"] = async (path, options) => {
  if (process.env.TARO_ENV === "h5") {
    const scene = (globalThis as { __LYX_MESSAGE_SHOT__?: string }).__LYX_MESSAGE_SHOT__;
    if (scene) {
      sceneCall ??= (await import("../../shots/message-fixtures")).offlineMessageRequest(scene);
      return sceneCall(path, options);
    }
  }
  return request(path, options);
};
export function useMessageBadge() {
  const scope = useMessageScope(),
    badge = useMessagesStore(),
    token = useSessionStore((s) => s.accessToken);
  const reload = useCallback(async () => {
    if (!token) return;
    await account.start();
    if (scope !== currentMessageScope()) return;
    const revision = ++summaryRevision;
    try {
      const summary = await messageRequest<Data<"m.message.summary">>("/m/messages/summary");
      if (revision === summaryRevision) publishMessageSummary(summary, scope);
    } catch {
      if (revision === summaryRevision) publishMessageSummary(null, scope);
    }
  }, [scope, token]);
  useEffect(() => {
    if (useMessagesStore.getState().scope !== scope)
      useMessagesStore.setState({ scope, summary: null });
    void reload().catch(() => {});
  }, [scope, reload]);
  useDidShow(() => {
    void reload().catch(() => {});
  });
  return badge.scope === scope ? (badge.summary?.total ?? null) : null;
}
