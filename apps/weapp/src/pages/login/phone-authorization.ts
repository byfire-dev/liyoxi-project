export interface PhoneAuthorizationDetail {
  code?: string;
  errMsg?: string;
  errno?: number;
}
export function createPhoneAuthorization(deps: {
  supported: boolean;
  scope: () => string;
  privacy: () => Promise<boolean>;
  exhausted: () => void;
}) {
  const scope = deps.scope();
  let alive = true,
    busy = false,
    ready = false;
  let state = { busy: false, ready: false, error: null as string | null };
  const listeners = new Set<() => void>();
  const current = () => alive && deps.scope() === scope;
  const update = (patch: Partial<typeof state>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  return {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    prepare: async (agreed: boolean) => {
      if (!current() || busy) return;
      ready = false;
      update({ ready: false, error: null });
      if (!agreed) {
        update({ error: "请先阅读并勾选下方协议" });
        return;
      }
      if (!deps.supported) {
        update({ error: "请在小程序中授权手机号，此环境不支持号码验证" });
        return;
      }
      busy = true;
      update({ busy: true });
      try {
        const allowed = await deps.privacy();
        if (current()) {
          ready = allowed;
          update({ ready, error: allowed ? null : "未同意隐私授权，请重新授权后继续" });
        }
      } catch {
        update({ error: "隐私授权暂不可用，请重试" });
      } finally {
        busy = false;
        update({ busy: false });
      }
    },
    accept: async (detail: PhoneAuthorizationDetail, submit: (code: string) => Promise<void>) => {
      if (!current() || busy || !ready || !deps.supported) return;
      ready = false;
      update({ ready: false });
      if (detail.errno === 1400001) {
        deps.exhausted();
        update({ error: "手机号验证暂不可用，请稍后重试" });
        return;
      }
      if (!detail.code || detail.code.length > 128) {
        update({ error: "未获得手机号授权，请重新点击授权按钮" });
        return;
      }
      busy = true;
      update({ busy: true, error: null });
      try {
        await submit(detail.code);
      } catch (error) {
        update({ error: error instanceof Error ? error.message : "暂时未能完成，请重试" });
      } finally {
        busy = false;
        update({ busy: false });
      }
    },
    dispose: () => {
      alive = false;
      ready = false;
      listeners.clear();
    },
  };
}
