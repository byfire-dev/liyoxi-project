import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, QRCode, Space, Spin, Typography, theme } from "antd";

import type { PortalRuntime } from "../../lib/runtime";
import { AuthorizedSession } from "./AuthorizedSession";
import { createPortalLoginModel, initialLoginSnapshot, type PortalLoginModel } from "./login-model";

const statusText = {
  checking: "正在核对电脑授权…",
  creating: "正在生成登录码…",
  pending: "等待小程序确认授权",
  exchanging: "授权已确认，正在核对电脑会话…",
  rejected: "此次登录已被拒绝，请重新生成登录码",
  expired: "登录码已过期，请重新生成",
  consumed: "登录码已使用，请重新生成",
  authenticated: "电脑授权已确认",
  error: "登录查询已暂停，请重试",
  maintenance: "系统维护中，请稍后再来",
} as const;

export function LoginPage({ runtime }: { runtime: PortalRuntime }) {
  const { token } = theme.useToken();
  const [snapshot, setSnapshot] = useState(initialLoginSnapshot);
  const [showSession, setShowSession] = useState(
    () => runtime.session.getSnapshot().status === "authenticated",
  );
  const [now, setNow] = useState(Date.now);
  const model = useRef<PortalLoginModel | null>(null);
  useEffect(() => {
    if (showSession) return;
    const current = createPortalLoginModel(runtime, {
      authenticated: () => setShowSession(true),
    });
    model.current = current;
    const unsubscribe = current.subscribe(setSnapshot);
    void current.start();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(tick);
      unsubscribe();
      current.dispose();
      if (model.current === current) model.current = null;
    };
  }, [runtime, showSession]);
  const ticket = snapshot.ticket;
  const seconds = ticket ? Math.max(0, Math.ceil((Date.parse(ticket.expiresAt) - now) / 1000)) : 0;
  const waiting = ["checking", "creating", "exchanging"].includes(snapshot.status);
  const cooling = snapshot.retryAt !== null && now < snapshot.retryAt;
  return (
    <main
      style={{
        minHeight: "100vh",
        padding: token.paddingXL,
        background: token.colorBgLayout,
        color: token.colorText,
      }}
    >
      <div style={{ maxWidth: 960, margin: "0 auto" }}>
        <Typography.Title level={1}>狸有戏 · 电脑端下载</Typography.Title>
        {showSession ? (
          <AuthorizedSession store={runtime.session} />
        ) : (
          <Card title="小程序授权登录">
            <Space orientation="vertical" size="large" style={{ width: "100%" }}>
              <Typography.Paragraph>
                请门店老板打开狸有戏小程序，进入「设置」→「已授权的电脑」，选择「授权电脑」或「输入授权码」。
                在授权页扫描下方登录码，或输入 8 位登录码，再核对当前门店与两位确认数字。
              </Typography.Paragraph>
              {ticket ? (
                <QRCode
                  value={ticket.qrUrl}
                  type="svg"
                  size={240}
                  status={
                    snapshot.status === "exchanging"
                      ? "scanned"
                      : snapshot.status === "pending" && seconds > 0
                        ? "active"
                        : "expired"
                  }
                  onRefresh={() => void model.current?.start()}
                />
              ) : waiting ? (
                <Spin />
              ) : null}
              {ticket ? (
                <>
                  <Typography.Text>8 位登录码：{ticket.shortCode}</Typography.Text>
                  <Typography.Text strong>确认数字：{ticket.pairDigits}</Typography.Text>
                </>
              ) : null}
              <div role="status" aria-live="polite">
                {snapshot.status === "pending" && seconds === 0
                  ? statusText.expired
                  : statusText[snapshot.status]}
                {snapshot.status === "pending" && seconds > 0 ? ` · ${seconds} 秒后失效` : ""}
              </div>
              {snapshot.error ? (
                <Alert showIcon type="warning" title={snapshot.error.message} />
              ) : null}
              {snapshot.status === "maintenance" ? (
                <Button onClick={() => window.location.reload()}>重新加载页面</Button>
              ) : (
                <Button
                  loading={waiting}
                  disabled={waiting || cooling}
                  onClick={() => void model.current?.start()}
                >
                  {cooling ? "请稍后重试" : "刷新登录码"}
                </Button>
              )}
              <Typography.Text type="secondary">
                如扫码后打开说明页，请按页面提示回到小程序授权，也可输入 8 位登录码。
                每次授权仅限所选门店，离开公用电脑前请退出电脑授权。
              </Typography.Text>
            </Space>
          </Card>
        )}
      </div>
    </main>
  );
}
