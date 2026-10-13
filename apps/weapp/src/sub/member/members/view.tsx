import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Taro, { useDidHide, useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { Note } from "@/components/Note";
import { newIdempotencyKey } from "@/lib/runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { createResource } from "../../profile/private/resource";
import { createTenantAction, tenantError } from "./model";
import { tenantContext, tenantRuntime } from "./runtime";
import type { TenantApi } from "./api";
import "./style.scss";
export { Frame, TextField, DictPicker } from "../../profile/private/ui";
function tenantReader<T>(read: (api: TenantApi) => Promise<T>) {
  return async (current: () => boolean) => {
    const runtime = await tenantRuntime();
    return current() ? read(runtime.api) : undefined;
  };
}
export function useTenantRead<T>(read: (api: TenantApi) => Promise<T>, readKey = "") {
  const [scopeResource] = useState(() =>
    createResource<T>({
      context: tenantContext,
      read: tenantReader(read),
      message: tenantError,
    }),
  );
  useEffect(() => {
    scopeResource.setReader(tenantReader(read));
  }, [read, scopeResource]);
  const state = useSyncExternalStore(
    scopeResource.subscribe,
    scopeResource.snapshot,
    scopeResource.snapshot,
  );
  useDidShow(() => {
    scopeResource.activate();
    void scopeResource.load();
  });
  useDidHide(() => scopeResource.dispose());
  usePullDownRefresh(() => {
    void scopeResource.load().finally(() => Taro.stopPullDownRefresh());
  });
  useEffect(() => {
    scopeResource.activate();
    let previous = tenantContext();
    const changed = () => {
      const next = tenantContext();
      if (previous === next) return;
      previous = next;
      scopeResource.reset();
      void scopeResource.load();
    };
    const offContext = useContextStore.subscribe(changed);
    const offSession = useSessionStore.subscribe((s, p) => {
      if (s.accessToken !== p.accessToken || s.me !== p.me) changed();
    });
    return () => {
      scopeResource.dispose();
      offContext();
      offSession();
    };
  }, [scopeResource]);
  const initialKey = useRef(readKey);
  useEffect(() => {
    if (initialKey.current === readKey) return;
    initialKey.current = readKey;
    scopeResource.reset();
    void scopeResource.load();
  }, [readKey, scopeResource]);
  return { ...state, load: scopeResource.load, setData: scopeResource.setData };
}
export function useTenantAction(name: string, key?: () => string) {
  const [action] = useState(() =>
    createTenantAction(tenantContext, key ?? (() => newIdempotencyKey(name))),
  );
  const state = useSyncExternalStore(action.subscribe, action.snapshot, action.snapshot);
  useDidShow(() => action.activate());
  useDidHide(() => action.hide());
  useEffect(() => {
    action.activate();
    let previous = tenantContext();
    const changed = () => {
      const next = tenantContext();
      if (next !== previous) {
        previous = next;
        action.invalidate();
      }
    };
    const offContext = useContextStore.subscribe(changed);
    const offSession = useSessionStore.subscribe((s, p) => {
      if (s.accessToken !== p.accessToken || s.me !== p.me) changed();
    });
    return () => {
      action.dispose();
      offContext();
      offSession();
    };
  }, [action]);
  return { ...state, run: action.run };
}
export const ActionError = ({ error }: { error: string | null }) =>
  error ? <Note tone="danger">{error}</Note> : null;
