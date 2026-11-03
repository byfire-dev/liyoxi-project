import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useContext, useMemo } from "react";
import type { AppServices } from "../../../app/services";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { AccessContext } from "../../../lib/permissions";
import { LIST_QUERY } from "../../../lib/query";
import { actorScope } from "../../system/staff-access";
import { createOverdueApi } from "../overdue/api";
import { overdueLabel } from "../overdue/model";

/** Current overdue tasks have their own query; month items cannot prove this total. */
export function CalendarOverduePanel({
  services,
  managerId,
}: {
  services: AppServices;
  managerId?: string;
}) {
  const scope = actorScope(useContext(AccessContext)),
    api = useMemo(() => createOverdueApi(services), [services]);
  const query = useQuery({
    queryKey: ["publish", "calendar-overdue", scope, managerId],
    queryFn: ({ signal }) => api.list({ tab: "overdue", managerId, page: 1, pageSize: 5 }, signal),
    ...LIST_QUERY,
  });
  const data = !query.isPlaceholderData && !query.isError ? query.data : undefined;
  return (
    <section className="lyx-card lyx-calendar-overdue" aria-label="逾期未上线面板">
      <h2>逾期未上线{data ? ` · ${data.total} 单` : ""}</h2>
      {query.isError ? (
        <ErrorState message={query.error.message} onRetry={() => void query.refetch()} />
      ) : !data ? (
        <p aria-busy="true">逾期事项加载中</p>
      ) : !data.items.length ? (
        <EmptyState title="暂无逾期未上线事项" />
      ) : (
        <ul>
          {data.items.map((row) => (
            <li key={row.orderItem.orderItemId}>
              <Link
                to="/publish/overdue"
                search={{ tab: "overdue", managerId, orderItemId: row.orderItem.orderItemId }}
              >
                {row.store.storeName ?? "未命名门店"} · {row.orderItem.dramaTitle} ·{" "}
                {overdueLabel(row)}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link to="/publish/overdue" search={{ tab: "overdue", managerId }}>
        查看全部逾期与跟进
      </Link>
    </section>
  );
}
