import { useSyncExternalStore } from "react";
import { Button, Card, Space, Typography } from "antd";

import { SessionBoundary } from "../session/SessionBoundary";
import type { PortalSessionStore } from "../session/model";

const displayTime = (value: string) =>
  new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));

/** The login leaf presents the shared session; it never retains an exchange DTO as identity. */
export function AuthorizedSession({ store }: { store: PortalSessionStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const session = snapshot.status === "authenticated" ? snapshot.session : null;
  return (
    <SessionBoundary store={store}>
      {session ? (
        <Card>
          <Space orientation="vertical" size="middle">
            <Typography.Title level={2}>电脑授权已确认</Typography.Title>
            <Typography.Paragraph>
              本次电脑授权仅适用于当前门店。离开公用电脑前，请退出电脑授权。
            </Typography.Paragraph>
            <div>
              授权时间：
              <time dateTime={session.authorizedAt}>{displayTime(session.authorizedAt)}</time>
            </div>
            <div>
              到期时间：<time dateTime={session.expiresAt}>{displayTime(session.expiresAt)}</time>
            </div>
            <Button onClick={() => void store.load()}>刷新授权状态</Button>
          </Space>
        </Card>
      ) : null}
    </SessionBoundary>
  );
}
