import { theme } from "antd";
import type { CSSProperties, ReactNode } from "react";
import { fontFamilySerif } from "@liyoxi/shared/design/antd-theme";
import "./style.css";

export function DownloadLayout({ children }: { children: ReactNode }) {
  const { token } = theme.useToken();
  const style = {
    "--download-surface": token.colorBgContainer,
    "--download-muted": token.colorTextSecondary,
    "--download-border": token.colorBorderSecondary,
    "--download-accent": token.colorPrimary,
    "--download-soft": token.colorPrimaryBg,
    "--download-radius": `${token.borderRadiusLG}px`,
    color: token.colorText,
    fontFamily: token.fontFamily,
  } as CSSProperties;
  return (
    <main className="portal-download" style={style}>
      <div className="portal-download-brand" style={{ fontFamily: fontFamilySerif }}>
        狸有戏 · 电脑端下载
      </div>
      {children}
    </main>
  );
}
