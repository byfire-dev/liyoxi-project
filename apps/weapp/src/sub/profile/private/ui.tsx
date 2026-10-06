import { useEffect, useRef, useState, type ReactNode } from "react";
import { View } from "@tarojs/components";
import Taro, { useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Input } from "@/components/Input";
import { LoadError } from "@/components/LoadError";
import { Note } from "@/components/Note";
import { PageBody } from "@/components/PageBody";
import { Sheet } from "@/components/Sheet";
import { Skeleton } from "@/components/Skeleton";
import { TextButton } from "@/components/TextButton";
import { newIdempotencyKey, track } from "@/lib/runtime";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import type { ProfileApi, DictItems } from "./api";
import { createIntent, errorInfo, generationGuard } from "./model";
import { profileRuntime, profileContext } from "./runtime";
import "./profile.scss";

export const STEP_NAMES = ["基础信息", "门店环境", "主推服务", "资质认证"];
export const STEP_PATHS = ["basic", "store", "service", "cert"];
export const navigate = (page: string) => {
  void Taro.navigateTo({ url: `/sub/profile/${page}/index` });
};

export function useResource<T>(read: (api: ProfileApi) => Promise<T>) {
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  }, [read]);
  const guard = useRef(generationGuard(profileContext));
  const mounted = useRef(true);
  const requestNo = useRef(0);
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    const requestId = ++requestNo.current;
    try {
      const runtime = await profileRuntime();
      if (!mounted.current || requestId !== requestNo.current) return;
      setError(null);
      setLoading(true);
      const result = await guard.current.run(() => readRef.current(runtime.api));
      if (result !== undefined && mounted.current && requestId === requestNo.current)
        setData(result);
    } catch (e) {
      if (mounted.current && requestId === requestNo.current) setError(errorInfo(e).message);
    } finally {
      if (mounted.current && requestId === requestNo.current) setLoading(false);
    }
  };
  useDidShow(() => {
    void load();
  });
  usePullDownRefresh(() => {
    void load().finally(() => Taro.stopPullDownRefresh());
  });
  useEffect(() => {
    const currentGuard = guard.current;
    const changed = () => {
      currentGuard.invalidate();
      setData(undefined);
      void load();
    };
    const offContext = useContextStore.subscribe((state, previous) => {
      if (state.contextRev !== previous.contextRev) changed();
    });
    const offSession = useSessionStore.subscribe((state, previous) => {
      if (state.accessToken !== previous.accessToken) changed();
    });
    return () => {
      mounted.current = false;
      currentGuard.invalidate();
      offContext();
      offSession();
    };
  }, []);
  return { data, loading, error, load, setData };
}
export function useAction(action: string, step?: 1 | 2 | 3 | 4) {
  const intent = useRef(createIntent(() => newIdempotencyKey(action)));
  const guard = useRef(generationGuard(profileContext));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ReturnType<typeof errorInfo> | null>(null);
  const live = useRef(true);
  const locked = useRef(false);
  const [enteredAt] = useState(() => Date.now());
  useEffect(
    () => () => {
      live.current = false;
      guard.current.invalidate();
    },
    [],
  );
  const run = async <T,>(
    body: unknown,
    call: (key: string) => Promise<T>,
  ): Promise<T | undefined> => {
    if (!live.current || locked.current) return undefined;
    locked.current = true;
    const context = profileContext();
    setError(null);
    setBusy(true);
    try {
      const result = await guard.current.run(() => intent.current.run({ context, body }, call));
      if (result !== undefined && step)
        track("profile_step_save", {
          step,
          durationMs: Math.max(0, Date.now() - enteredAt),
        });
      return result;
    } catch (failure) {
      if (live.current && context === profileContext()) setError(errorInfo(failure));
      return undefined;
    } finally {
      locked.current = false;
      if (live.current) setBusy(false);
    }
  };
  return {
    run,
    busy,
    error,
    setError,
    isCurrent: (context: string) => live.current && context === profileContext(),
  };
}
export function Frame({
  loading,
  error,
  retry,
  children,
  ready = true,
}: {
  loading?: boolean;
  error?: string | null;
  retry?: () => void;
  children?: ReactNode;
  ready?: boolean;
}) {
  return (
    <View className="profile-page" id={!loading && !error && ready ? "profile-ready" : undefined}>
      <PageBody>
        {loading ? (
          <Skeleton cards={3} />
        ) : error ? (
          <LoadError message={error} onRetry={retry} />
        ) : (
          children
        )}
      </PageBody>
    </View>
  );
}
export function Feedback({
  action,
  refresh,
}: {
  action: ReturnType<typeof useAction>;
  refresh?: () => void;
}) {
  return action.error ? (
    <Note tone="danger">
      <View>{action.error.message}</View>
      {action.error.missing.length ? <View>需补充：{action.error.missing.join("、")}</View> : null}
      {action.error.step ? (
        <TextButton onClick={() => navigate(STEP_PATHS[action.error!.step! - 1]!)}>
          去补充{STEP_NAMES[action.error.step - 1]}
        </TextButton>
      ) : null}
      {action.error.conflict && refresh ? (
        <TextButton onClick={refresh}>刷新并核对</TextButton>
      ) : null}
    </Note>
  ) : null;
}
export function TextField({
  label,
  value,
  onChange,
  max = 100,
  disabled,
  required = false,
  hint,
  numeric = false,
}: {
  label: string;
  value: string;
  onChange(value: string): void;
  max?: number;
  disabled?: boolean;
  required?: boolean;
  hint?: string;
  numeric?: boolean;
}) {
  return (
    <Field
      label={label}
      required={required}
      hint={`${hint ? `${hint} · ` : ""}${value.length}/${max}`}
    >
      <Input
        ariaLabel={label}
        value={value}
        maxlength={max}
        disabled={disabled}
        type={numeric ? "digit" : "text"}
        onChange={onChange}
      />
    </Field>
  );
}
export function DictPicker({
  label,
  value,
  items,
  onSelect,
  disabled = false,
}: {
  label: string;
  value: string | null;
  items: DictItems;
  onSelect(code: string): void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Field label={label} required>
        <Button variant="outline" block disabled={disabled} onClick={() => setOpen(true)}>
          {items.find((item) => item.code === value)?.name ?? value ?? `选择${label}`}
        </Button>
      </Field>
      <Sheet visible={open} title={`选择${label}`} onClose={() => setOpen(false)}>
        <View className="profile-options">
          {items.map((item) => (
            <Button
              key={item.code}
              variant={item.code === value ? "outline" : "secondary"}
              disabled={!item.isSelectable}
              block
              onClick={() => {
                onSelect(item.code);
                setOpen(false);
              }}
            >
              {item.name}
              {!item.isSelectable ? "（已停用）" : ""}
            </Button>
          ))}
          {!items.length ? <Note>暂无可选项，请联系服务经理</Note> : null}
        </View>
      </Sheet>
    </>
  );
}
