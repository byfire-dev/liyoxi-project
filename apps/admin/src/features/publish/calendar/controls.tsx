import { useInfiniteQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Alert, Button, Select } from "antd";
import { useContext, useEffect, useRef, useState } from "react";
import { AccessContext } from "../../../lib/permissions";
import { LIST_QUERY } from "../../../lib/query";
import { actorScope } from "../../system/staff-access";
import type { CalendarApi } from "./api";
import { managerAccess, verifyApprovalId } from "./model";

export function ManagerFilter({
  api,
  value,
  onChange,
}: {
  api: CalendarApi;
  value?: string;
  onChange(value?: string): void;
}) {
  const access = useContext(AccessContext),
    permission = managerAccess(access);
  const query = useInfiniteQuery({
    queryKey: ["publish", "manager-options", actorScope(access), permission.pool],
    enabled: permission.allowed,
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => api.managers(pageParam, permission.pool, signal),
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
    ...LIST_QUERY,
  });
  const options = (query.data?.pages.flatMap((page) => page.items) ?? []).map((staff) => ({
    value: staff.staffId,
    label: staff.name,
  }));
  if (value && !options.some((option) => option.value === value))
    options.push({ value, label: "已指定交付经理" });
  return (
    <div className="lyx-launch-manager">
      <Select
        aria-label="交付经理"
        placeholder="全部交付经理"
        allowClear
        showSearch
        optionFilterProp="label"
        value={value}
        options={options}
        onChange={onChange}
        loading={query.isFetching}
        disabled={!permission.allowed && !value}
      />
      {!permission.allowed ? <span>仅展示当前可见范围；经理条件可清除</span> : null}
      {query.isError ? (
        <Alert
          type="warning"
          title="交付经理候选加载失败"
          action={<Button onClick={() => void query.refetch()}>重试</Button>}
        />
      ) : null}
      {query.hasNextPage ? (
        <Button
          size="small"
          loading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          加载更多经理
        </Button>
      ) : null}
    </div>
  );
}

/** Existing verify selection uses approvalId, never the launch submission's id. */
export function VerifyLink({
  api,
  submissionId,
  accountName,
}: {
  api: CalendarApi;
  submissionId: string;
  accountName: string;
}) {
  const navigate = useNavigate(),
    lifetime = useRef<AbortController | null>(null),
    active = useRef(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  useEffect(() => () => lifetime.current?.abort(), []);
  const open = async () => {
    if (active.current) return;
    active.current = true;
    const controller = new AbortController();
    lifetime.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const detail = await api.submission(submissionId, controller.signal);
      if (controller.signal.aborted) return;
      const approvalId = verifyApprovalId(detail, submissionId);
      if (!approvalId) throw new Error("该轮次已处理，请刷新上线任务");
      await navigate({ to: "/publish/verify", search: { tab: "todo", id: approvalId } });
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "核验资料加载失败");
    } finally {
      active.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <div>
      <Button size="small" loading={busy} onClick={() => void open()}>
        去核验 · {accountName}
      </Button>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
