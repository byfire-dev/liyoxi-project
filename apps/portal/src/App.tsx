// 电脑端共享主题与会话路由；各工作包显式登记叶页，不放购买或付款引导（D7 第 6 节）。
import { antdTheme, fontFamilySerif } from "@liyoxi/shared/design/antd-theme";
import { ConfigProvider, theme, type ThemeConfig } from "antd";
import zhCN from "antd/locale/zh_CN";
import { useEffect, useMemo, useState } from "react";

import { SessionBoundary } from "./features/session/SessionBoundary";
import { createPortalRoutes, type PortalRoute } from "./lib/routes";
import type { PortalRuntime } from "./lib/runtime";

/** 主题取 W0-26 的生成物，与后台同一份全局主题；不写色值 */
const portalTheme: ThemeConfig = { token: { ...antdTheme.token } };

function Placeholder() {
  const { token } = theme.useToken();
  return (
    <main
      style={{
        display: "flex",
        minHeight: "100vh",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: token.marginXS,
        padding: token.paddingLG,
        background: token.colorBgLayout,
        color: token.colorText,
        fontFamily: token.fontFamily,
        textAlign: "center",
      }}
    >
      <h1
        style={{
          margin: 0,
          fontFamily: fontFamilySerif,
          fontSize: token.fontSizeHeading3,
          fontWeight: 700,
        }}
      >
        狸有戏 · 电脑端下载
      </h1>
      <p style={{ margin: 0, fontSize: token.fontSize, color: token.colorTextSecondary }}>
        页面建设中。请在狸有戏小程序里查看与确认成片。
      </p>
    </main>
  );
}

function ApplicationRoutes({
  runtime,
  routes,
}: {
  runtime: PortalRuntime;
  routes: readonly PortalRoute[];
}) {
  const registry = useMemo(() => createPortalRoutes(routes), [routes]);
  const [target, setTarget] = useState(() =>
    typeof window === "undefined" ? "/" : window.location.pathname + window.location.search,
  );
  const match = registry.match(target);
  useEffect(() => {
    const changed = () => setTarget(window.location.pathname + window.location.search);
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted && registry.match(window.location.pathname)?.route.access === "session")
        void runtime.session.load();
    };
    window.addEventListener("popstate", changed);
    window.addEventListener("pageshow", restored);
    return () => {
      window.removeEventListener("popstate", changed);
      window.removeEventListener("pageshow", restored);
    };
  }, [registry, runtime]);
  if (!match)
    return target === "/" ? (
      <Placeholder />
    ) : (
      <main>
        <h1>页面暂不可用</h1>
        <a href="/">返回首页</a>
      </main>
    );
  const leaf = <div key={target}>{match.route.render(match.params)}</div>;
  return match.route.access === "public" ? (
    leaf
  ) : (
    <SessionBoundary store={runtime.session}>{leaf}</SessionBoundary>
  );
}

const noRoutes: readonly PortalRoute[] = [];
export function App({
  runtime,
  routes = noRoutes,
}: { runtime?: PortalRuntime; routes?: readonly PortalRoute[] } = {}) {
  return (
    <ConfigProvider theme={portalTheme} locale={zhCN}>
      {runtime ? <ApplicationRoutes runtime={runtime} routes={routes} /> : <Placeholder />}
    </ConfigProvider>
  );
}
