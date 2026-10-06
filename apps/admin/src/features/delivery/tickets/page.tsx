import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Checkbox, Input, Modal, Select } from "antd";
import { useEffect, useRef, useState } from "react";
import { showSuccessNotice } from "../../../app/feedback";
import { FormField } from "../../../components/FormField";
import { PageHeader } from "../../../components/PageHeader";
import { QueryTablePage, type QueryColumn } from "../../../components/QueryTablePage";
import { StatusTag } from "../../../components/StatusTag";
import { useCan, useModuleLevel } from "../../../lib/permissions";
import { DICT_QUERY, QUEUE_QUERY } from "../../../lib/query";
import { withFilter, writeTableSearch } from "../../../lib/table-search";
import { models, platforms } from "../../order/orders/model";
import { createTicketsApi, TicketFailure, type TicketCard, type TicketsApi } from "./api";
import {
  createAssignmentIntent,
  ticketSearch,
  ticketQuery,
  ticketFilters,
  ticketTabs,
  TICKETS_KEY,
} from "./model";
import "./tickets.css";
const route = getRouteApi("/delivery/tickets");
function TicketStep({ row }: { row: TicketCard }) {
  const tone = statusToneByEnum("delivery_ticket.step", row.step)?.admin;
  return (
    <span className="lyx-cell-2">
      {tone ? <StatusTag tone={tone.tone}>{tone.label}</StatusTag> : row.step}
      <span className="lyx-cell-2__sub">
        {row.isPaused
          ? "已暂停"
          : row.urgency === "overdue"
            ? "已超时"
            : row.urgency === "due_today"
              ? "今日到期"
              : "正常处理中"}
      </span>
    </span>
  );
}
function Assignment({
  row,
  api,
  fullStaff,
  onClose,
  onSuccess,
}: {
  row: TicketCard;
  api: TicketsApi;
  fullStaff: boolean;
  onClose(): void;
  onSuccess(): void;
}) {
  const candidates = useQuery({
    queryKey: [...TICKETS_KEY, "managers", fullStaff ? "full" : "pool"],
    queryFn: api.managers,
    ...DICT_QUERY,
  });
  const [staffId, setStaffId] = useState<string>(),
    [note, setNote] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>();
  const [intent] = useState(createAssignmentIntent),
    live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const submit = async () => {
    if (!live.current || !staffId || note.length > 100) return;
    const body = { staffId, ...(note.trim() ? { note: note.trim() } : {}) };
    let started = false;
    try {
      const result = await intent({ id: row.deliveryTicketId, body }, async (key) => {
        if (!live.current) return null;
        started = true;
        setPending(true);
        setError(undefined);
        return api.assign(row.deliveryTicketId, body, key);
      });
      if (!live.current || result === null) return;
      // 写响应（含重放）的签名字段不作页面事实，统一重新读取列表。
      showSuccessNotice("已分配交付经理");
      onSuccess();
      onClose();
    } catch (failure) {
      if (!live.current) return;
      setError(failure instanceof Error ? failure.message : "没有分配成功，请重试");
      if (
        failure instanceof TicketFailure &&
        [
          "VERSION_CONFLICT",
          "STATE_NOT_ALLOWED",
          "PRECONDITION_CHANGED",
          "STAFF_UNAVAILABLE",
        ].includes(failure.code ?? "")
      )
        onSuccess();
    } finally {
      if (started && live.current) setPending(false);
    }
  };
  return (
    <Modal
      open
      title="分配交付经理"
      footer={null}
      width={520}
      onCancel={() => {
        if (!pending) onClose();
      }}
      closable={!pending}
      keyboard={!pending}
      mask={{ closable: !pending }}
    >
      <div className="lyx-ticket-assignment">
        <p>
          {row.store.storeName ?? "未命名门店"} · {row.ticketNo}
        </p>
        <FormField label="交付经理">
          {(field) => (
            <Select
              {...field}
              value={staffId}
              placeholder="选择交付经理"
              loading={candidates.isFetching}
              disabled={pending}
              onChange={setStaffId}
              options={
                candidates.data?.items.map((s) => ({ value: s.staffId, label: s.name })) ?? []
              }
            />
          )}
        </FormField>
        {candidates.isError ? (
          <Alert
            type="error"
            title={candidates.error.message}
            action={<Button onClick={() => void candidates.refetch()}>重试</Button>}
          />
        ) : null}
        <FormField label="分配备注" value={note} maxLength={100}>
          {(field) => (
            <Input.TextArea
              {...field}
              rows={3}
              value={note}
              maxLength={100}
              disabled={pending}
              onChange={(event) => setNote(event.target.value)}
              placeholder="补充交付要求（选填）"
            />
          )}
        </FormField>
        {error ? <Alert type="error" title={error} /> : null}
        <div className="lyx-ticket-assignment__footer">
          <Button disabled={pending} onClick={onClose}>
            取消
          </Button>
          <Button
            type="primary"
            loading={pending}
            disabled={!staffId || candidates.isPending || candidates.isError}
            onClick={() => void submit()}
          >
            确认分配
          </Button>
        </div>
      </div>
    </Modal>
  );
}
export function TicketsPage() {
  const fullStaff = useModuleLevel("system") !== "n",
    canAssign = useCan("merchant.manager.assign"),
    canPickManagers = fullStaff || canAssign;
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate(),
    search = ticketSearch(route.useSearch()),
    api = createTicketsApi(services, fullStaff ? undefined : "delivery_manager"),
    query = ticketQuery(search),
    filters = ticketFilters(search);
  const [assigning, setAssigning] = useState<TicketCard>();
  const list = useQuery({
    queryKey: [...TICKETS_KEY, "list", query],
    queryFn: () => api.list(query),
    ...QUEUE_QUERY,
  });
  const summary = useQuery({
    queryKey: [...TICKETS_KEY, "summary", filters],
    queryFn: () => api.summary(filters),
    ...QUEUE_QUERY,
  });
  const managers = useQuery({
    queryKey: [...TICKETS_KEY, "managers", fullStaff ? "full" : "pool"],
    queryFn: api.managers,
    enabled: canPickManagers,
    ...DICT_QUERY,
  });
  const change = (next: typeof search) =>
    void navigate({ search: writeTableSearch(ticketSearch(writeTableSearch(next))) });
  const refresh = () => {
    void services.queryClient.invalidateQueries({ queryKey: TICKETS_KEY });
  };
  const columns: QueryColumn<TicketCard>[] = [
    { key: "ticketNo", title: "工单号", width: 155, render: (row) => row.ticketNo },
    {
      key: "store",
      title: "商家",
      render: (row) => (
        <span className="lyx-cell-2">
          <strong>{row.store.storeName ?? "未命名门店"}</strong>
          <span className="lyx-cell-2__sub">{row.order.orderNo}</span>
        </span>
      ),
    },
    {
      key: "drama",
      title: "剧目",
      render: (row) => (
        <span className="lyx-cell-2">
          <strong>{row.dramaTitle}</strong>
          <span className="lyx-cell-2__sub">整部 {row.episodeCount} 集</span>
        </span>
      ),
    },
    {
      key: "platform",
      title: "平台",
      width: 60,
      render: (row) => row.platforms.map((p) => platforms[p] ?? p).join("、") || "—",
    },
    { key: "model", title: "模型", width: 78, render: (row) => models[row.productionModel] },
    { key: "step", title: "当前步骤", width: 106, render: (row) => <TicketStep row={row} /> },
    {
      key: "staff",
      title: "负责人",
      width: 90,
      render: (row) => (
        <span className="lyx-cell-2">
          {row.deliveryManager?.name ?? "未分配"}
          <span className="lyx-cell-2__sub">剪辑：{row.editor?.name ?? "未分配"}</span>
        </span>
      ),
    },
    {
      key: "due",
      title: "步骤时限",
      width: 100,
      render: (row) => (row.stepDueAt ? date.dateTime(row.stepDueAt) : "—"),
    },
    {
      key: "launch",
      title: "约定上线",
      width: 88,
      render: (row) => (row.agreedLaunchDate ? date.date(row.agreedLaunchDate) : "待确认"),
    },
    {
      key: "actions",
      title: "操作",
      width: 58,
      align: "right",
      render: (row) =>
        canAssign && row.actions.includes("assign-manager") ? (
          <Button type="link" size="small" onClick={() => setAssigning(row)}>
            分配
          </Button>
        ) : (
          "—"
        ),
    },
  ];
  return (
    <div className="lyx-ticket-page">
      <PageHeader
        title="工单池"
        subtitle="按当前步骤与交付时限安排制作"
        extra={
          summary.data ? (
            <span className="lyx-ticket-summary">
              进行中 <strong>{summary.data.header.processing}</strong> · 已超时{" "}
              <strong>{summary.data.header.overdue}</strong> · 今日到期{" "}
              <strong>{summary.data.header.dueToday}</strong>
            </span>
          ) : undefined
        }
      />
      <QueryTablePage
        label="工单池"
        search={search}
        onSearchChange={change}
        keywordPlaceholder="工单号、商家或剧名"
        tabs={ticketTabs.map((tab) => ({
          key: tab,
          label:
            tab === "processing"
              ? "进行中"
              : tab === "closed"
                ? "已结束"
                : tab === "delivered_today"
                  ? "今日已交付"
                  : tab === "all"
                    ? "全部"
                    : (statusToneByEnum("delivery_ticket.step", tab)?.admin?.label ?? tab),
          count: summary.data?.tabs[tab],
        }))}
        filters={[
          ...(canPickManagers
            ? [
                {
                  key: "deliveryManagerId",
                  placeholder: "全部交付经理",
                  options: [
                    { value: "none", label: "未分配" },
                    ...(managers.data?.items.map((s) => ({ value: s.staffId, label: s.name })) ??
                      []),
                  ],
                },
              ]
            : []),
          {
            key: "productionModel",
            placeholder: "全部模型",
            options: Object.entries(models).map(([value, label]) => ({ value, label })),
          },
          {
            key: "platform",
            placeholder: "全部平台",
            options: Object.entries(platforms).map(([value, label]) => ({ value, label })),
          },
        ]}
        toolbar={
          <div className="lyx-ticket-toolbar">
            <Checkbox
              checked={search.filters.overdueOnly === "true"}
              onChange={(event) =>
                change(withFilter(search, "overdueOnly", event.target.checked ? "true" : undefined))
              }
            >
              仅看超时
            </Checkbox>
            <Select
              aria-label="工单排序"
              value={search.sort}
              onChange={(sort) => change({ ...search, sort, page: 1 })}
              options={[
                { value: "urgency", label: "优先处理" },
                { value: "-createdAt", label: "创建时间倒序" },
                { value: "stepDueAt", label: "步骤时限" },
                { value: "agreedLaunchDate", label: "约定上线日期" },
              ]}
            />
          </div>
        }
        columns={columns}
        rowKey={(row) => row.deliveryTicketId}
        rowTone={(row) => (row.urgency === "overdue" ? "danger" : undefined)}
        query={
          list.isPending || list.isPlaceholderData
            ? { status: "loading" }
            : list.isError
              ? { status: "error", message: list.error.message }
              : { status: "success", items: list.data.items, total: list.data.total }
        }
        refreshing={list.isFetching}
        onRetry={() => void list.refetch()}
        empty={{ title: "暂无工单" }}
      />
      {assigning ? (
        <Assignment
          key={assigning.deliveryTicketId}
          row={assigning}
          api={api}
          fullStaff={fullStaff}
          onClose={() => setAssigning(undefined)}
          onSuccess={refresh}
        />
      ) : null}
    </div>
  );
}
