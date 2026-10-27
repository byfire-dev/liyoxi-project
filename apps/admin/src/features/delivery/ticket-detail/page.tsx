import { DELIVERY_TICKET_STEP } from "@liyoxi/contract/enums";
import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext, useRouterState } from "@tanstack/react-router";
import { Alert, Button, Checkbox, Modal } from "antd";
import { useMemo, useState } from "react";
import { DetailPage } from "../../../components/DetailPage";
import { InfoList } from "../../../components/InfoList";
import { EmptyState, ErrorState } from "../../../components/StateBlock";
import { StatusTag } from "../../../components/StatusTag";
import { Can } from "../../../lib/permissions";
import { DETAIL_QUERY } from "../../../lib/query";
import { TICKETS_KEY } from "../tickets/model";
import { ORDERS_KEY } from "../../order/orders/model";
import { createTicketDetailApi } from "./api";
import { DETAIL_KEY, historyTicketId } from "./model";
import { PlanDrawer } from "./plan";
import { SamplePanel, EpisodePanel } from "./panels";
import { useDeliveryWrite } from "./write";
import "./production.css";
const route = getRouteApi("/delivery/tickets/$ticketNo");
export function TicketDetailPage() {
  const { services } = useRouteContext({ from: "__root__" }),
    { ticketNo } = route.useParams(),
    navigate = route.useNavigate(),
    search = route.useSearch();
  const api = useMemo(() => createTicketDetailApi(services), [services]);
  const state = useRouterState({ select: (router) => router.location.state });
  const navigation =
    typeof window === "undefined"
      ? undefined
      : window.performance.getEntriesByType("navigation")[0];
  const reloaded = navigation !== undefined && "type" in navigation && navigation.type === "reload";
  const navigationId = reloaded ? undefined : historyTicketId(state, ticketNo);
  const detail = useQuery({
    queryKey: [...DETAIL_KEY, ticketNo],
    queryFn: async () => {
      const id =
        navigationId ??
        (await api.find(ticketNo)).items.find((r) => r.ticketNo === ticketNo)?.deliveryTicketId;
      if (!id) return null;
      const data = await api.get(id);
      return data.ticketNo === ticketNo ? data : null;
    },
    ...DETAIL_QUERY,
  });
  const data = detail.data;
  const plan = useQuery({
    queryKey: [...DETAIL_KEY, "plan", data?.plan?.deliveryPlanId],
    queryFn: () => api.plan(data!.plan!.deliveryPlanId),
    enabled: !!data?.plan,
    ...DETAIL_QUERY,
  });
  const [editing, setEditing] = useState(false),
    [pushing, setPushing] = useState(false),
    [checked, setChecked] = useState(false);
  const refresh = () => {
    void services.queryClient.invalidateQueries({ queryKey: DETAIL_KEY });
    void services.queryClient.invalidateQueries({ queryKey: TICKETS_KEY });
    void services.queryClient.invalidateQueries({ queryKey: ORDERS_KEY });
  };
  const write = useDeliveryWrite(() => {
    refresh();
    setPushing(false);
    setChecked(false);
  });
  if (detail.isError)
    return <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />;
  if (!detail.isPending && !data)
    return <EmptyState title="没有找到这张工单" description="请核对工单号，或回到工单池" />;
  const tone = data ? statusToneByEnum("delivery_ticket.step", data.step)?.admin : undefined;
  return (
    <div className="lyx-production">
      <DetailPage
        title={`工单 ${ticketNo}`}
        subtitle={
          data
            ? `${data.store.storeName ?? "未命名门店"} · ${data.dramaTitle} · 整部 ${data.episodeCount} 集`
            : undefined
        }
        tags={tone ? <StatusTag tone={tone.tone}>{tone.label}</StatusTag> : undefined}
        state={detail.isPending ? { status: "loading" } : { status: "ready" }}
        onRetry={() => void detail.refetch()}
        activeTab={search.tab}
        onTabChange={(tab) => void navigate({ search: { tab } })}
        actions={
          <Button onClick={() => void navigate({ to: "/delivery/tickets" })}>返回工单池</Button>
        }
        progress={
          data ? (
            <section className="lyx-card lyx-production-steps" aria-label="工单步骤">
              {DELIVERY_TICKET_STEP.values
                .filter((s) => !["archived", "terminated"].includes(s))
                .map((step) => (
                  <div key={step} aria-current={data.step === step ? "step" : undefined}>
                    <span>
                      {statusToneByEnum("delivery_ticket.step", step)?.admin?.label ?? step}
                    </span>
                    <small>
                      {data.stages.some((r) => r.step === step && r.completedAt)
                        ? "已完成"
                        : data.step === step
                          ? "当前步骤"
                          : "待处理"}
                    </small>
                  </div>
                ))}
            </section>
          ) : undefined
        }
        tabs={[
          {
            key: "plan",
            label: "交付方案",
            content: (
              <div className="lyx-production-sections">
                {plan.isPending && !!data?.plan ? (
                  <p>正在读取方案…</p>
                ) : plan.isError ? (
                  <ErrorState message={plan.error.message} onRetry={() => void plan.refetch()} />
                ) : plan.data ? (
                  <>
                    <InfoList
                      items={[
                        {
                          label: "定制重点",
                          value: plan.data.draft.focus.map((r) => r.name).join("、") || "尚未配置",
                        },
                        { label: "补充说明", value: plan.data.draft.note ?? "—" },
                        { label: "上线方式", value: "商家自助发布" },
                        {
                          label: "推送情况",
                          value:
                            plan.data.currentVersionNo > 0
                              ? `已推送第 ${plan.data.currentVersionNo} 版`
                              : "尚未推送",
                        },
                        {
                          label: "确认情况",
                          value:
                            plan.data.status === "pending_confirm"
                              ? "等待商家确认"
                              : plan.data.status === "revising"
                                ? "商家要求修改，请调整方案后重新推送"
                                : plan.data.confirmedVersionNo === null
                                  ? "尚未确认"
                                  : `已确认第 ${plan.data.confirmedVersionNo} 版`,
                        },
                        {
                          label: "最近推送",
                          value: plan.data.pushedAt ? date.dateTimeFull(plan.data.pushedAt) : "—",
                        },
                        { label: "广告位", value: "暂无" },
                      ]}
                    />
                    {plan.data.draft.items.map((r) => (
                      <section className="lyx-production-card" key={r.orderItemId}>
                        <h3>
                          {r.dramaTitle} · {r.episodeCount} 集
                        </h3>
                        <InfoList
                          items={[
                            {
                              label: "发布账号",
                              value: r.accounts.map((a) => a.accountName).join("、") || "尚未配置",
                            },
                            {
                              label: "约定上线",
                              value: r.agreedLaunchDate ? date.date(r.agreedLaunchDate) : "待确认",
                            },
                            {
                              label: "预计交付",
                              value: r.expectedDeliveryDate
                                ? date.date(r.expectedDeliveryDate)
                                : "待确认",
                            },
                          ]}
                        />
                      </section>
                    ))}
                    <div className="lyx-production-actions">
                      {plan.data.actions.includes("draft-replace") ? (
                        <Can module="delivery" need="o" action="delivery.plan.edit">
                          <Button onClick={() => setEditing(true)}>配置方案</Button>
                        </Can>
                      ) : null}
                      {plan.data.actions.includes("push") ? (
                        <Can module="delivery" need="o" action="delivery.plan.push">
                          <Button
                            type="primary"
                            onClick={() => {
                              setChecked(false);
                              write.setError(undefined);
                              setPushing(true);
                            }}
                          >
                            推送方案
                          </Button>
                        </Can>
                      ) : null}
                    </div>
                  </>
                ) : (
                  <p>尚未生成交付方案</p>
                )}
              </div>
            ),
          },
          { key: "ads", label: "广告视频", content: <EmptyState title="暂无" /> },
          {
            key: "sample",
            label: "样片与质检",
            content: data ? <SamplePanel ticket={data} api={api} onRefresh={refresh} /> : null,
          },
          {
            key: "episodes",
            label: "成片与发布",
            content: data ? <EpisodePanel ticket={data} api={api} onRefresh={refresh} /> : null,
          },
        ]}
        aside={
          data
            ? [
                {
                  key: "merchant",
                  title: "商家与负责人",
                  content: (
                    <InfoList
                      items={[
                        { label: "门店", value: data.store.storeName ?? "—" },
                        {
                          label: "联系人",
                          value: `${data.merchant.contactName ?? "—"} ${data.merchant.contactPhoneMask ?? ""}`,
                        },
                        { label: "交付经理", value: data.deliveryManager?.name ?? "未分配" },
                        { label: "剪辑", value: data.editor?.name ?? "未分配" },
                        { label: "发布", value: data.publisher?.name ?? "未分配" },
                      ]}
                      labelWidth={84}
                    />
                  ),
                },
                {
                  key: "order",
                  title: "所属订购单",
                  content: (
                    <InfoList
                      items={[
                        { label: "单号", value: data.order.orderNo },
                        { label: "订购时间", value: date.dateTime(data.order.submittedAt) },
                        {
                          label: "积分",
                          value: data.order.totalChargePoints.toLocaleString("zh-CN"),
                        },
                        {
                          label: "同单工单",
                          value: data.order.siblings.map((s) => s.ticketNo).join("、") || "—",
                        },
                      ]}
                      labelWidth={84}
                    />
                  ),
                },
                {
                  key: "due",
                  title: "交付时限",
                  content: (
                    <InfoList
                      items={[
                        {
                          label: "步骤截止",
                          value: data.stepDueAt ? date.dateTime(data.stepDueAt) : "—",
                        },
                        { label: "交付目标", value: date.dateTime(data.deliveryTargetAt) },
                        { label: "使用期至", value: date.date(data.usageEndDate) },
                      ]}
                      labelWidth={84}
                    />
                  ),
                },
              ]
            : []
        }
      />
      {editing && plan.data ? (
        <PlanDrawer
          key={plan.data.deliveryPlanId}
          plan={plan.data}
          api={api}
          onClose={() => setEditing(false)}
          onRefresh={refresh}
        />
      ) : null}
      {pushing && plan.data ? (
        <Modal
          open
          title="推送交付方案"
          footer={null}
          onCancel={() => {
            if (!write.pending) setPushing(false);
          }}
          closable={!write.pending}
          keyboard={!write.pending}
          mask={{ closable: !write.pending }}
        >
          <div className="lyx-production-form">
            <p>
              {data?.store.storeName ?? "未命名门店"} · {plan.data.orderNo} · 待推送草稿
            </p>
            <Checkbox
              checked={checked}
              disabled={write.pending}
              onChange={(e) => setChecked(e.target.checked)}
            >
              我已核对方案与发布账号
            </Checkbox>
            {write.error ? <Alert type="error" title={write.error} /> : null}
            <div className="lyx-production-footer">
              <Button disabled={write.pending} onClick={() => setPushing(false)}>
                取消
              </Button>
              <Button
                type="primary"
                disabled={!checked}
                loading={write.pending}
                onClick={() => {
                  const p = plan.data!;
                  void write.submit(
                    { id: p.deliveryPlanId, draftLockVersion: p.draftLockVersion },
                    (key) => api.pushPlan(p.deliveryPlanId, p.draftLockVersion, key),
                  );
                }}
              >
                确认推送
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
