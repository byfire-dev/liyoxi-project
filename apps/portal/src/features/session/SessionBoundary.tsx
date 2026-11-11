import { Alert, Button, Space, Spin, theme } from "antd";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";

import type { PortalSessionSnapshot, PortalSessionStore } from "./model";

export function sessionExplanation(snapshot: PortalSessionSnapshot): string {
  const reason = snapshot.error?.details.reason;
  if (reason === "expired") return "本次电脑授权已过期，请重新授权";
  if (reason === "authorizer_invalid") return "授权人资格已变化，请联系门店老板重新授权";
  if (reason === "revoked") {
    return snapshot.error?.details.revokeReason === "owner_revoked"
      ? "门店老板已撤销这台电脑的授权"
      : "本次电脑授权已撤销，请重新授权";
  }
  return "当前电脑尚未授权或授权已失效";
}

export function SessionBoundary({
  store,
  children,
}: {
  store: PortalSessionStore;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { token } = theme.useToken();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    void store.load();
  }, [store]);
  useEffect(() => {
    if (snapshot.retryAt === null) return;
    const delay = Math.max(0, snapshot.retryAt - Date.now());
    const timer = setTimeout(() => setNow(Date.now()), Math.min(delay, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [snapshot.retryAt]);
  const coolingDown = snapshot.retryAt !== null && now < snapshot.retryAt;
  if (snapshot.status === "unknown" || snapshot.status === "loading") {
    return (
      <div role="status" style={{ padding: token.paddingLG }}>
        <Spin /> 正在核对电脑授权…
      </div>
    );
  }
  if (snapshot.status === "maintenance") {
    return (
      <Space orientation="vertical">
        <Alert type="info" title="系统维护中，请稍后再来" />
        <Button onClick={() => window.location.reload()}>重新加载页面</Button>
      </Space>
    );
  }
  if (snapshot.status === "invalid") {
    return (
      <Space orientation="vertical">
        <Alert type="warning" title={sessionExplanation(snapshot)} />
        <a href="/">返回首页</a>
      </Space>
    );
  }
  if (snapshot.status === "error") {
    return (
      <Space orientation="vertical">
        <Alert
          role="alert"
          type="error"
          title={snapshot.error?.message ?? "读取失败，请稍后重试"}
        />
        <Button
          disabled={coolingDown}
          onClick={() => {
            void store.load();
          }}
        >
          {coolingDown ? "请稍后重试" : "重新读取授权"}
        </Button>
      </Space>
    );
  }
  return (
    <section aria-label="电脑授权会话" style={{ display: "grid", gap: token.marginMD }}>
      <Space wrap>
        <span>当前门店：{snapshot.session?.storeName ?? "未命名门店"}</span>
        <Button
          disabled={coolingDown}
          loading={snapshot.logoutPending}
          onClick={() => {
            void store.logout();
          }}
        >
          退出电脑授权
        </Button>
      </Space>
      {snapshot.error ? <Alert role="alert" type="warning" title={snapshot.error.message} /> : null}
      {/* A new scope unmounts all old leaf state; asynchronous work also receives captureScope().signal. */}
      {snapshot.logoutPending ? (
        <div role="status">正在退出电脑授权…</div>
      ) : (
        <div key={snapshot.scope}>{children}</div>
      )}
    </section>
  );
}
