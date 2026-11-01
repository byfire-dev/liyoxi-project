import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Checkbox, Select, Space, Spin } from "antd";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { showSuccessNotice } from "../../../app/feedback";
import type { AppServices } from "../../../app/services";
import { PageHeader } from "../../../components/PageHeader";
import { QueueWorkbench } from "../../../components/QueueWorkbench";
import { ErrorState } from "../../../components/StateBlock";
import { StatusTag } from "../../../components/StatusTag";
import { AccessContext } from "../../../lib/permissions";
import { DETAIL_QUERY, QUEUE_QUERY } from "../../../lib/query";
import { currentKey } from "../../../lib/queue";
import { AdActionModal, labels } from "./actions";
import { createAdTasksApi, type AdDetail, type AdVersion, type Command } from "./api";
import { ADS_KEY, adSearch } from "./model";
import "./style.css";
const route = getRouteApi("/delivery/ad-tasks");
const names: Record<string, string> = {
  todo: "待处理",
  pending_confirm: "待商家确认",
  confirmed: "已确认",
  returned: "已退回",
  cancelled: "已取消",
  all: "全部",
};
function State({ status }: { status: string }) {
  const tone = statusToneByEnum("ad.status", status)?.admin;
  return tone ? <StatusTag tone={tone.tone}>{tone.label}</StatusTag> : <span>{status}</span>;
}
function Facts({
  detail: d,
  api,
  services,
  scope,
  onRefresh,
}: {
  detail: AdDetail;
  api: ReturnType<typeof createAdTasksApi>;
  services: AppServices;
  scope: string;
  onRefresh(): void;
}) {
  const [action, setAction] = useState<{
      kind: Command["kind"];
      version?: AdVersion;
      detail: AdDetail;
    }>(),
    [error, setError] = useState<string>();
  // Facts is keyed by scope + adId; each mounted owner cancels all preview reads on exit.
  const previewController = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const owner = new AbortController();
    previewController.current = owner;
    return () => {
      owner.abort();
      if (previewController.current === owner) previewController.current = undefined;
    };
  }, []);
  const preview = async (version: AdVersion) => {
    const owner = previewController.current;
    if (!owner || owner.signal.aborted) return;
    try {
      const url = await api.previewUrl(d.adId, version.adVersionId, owner.signal);
      if (!owner.signal.aborted) window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      if (!owner.signal.aborted) setError("预览暂不可用，请刷新后重试");
    }
  };
  return (
    <div className="lyx-ad-detail">
      <Space wrap>
        {(["assign", "return", "create-version", "request-change", "remind", "cancel"] as const)
          .filter((kind) => d.actions.includes(kind))
          .map((kind) => (
            <Button key={kind} onClick={() => setAction({ kind, detail: d })}>
              {labels[kind]}
            </Button>
          ))}
      </Space>
      {d.openCancelRequest ? (
        <Alert
          type="warning"
          title={`取消申请 ${d.openCancelRequest.requestNo}：${d.openCancelRequest.status}，申请退回${d.openCancelRequest.totalRefundPoints}积分；尚不表示已执行`}
        />
      ) : null}
      {error ? <Alert type="error" title={error} /> : null}
      <section>
        <h3>制作需求</h3>
        <dl className="lyx-ad-facts">
          <dt>广告</dt>
          <dd>
            {d.adNo} ·{" "}
            {d.type === "opening" ? "片头" : d.type === "ending" ? "片尾" : String(d.type)} ·{" "}
            {d.durationSec}秒
          </dd>
          <dt>状态</dt>
          <dd>
            <State status={String(d.status)} />
            {d.isWaitingQualification ? " · 等待资质通过" : ""}
          </dd>
          <dt>剪辑师</dt>
          <dd>{d.editor?.name ?? "待指派"}</dd>
          <dt>预计完成</dt>
          <dd>{d.dueAt ? date.dateTime(d.dueAt) : "暂无"}</dd>
          <dt>宣传重点</dt>
          <dd>{d.promoPoints.map((p) => p.name).join("、") || "暂无"}</dd>
          <dt>文案</dt>
          <dd>{d.copy ?? "暂无"}</dd>
          <dt>补充说明</dt>
          <dd>{d.remark ?? "暂无"}</dd>
          <dt>退回原因</dt>
          <dd>
            {d.returnReason ?? "暂无"} · 重新提交{d.resubmitCount}次
          </dd>
          <dt>积分</dt>
          <dd>
            {d.chargePoints}积分；冻结单状态：
            {statusToneByEnum("point_hold.status", d.pointHold.status)?.admin?.label ??
              d.pointHold.status}
            {d.capturedAt ? ` · ${date.dateTime(d.capturedAt)}扣减` : ""}
          </dd>
          <dt>修改</dt>
          <dd>
            已修改{d.revisionCount}次 / 免费额度{d.freeRevisionQuota}次
          </dd>
          <dt>实际退积分</dt>
          <dd>
            退回{d.refunds.returnedPoints}，转加购{d.refunds.convertedPoints}，失效
            {d.refunds.forfeitedPoints}
          </dd>
          <dt>协议</dt>
          <dd>
            {d.agreement.versionLabel} · {date.dateTime(d.agreement.consentedAt)} ·{" "}
            {d.agreement.method}
          </dd>
        </dl>
      </section>
      <section>
        <h3>参考素材</h3>
        {d.referenceFiles.length ? (
          <ul>
            {d.referenceFiles.map((r) => (
              <li key={r.fileId}>
                {r.title ?? r.fileId} · {r.type} · {r.usability ?? "未提供可用性"}
              </li>
            ))}
          </ul>
        ) : (
          <p>暂无参考素材</p>
        )}
      </section>
      <section>
        <h3>版本与查看证据</h3>
        {d.versions.length ? (
          d.versions.map((v) => (
            <article className="lyx-ad-version" key={v.adVersionId}>
              <h4>
                第{v.versionNo}版 · {String(v.decision ?? "待决定")}
              </h4>
              <p>
                {v.width}×{v.height} · {v.durationMs}毫秒 · {v.uploadedBy.name} ·{" "}
                {date.dateTime(v.uploadedAt)}
              </p>
              <p>
                生产检查：
                {v.production
                  ? `${v.production.pipelineState} / ${v.production.gate ?? "未给出结论"}，提示${v.production.softWarnCount}项`
                  : "暂无已验证检查结果"}
              </p>
              <p>
                推送：{v.pushedAt ? date.dateTime(v.pushedAt) : "未推送"} · 查看渠道：
                {v.previewChannels.join("、") || "暂无"}
              </p>
              <p>
                企业微信发送登记：
                {v.offlineSentAt
                  ? `${date.dateTime(v.offlineSentAt)} · ${v.offlineSentBy?.name ?? "员工"}`
                  : "未登记"}
              </p>
              <p>
                商家查看确认：
                {v.viewedAckAt
                  ? `${date.dateTime(v.viewedAckAt)} · ${v.viewedVia ?? "未提供渠道"}`
                  : "暂无确认记录"}
                ；决定：{v.decidedAt ? date.dateTime(v.decidedAt) : "暂无"}
              </p>
              <Space wrap>
                <Button onClick={() => void preview(v)}>刷新并预览第{v.versionNo}版</Button>
                {(["mark-sent", "push"] as const)
                  .filter((kind) => v.actions.includes(kind))
                  .map((kind) => (
                    <Button key={kind} onClick={() => setAction({ kind, version: v, detail: d })}>
                      {labels[kind]}
                    </Button>
                  ))}
              </Space>
            </article>
          ))
        ) : (
          <p>暂无登记版本</p>
        )}
      </section>
      <section>
        <h3>修改历史</h3>
        {d.revisions.length ? (
          d.revisions.map((r) => (
            <article key={r.adRevisionId}>
              <p>
                第{r.revisionNo}次 · 基于第{r.onVersionNo}版 · {String(r.source)} ·{" "}
                {r.isChargeable ? `${r.chargePoints}积分` : "免费"}
              </p>
              <p>{r.note}</p>
              <p>
                {r.actorName ?? String(r.actorType)} · {date.dateTime(r.createdAt)} · 预计
                {date.dateTime(r.dueAt)}
                {r.fulfilledByVersionNo ? ` · 已由第${r.fulfilledByVersionNo}版完成` : " · 待完成"}
              </p>
            </article>
          ))
        ) : (
          <p>暂无修改记录</p>
        )}
      </section>
      <section>
        <h3>关联订单与工单</h3>
        {d.usages.length ? (
          d.usages.map((u, i) => (
            <p key={`${u.orderItemId}:${u.slot}:${i}`}>
              {u.orderNo} · {u.dramaTitle} · {u.ticketNo ?? "暂无工单"} ·{" "}
              {u.boundVersionNo ? `固定第${u.boundVersionNo}版` : "随当前确认版"} · {u.phase}
            </p>
          ))
        ) : (
          <p>暂无引用</p>
        )}
      </section>
      <section>
        <h3>取消申请</h3>
        {d.cancelRequests.length ? (
          d.cancelRequests.map((r) => (
            <p key={r.cancelRequestId}>
              {r.requestNo} · {r.status} · 申请退回{r.totalRefundPoints}积分
            </p>
          ))
        ) : (
          <p>暂无取消申请</p>
        )}
        <p>审批执行结果以已交付的审批处理入口为准。</p>
      </section>
      <section>
        <h3>最近活动</h3>
        {d.recentActivities.length ? (
          d.recentActivities.map((r, i) => (
            <p key={i}>
              {date.dateTime(r.occurredAt)} · {r.action}
              {r.reasonText ? ` · ${r.reasonText}` : ""}
            </p>
          ))
        ) : (
          <p>暂无活动</p>
        )}
      </section>
      {action ? (
        <AdActionModal
          key={`${d.adId}:${action.kind}:${action.version?.adVersionId ?? "ad"}`}
          {...action}
          api={api}
          services={services}
          scope={scope}
          onClose={() => setAction(undefined)}
          onDone={() => {
            onRefresh();
            showSuccessNotice("已刷新广告事实，请核对当前结果");
          }}
        />
      ) : null}
    </div>
  );
}
export function AdTasksPage() {
  const { services } = useRouteContext({ from: "__root__" }),
    navigate = route.useNavigate(),
    search = adSearch(route.useSearch()),
    access = useContext(AccessContext);
  const scope = `${access?.staff.id}:${access?.dataScope}:${access?.moduleLevels.delivery}:${access?.actions.join(",")}`;
  const api = useMemo(() => createAdTasksApi(services), [services]);
  const filters = { q: search.q, type: search.type, overdueOnly: search.overdueOnly };
  const list = useInfiniteQuery({
    queryKey: [...ADS_KEY, scope, "list", search.tab, filters],
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      api.list({ ...filters, tab: search.tab, page: pageParam, pageSize: 50, sort: "urgency" }),
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
    ...QUEUE_QUERY,
  });
  const summary = useQuery({
    queryKey: [...ADS_KEY, scope, "summary", filters],
    queryFn: () => api.summary(filters),
    ...QUEUE_QUERY,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [],
    id = currentKey(
      items.map((r) => r.adId),
      search.id,
    );
  const detail = useQuery({
    queryKey: [...ADS_KEY, scope, "detail", id],
    enabled: !!id && !list.isPlaceholderData,
    queryFn: () => api.get(id!),
    ...DETAIL_QUERY,
  });
  const current = !list.isPlaceholderData && detail.data?.adId === id ? detail.data : undefined;
  const refresh = () => {
    void services.queryClient.invalidateQueries({ queryKey: ADS_KEY });
  };
  const change = (next: typeof search) => void navigate({ search: next });
  return (
    <div className="lyx-ad-page">
      <PageHeader
        title="广告制作任务"
        subtitle="按真实制作状态和时限处理；企业微信发送须另行完成"
        extra={
          list.hasNextPage ? (
            <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              加载更多广告
            </Button>
          ) : undefined
        }
      />
      <Space className="lyx-ad-filters">
        <Select
          aria-label="广告类型"
          value={search.type ?? "all"}
          options={[
            { value: "all", label: "全部类型" },
            { value: "opening", label: "片头" },
            { value: "ending", label: "片尾" },
          ]}
          onChange={(type) =>
            change({
              ...search,
              id: undefined,
              type: type === "opening" || type === "ending" ? type : undefined,
            })
          }
        />
        <Checkbox
          checked={search.overdueOnly ?? false}
          onChange={(e) =>
            change({ ...search, id: undefined, overdueOnly: e.target.checked || undefined })
          }
        >
          仅超时
        </Checkbox>
      </Space>
      {summary.isError ? (
        <Alert
          type="warning"
          title="页签计数读取失败"
          action={<Button onClick={() => void summary.refetch()}>重试</Button>}
        />
      ) : null}
      <QueueWorkbench
        key={scope}
        label="广告制作任务"
        tabs={Object.entries(names).map(([key, label]) => ({
          key,
          label,
          count:
            key !== "all" && summary.data
              ? summary.data.tabs[key as keyof typeof summary.data.tabs]
              : undefined,
        }))}
        search={search}
        onSearchChange={(next) => change(adSearch({ ...search, ...next }))}
        searchPlaceholder="搜索广告或门店"
        queue={
          list.isPending || list.isPlaceholderData
            ? { status: "loading" }
            : list.isError
              ? { status: "error", message: "广告队列读取失败，请重试" }
              : { status: "success", items }
        }
        onRetry={() => void list.refetch()}
        onQueueChanged={refresh}
        notifySuccess={showSuccessNotice}
        itemKey={(r) => r.adId}
        renderItem={(r) => ({
          title: `${r.adNo} · ${r.store.storeName ?? "未命名门店"}`,
          line: `${r.durationSec}秒 · ${r.editor?.name ?? "待指派"}`,
          meta: `${r.urgency === "overdue" ? "已超时 · " : r.urgency === "due_today" ? "今日到期 · " : ""}${r.dueAt ? date.dateTime(r.dueAt) : "暂无预计时间"}`,
          tag: <State status={String(r.status)} />,
        })}
        detailHeader={(r) => ({ title: r.adNo, description: r.store.storeName ?? "未命名门店" })}
        detail={() =>
          detail.isError ? (
            <ErrorState
              message="详情读取失败，请核对当前范围"
              onRetry={() => void detail.refetch()}
            />
          ) : current ? (
            <Facts
              key={`${scope}:${current.adId}`}
              detail={current}
              api={api}
              services={services}
              scope={scope}
              onRefresh={refresh}
            />
          ) : (
            <Spin />
          )
        }
        actions={[]}
        empty={{ title: "暂无广告任务" }}
      />
    </div>
  );
}
