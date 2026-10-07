import type { ReactNode } from "react";

import "./W202Controls.css";

export interface EmphasisBlockProps {
  children: ReactNode;
  title?: ReactNode;
}

export function EmphasisBlock({ children, title }: EmphasisBlockProps) {
  return (
    <div className="lyx-emphasis-block">
      {title != null ? <div className="lyx-emphasis-block__title">{title}</div> : null}
      <div>{children}</div>
    </div>
  );
}
