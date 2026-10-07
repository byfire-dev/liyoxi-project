import type { ReactNode } from "react";

import "./W202Controls.css";

export interface NeutralNoticeProps {
  children: ReactNode;
  /** 动态通知可请求礼貌播报；静态说明不占用 live region。 */
  live?: boolean;
}

export function NeutralNotice({ children, live = false }: NeutralNoticeProps) {
  return (
    <div className="lyx-neutral-notice" role={live ? "status" : undefined}>
      {children}
    </div>
  );
}
