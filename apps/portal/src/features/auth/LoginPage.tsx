import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, QRCode, Space, Spin, Typography, theme } from "antd";

import type { PortalRuntime } from "../../lib/runtime";
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
  const [now, setNow] = useState(Date.now);
  const model = useRef<PortalLoginModel | null>(null);
  useEffect(() => {
    const current = createPortalLoginModel(runtime, {
      authenticated: () => window.location.assign("/items"),
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
  }, [runtime]);
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
        <Typography.Paragraph>
          在小程序确认门店授权后，即可查看已交付成片，按集下载到电脑。
        </Typography.Paragraph>
        <Card title="小程序授权登录">
          <Space orientation="vertical" size="large" style={{ width: "100%" }}>
            <Typography.Paragraph>
              打开狸有戏小程序，进入成片下载页，选择「电脑下载」，再点「扫描电脑登录码」。
              也可手输下方 8 位登录码，核对两位确认数字后授权。
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
              请用小程序内的扫码按钮。微信首页「扫一扫」不能直接登录。
              每次授权仅限所选门店，离开公用电脑前请退出登录。
            </Typography.Text>
          </Space>
        </Card>
      </div>
    </main>
  );
}
