import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import Taro, { useDidShow, usePullDownRefresh, useReachBottom } from "@tarojs/taro";
import { account } from "@/lib/account-runtime";
import { newIdempotencyKey } from "@/lib/runtime";
import { useSessionStore } from "@/stores/session";
import {
  currentMessageScope,
  messageRequest,
  publishMessageSummary,
  useMessageScope,
} from "@/stores/messages";
import { createMessagesApi } from "./api";
import { createMessagesController } from "./model";

export const messagesApi = createMessagesApi(messageRequest);
export function useMessagesResource() {
  const scope = useMessageScope();
  const controller = useMemo(
    () =>
      createMessagesController({
        api: messagesApi,
        scope: currentMessageScope,
        initialScope: scope,
        key: () => newIdempotencyKey("message_read"),
        publish: publishMessageSummary,
      }),
    [scope],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  const load = useCallback(async () => {
    await account.start();
    if (useSessionStore.getState().accessToken) await controller.refresh();
  }, [controller]);
  useEffect(() => {
    void load().catch(() => {});
    return controller.dispose;
  }, [controller, load]);
  useDidShow(() => {
    void load().catch(() => {});
  });
  usePullDownRefresh(() => {
    void load()
      .finally(() => Taro.stopPullDownRefresh())
      .catch(() => {});
  });
  useReachBottom(() => {
    void controller.more();
  });
  return { state, controller, scope };
}
