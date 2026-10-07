import type { ReactNode } from "react";

import { EmptyState, ErrorState } from "./StateBlock";
import "./W202Pages.css";

export type MasterDetailState =
  | { key: string; status: "loading" }
  | { key: string; status: "error"; message?: string }
  | { key: string; status: "empty" }
  | { key: string; status: "ready"; content: ReactNode };

export interface MasterDetailPageProps {
  label: string;
  /** 调用方从经过 validateSearch 的 URL 读取并回写选中项。 */
  selectedKey?: string;
  onSelect: (key: string | undefined) => void;
  list: (selection: {
    selectedKey?: string;
    onSelect: MasterDetailPageProps["onSelect"];
  }) => ReactNode;
  /** 详情必须带取数时的 key，过期响应不得显示在另一个选中项下。 */
  detail?: MasterDetailState;
  detailTitle?: string;
  onRetry: () => void;
}

export function MasterDetailPage({
  label,
  selectedKey,
  onSelect,
  list,
  detail,
  detailTitle = "详情",
  onRetry,
}: MasterDetailPageProps) {
  const current = detail?.key === selectedKey ? detail : undefined;
  return (
    <div className="lyx-master-detail" role="region" aria-label={label}>
      <div className="lyx-master-detail__list">{list({ selectedKey, onSelect })}</div>
      <aside className="lyx-card lyx-w202-side" aria-label={detailTitle}>
        <h2>{detailTitle}</h2>
        {!selectedKey ? (
          <EmptyState title="请选择一条记录" />
        ) : !current || current.status === "loading" ? (
          <div className="lyx-skeleton-rows" aria-label="详情加载中" aria-busy="true">
            {Array.from({ length: 3 }, (_, index) => (
              <div key={index} className="lyx-skeleton-bar" />
            ))}
          </div>
        ) : current.status === "error" ? (
          <ErrorState message={current.message} onRetry={onRetry} />
        ) : current.status === "empty" ? (
          <EmptyState title="记录不存在" description="记录可能已被处理，请选择其他记录" />
        ) : (
          <div key={current.key}>{current.content}</div>
        )}
      </aside>
    </div>
  );
}
