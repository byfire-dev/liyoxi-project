import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Input, Select } from "antd";
import { useCallback, useMemo, useState } from "react";
import { showSuccessNotice } from "../../../app/feedback";
import { PageHeader } from "../../../components/PageHeader";
import { MasterDetailPage } from "../../../components/MasterDetailPage";
import { QueryTablePage } from "../../../components/QueryTablePage";
import { InfoList } from "../../../components/InfoList";
import { StatusTag } from "../../../components/StatusTag";
import { ErrorState } from "../../../components/StateBlock";
import { useCan } from "../../../lib/permissions";
import { DETAIL_QUERY, DICT_QUERY, LIST_QUERY } from "../../../lib/query";
import { MutationConfirm } from "../patrol/interaction";
import { createHealthApi, type HealthDetail } from "./health-api";
import {
  healthAbnormalBody,
  healthQuery,
  healthScope,
  healthSearch,
  HEALTH_KEY,
  writeHealthSearch,
} from "./health-model";
import "../patrol/patrol.css";
const route = getRouteApi("/publish/accounts");
export function AccountHealth() {
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate(),
    raw = route.useSearch(),
    search = healthSearch(raw),
    canMark = useCan("publish.account.mark_abnormal");
  const api = useMemo(() => createHealthApi(services), [services]),
    [mark, setMark] = useState<HealthDetail>(),
    [reason, setReason] = useState(""),
    [note, setNote] = useState("");
  const list = useQuery({
    queryKey: [...HEALTH_KEY, "list", healthQuery(search)],
    queryFn: ({ signal }) => api.list(healthQuery(search), signal),
    ...LIST_QUERY,
  });
  const summary = useQuery({
    queryKey: [...HEALTH_KEY, "summary", healthScope(search)],
    queryFn: ({ signal }) => api.summary(healthScope(search), signal),
    ...LIST_QUERY,
  });
  const id = !list.isPlaceholderData
    ? list.data?.items.some((row) => row.channelAccountId === search.id)
      ? search.id
      : list.data?.items[0]?.channelAccountId
    : undefined;
  const detail = useQuery({
    queryKey: [...HEALTH_KEY, "detail", id],
    enabled: !!id,
    queryFn: ({ signal }) => api.detail(id!, signal),
    ...DETAIL_QUERY,
  });
  const reasons = useQuery({
    queryKey: [...HEALTH_KEY, "reasons"],
    queryFn: () => api.reasons("reject_reason", "account_verify"),
    enabled: !!mark,
    ...DICT_QUERY,
  });
  const current = detail.data?.channelAccountId === id ? detail.data : undefined,
    counts = !summary.isPlaceholderData ? summary.data : undefined,
    body = healthAbnormalBody(reason, note);
  const scopeKey = JSON.stringify([
    id,
    search.q,
    search.filters.platform,
    search.filters.storeId,
    search.tab,
  ]);
  const [seenScope, setSeenScope] = useState(scopeKey);
  if (seenScope !== scopeKey) {
    setSeenScope(scopeKey);
    setMark(undefined);
  }
  const refresh = useCallback(() => {
    void services.queryClient.invalidateQueries({ queryKey: HEALTH_KEY });
  }, [services]);
  return (
    <>
      <PageHeader title="账号健康" subtitle="账号真实状态、关联作品及异常处理记录" />
      {summary.isError ? (
        <Alert
          type="warning"
          title="账号计数读取失败"
          action={<Button onClick={() => void summary.refetch()}>重试</Button>}
        />
      ) : null}
      <MasterDetailPage
        label="账号健康"
        selectedKey={id}
        onSelect={(selected) =>
          void navigate({ search: { ...raw, ...writeHealthSearch(search, selected) } })
        }
        onRetry={() => void detail.refetch()}
        detailTitle="账号与关联内容"
        list={({ onSelect }) => (
          <QueryTablePage
            label="健康账号列表"
            search={search}
            onSearchChange={(next) => {
              setMark(undefined);
              void navigate({ search: { ...raw, ...writeHealthSearch(next) } });
            }}
            tabs={[
              { key: "all", label: "全部", count: counts?.total },
              { key: "available", label: "可用", count: counts?.available },
              { key: "abnormal", label: "异常", count: counts?.abnormal },
              { key: "pending_verify", label: "待核验", count: counts?.pendingVerify },
              { key: "unbound", label: "已解绑", count: counts?.unbound },
            ]}
            keywordPlaceholder="搜索门店、账号名称"
            filters={[
              {
                key: "platform",
                placeholder: "全部平台",
                options: [
                  { value: "douyin", label: "抖音" },
                  { value: "wechat_channels", label: "视频号" },
                ],
              },
            ]}
            query={
              list.isPending || list.isPlaceholderData
                ? { status: "loading" }
                : list.isError
                  ? { status: "error", message: list.error.message }
                  : { status: "success", ...list.data }
            }
            onRetry={() => void list.refetch()}
            rowKey={(row) => row.channelAccountId}
            onRowClick={(row) => onSelect(row.channelAccountId)}
            selectedRowKey={id}
            columns={[
              {
                key: "account",
                title: "账号 / 门店",
                render: (row) => (
                  <>
                    {row.accountName}
                    <br />
                    {row.store.storeName}
                  </>
                ),
              },
              {
                key: "status",
                title: "账号状态",
                width: 100,
                render: (row) => {
                  const tone = statusToneByEnum("channel_account.status", row.status)?.admin;
                  return tone ? <StatusTag tone={tone.tone}>{tone.label}</StatusTag> : row.status;
                },
              },
              { key: "live", title: "上线中", width: 80, render: (row) => row.usage.liveCount },
            ]}
            empty={{ title: "暂无渠道账号" }}
          />
        )}
        detail={
          id
            ? detail.isError
              ? { key: id, status: "error", message: detail.error.message }
              : current
                ? {
                    key: id,
                    status: "ready",
                    content: (
                      <div className="lyx-lifecycle-details">
                        <InfoList
                          items={[
                            { label: "账号", value: current.accountName },
                            { label: "平台账号 ID", value: current.accountUid },
                            { label: "门店", value: current.store.storeName ?? "未命名门店" },
                            { label: "异常原因", value: current.abnormalReason?.name ?? "—" },
                            { label: "异常说明", value: current.abnormalNote ?? "—" },
                            { label: "待下架任务", value: String(current.openTakedownTaskCount) },
                            {
                              label: "关联内容",
                              value: `待开始 ${current.usage.pendingStartCount} · 制作中 ${current.usage.producingCount} · 待上线 ${current.usage.toLaunchCount} · 上线中 ${current.usage.liveCount}`,
                            },
                          ]}
                        />
                        <section>
                          <h3 className="lyx-section-title">在办作品</h3>
                          {current.activeDramas.length ? (
                            current.activeDramas.map((item) => (
                              <p key={item.orderItemId}>
                                {item.dramaTitle} · {item.phase}
                              </p>
                            ))
                          ) : (
                            <p>暂无在办作品</p>
                          )}
                        </section>
                        <section>
                          <h3 className="lyx-section-title">处理记录</h3>
                          {current.history.map((item, index) => (
                            <p key={index}>
                              {date.dateTime(item.at)} · {item.actorName ?? "系统"} ·{" "}
                              {item.note ?? item.kind}
                              {item.reasons.length
                                ? ` · ${item.reasons.map((reason) => reason.name).join("、")}`
                                : ""}
                            </p>
                          ))}
                        </section>
                        {canMark && current.actions.includes("mark-abnormal") ? (
                          <Button
                            danger
                            onClick={() => {
                              setReason("");
                              setNote("");
                              setMark(current);
                            }}
                          >
                            标记账号异常
                          </Button>
                        ) : null}
                      </div>
                    ),
                  }
                : { key: id, status: "loading" }
            : undefined
        }
      />
      {mark && canMark && current?.channelAccountId === mark.channelAccountId ? (
        <MutationConfirm
          title="标记账号异常"
          echo={[
            { label: "账号", value: mark.accountName },
            { label: "影响", value: "新订购与新方案不可选择；在办订单继续保留" },
          ]}
          payload={{ id: mark.channelAccountId, body }}
          valid={
            !!body &&
            current.actions.includes("mark-abnormal") &&
            !!reasons.data?.some((item) => item.code === reason)
          }
          danger
          refresh={refresh}
          onClose={() => setMark(undefined)}
          onDone={() => showSuccessNotice("已标记账号异常")}
          reconcile={() => api.detail(mark.channelAccountId)}
          send={(key, signal) =>
            body
              ? api.abnormal(mark.channelAccountId, body, key, signal)
              : Promise.reject(new Error("请填写异常原因和说明"))
          }
        >
          <label>
            账号异常原因
            <Select
              aria-label="账号异常原因"
              value={reason || undefined}
              options={reasons.data?.map((item) => ({ value: item.code, label: item.name }))}
              onChange={setReason}
            />
          </label>
          <label>
            账号异常说明
            <Input.TextArea
              aria-label="账号异常说明"
              value={note}
              maxLength={200}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          {reasons.isError ? (
            <ErrorState message={reasons.error.message} onRetry={() => void reasons.refetch()} />
          ) : null}
        </MutationConfirm>
      ) : null}
    </>
  );
}
