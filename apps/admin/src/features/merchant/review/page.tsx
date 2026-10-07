import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, useRouteContext } from "@tanstack/react-router";
import { Button, Spin } from "antd";
import { useRef, useState } from "react";

import { showApiNotice, showSuccessNotice } from "../../../app/feedback";
import { PageHeader } from "../../../components/PageHeader";
import { QueueWorkbench, type QueueActionResult } from "../../../components/QueueWorkbench";
import { ErrorState } from "../../../components/StateBlock";
import { StatusTag } from "../../../components/StatusTag";
import { readFailure } from "../../../lib/api-errors";
import { useCan } from "../../../lib/permissions";
import { DETAIL_QUERY, DICT_QUERY, QUEUE_QUERY } from "../../../lib/query";
import { currentKey, writeQueueSearch } from "../../../lib/queue";
import { ReviewDetails } from "./details";
import {
  approveBody,
  createDecisionIntent,
  decisionResult,
  reviewSearch,
  reviewListQuery,
  REVIEW_KEY,
  type Approval,
  type Detail,
  type RejectBody,
  type ReviewList,
  type ReviewSummary,
  type Reason,
} from "./model";
import { RejectDialog } from "./reject";
import "./review.css";

const route = getRouteApi("/merchants/review");
type Rejection = { detail: Detail; resolve: (result: QueueActionResult) => void };

export function QualificationReviewPage() {
  const { services } = useRouteContext({ from: "__root__" });
  const search = reviewSearch(route.useSearch()),
    navigate = route.useNavigate();
  const [intent] = useState(createDecisionIntent);
  const rejectionBusy = useRef(false);
  const [rejection, setRejection] = useState<Rejection>(),
    [rejecting, setRejecting] = useState(false),
    [rejectError, setRejectError] = useState<string>();
  const canReview = useCan("merchant.qualification.review");
  const client = services.api.client;
  const query = {
    kind: "qualification",
    tab: search.tab as "todo" | "done_today",
    ...(search.q ? { q: search.q } : {}),
  };
  const list = useInfiniteQuery<ReviewList>({
    queryKey: [...REVIEW_KEY, "list", query],
    initialPageParam: 1,
    queryFn: async ({ pageParam }) => {
      const { data, response } = await client.GET("/api/v1/admin/approvals", {
        params: {
          query: reviewListQuery(search, typeof pageParam === "number" ? pageParam : 1),
        },
      });
      if (!data) throw new Error((await readFailure(response)).message);
      return data.data;
    },
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
    ...QUEUE_QUERY,
  });
  const summary = useQuery<ReviewSummary | undefined>({
    queryKey: [...REVIEW_KEY, "summary", search.q],
    queryFn: async () => {
      const { data, response } = await client.GET("/api/v1/admin/approvals/summary", {
        params: { query: { kind: "qualification", ...(search.q ? { q: search.q } : {}) } },
      });
      if (!data) throw new Error((await readFailure(response)).message);
      return data.data.items.find((item) => item.kind === "qualification");
    },
    ...QUEUE_QUERY,
  });
  const reasons = useQuery<Reason[]>({
    queryKey: [...REVIEW_KEY, "reasons"],
    queryFn: async () => {
      const { data, response } = await client.GET("/api/v1/admin/dict-items", {
        params: { query: { typeKey: "reject_reason", scene: "store_review" } },
      });
      if (!data) throw new Error((await readFailure(response)).message);
      return data.data.items;
    },
    ...DICT_QUERY,
  });
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const selected = items.find(
    (item) =>
      item.approvalId ===
      currentKey(
        items.map((item) => item.approvalId),
        search.id,
      ),
  );
  const id = selected?.domain.id;
  const detail = useQuery<Detail>({
    queryKey: [...REVIEW_KEY, "detail", id],
    enabled: Boolean(id) && !list.isPlaceholderData,
    queryFn: async () => {
      const { data, response } = await client.GET(
        "/api/v1/admin/qualification-submissions/{qualificationSubmissionId}",
        { params: { path: { qualificationSubmissionId: id! } } },
      );
      if (!data) throw new Error((await readFailure(response)).message);
      return data.data;
    },
    ...DETAIL_QUERY,
  });
  const current =
    detail.data?.qualificationSubmissionId === id && !list.isPlaceholderData
      ? detail.data
      : undefined;
  const invalidate = () => {
    void services.queryClient.invalidateQueries({ queryKey: REVIEW_KEY });
  };
  const send = async (d: Detail, body: RejectBody) => {
    const result = await intent({ id: d.qualificationSubmissionId, body }, async (key) => {
      const { data, response } = await client.POST(
        "/api/v1/admin/qualification-submissions/{qualificationSubmissionId}/reject",
        {
          params: {
            path: { qualificationSubmissionId: d.qualificationSubmissionId },
          },
          body,
          headers: { "Idempotency-Key": key },
        },
      );
      if (data)
        return {
          outcome: "done",
          message: `${d.store.name ?? "门店"}：已驳回，请商家补正资料`,
        } as const;
      const error = await readFailure(response);
      return error.body
        ? decisionResult(error.body)
        : ({ outcome: "failed", message: error.message } as const);
    });
    return result;
  };
  const tone = (item: Approval) => statusToneByEnum("approval_request.status", item.status)?.admin;
  return (
    <>
      <PageHeader
        title="资质审核"
        subtitle="按提交时限处理，人工核对证照与门店资料"
        extra={
          list.hasNextPage ? (
            <Button loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              加载更多事项
            </Button>
          ) : undefined
        }
      />
      <QueueWorkbench<Approval>
        label="资质审核"
        tabs={[
          { key: "todo", label: "待审核", count: summary.data?.todo },
          { key: "done_today", label: "今日已审核", count: summary.data?.doneToday },
        ]}
        search={search}
        onSearchChange={(next) => void navigate({ search: writeQueueSearch(next) })}
        searchPlaceholder="门店名称"
        queue={
          list.status === "pending" || list.isPlaceholderData
            ? { status: "loading" }
            : list.status === "error"
              ? { status: "error", message: list.error.message }
              : { status: "success", items }
        }
        onRetry={() => void list.refetch()}
        onQueueChanged={invalidate}
        notifySuccess={showSuccessNotice}
        itemKey={(item) => item.approvalId}
        renderItem={(item) => ({
          title: item.summary.title,
          line:
            item.summary.lines?.map((line) => `${line.label}：${line.value}`).join(" · ") ||
            "资质资料待核对",
          meta: `${appDateTimeFormat.dateTime(item.submittedAt)} 提交${item.dueAt ? ` · ${appDateTimeFormat.dateTime(item.dueAt)} 截止` : ""}`,
          tag: tone(item) ? (
            <StatusTag tone={tone(item)!.tone}>{tone(item)!.label}</StatusTag>
          ) : (
            "未知状态"
          ),
        })}
        detailHeader={(item) => ({
          title: current?.store.name ?? item.summary.title,
          description: current
            ? `第 ${current.roundNo} 轮 · ${current.isResubmit ? "补正后重新提交" : "首次提交"}`
            : undefined,
        })}
        detail={() =>
          detail.status === "error" ? (
            <ErrorState message={detail.error.message} onRetry={() => void detail.refetch()} />
          ) : current ? (
            <ReviewDetails
              key={current.qualificationSubmissionId}
              services={services}
              detail={current}
            />
          ) : (
            <Spin />
          )
        }
        checklist={
          current?.confirmChecks.length
            ? { items: current.confirmChecks.map((code) => ({ key: code, label: code })) }
            : undefined
        }
        actions={
          current && canReview
            ? [
                {
                  key: "reject",
                  label: "驳回",
                  kind: "reject",
                  hidden: !current.actions.includes("reject"),
                  run: () =>
                    new Promise((resolve) => {
                      setRejectError(undefined);
                      setRejection({ detail: current, resolve });
                    }),
                },
                {
                  key: "approve",
                  label: "审核通过",
                  kind: "primary",
                  needsChecklist: true,
                  hidden: !current.actions.includes("approve"),
                  run: async ({ checked }) => {
                    const d = current,
                      body = approveBody(d, checked);
                    const result = await intent(
                      { id: d.qualificationSubmissionId, body },
                      async (key) => {
                        const { data, response } = await client.POST(
                          "/api/v1/admin/qualification-submissions/{qualificationSubmissionId}/approve",
                          {
                            params: {
                              path: { qualificationSubmissionId: d.qualificationSubmissionId },
                            },
                            body,
                            headers: { "Idempotency-Key": key },
                          },
                        );
                        if (data)
                          return {
                            outcome: "done",
                            message: `${d.store.name ?? "门店"}：资质审核已通过`,
                          } as const;
                        const failure = await readFailure(response);
                        return failure.body
                          ? decisionResult(failure.body)
                          : ({ outcome: "failed", message: failure.message } as const);
                      },
                    );
                    if (result?.outcome === "conflict")
                      showApiNotice({
                        symbol: "REVIEW_CHANGED",
                        message: "这条资质已被处理或资料已更新，队列已刷新",
                        requestIdTail: null,
                      });
                    return result ?? { outcome: "failed", message: "正在提交，请稍候" };
                  },
                },
              ]
            : []
        }
        readOnlyHint={!canReview ? "当前权限只能查看" : !current ? "正在读取当前资料" : undefined}
        settled={(item) =>
          item.status === "approved" || item.status === "rejected"
            ? {
                tone: item.status === "rejected" ? "danger" : "success",
                message: `${tone(item)?.label ?? "已处理"}${item.decidedBy ? `（${item.decidedBy.name}）` : ""}`,
              }
            : undefined
        }
        empty={{
          title: search.tab === "done_today" ? "暂无今日已审核资质" : "暂无待审核资质",
          description: search.tab === "done_today" ? "今天还没有审核记录" : "当前队列已处理完毕",
        }}
      />
      {rejection ? (
        <RejectDialog
          key={rejection.detail.qualificationSubmissionId}
          detail={rejection.detail}
          reasons={reasons.data ?? []}
          pending={rejecting}
          error={rejectError ?? (reasons.error ? "驳回原因没有加载成功，请刷新页面" : undefined)}
          onCancel={() => {
            if (!rejecting) {
              rejection.resolve({ outcome: "failed", message: "未提交驳回" });
              setRejection(undefined);
            }
          }}
          onSubmit={(body) => {
            if (rejectionBusy.current) return;
            rejectionBusy.current = true;
            setRejecting(true);
            setRejectError(undefined);
            void send(rejection.detail, body)
              .then((result) => {
                if (!result) return;
                if (result.outcome === "failed") setRejectError(result.message);
                else {
                  if (result.outcome === "conflict")
                    showApiNotice({
                      symbol: "REVIEW_CHANGED",
                      message: "这条资质已被处理，队列已刷新",
                      requestIdTail: null,
                    });
                  rejection.resolve(result);
                  setRejection(undefined);
                }
              })
              .catch(() => setRejectError("驳回没有提交成功，请重试"))
              .finally(() => {
                rejectionBusy.current = false;
                setRejecting(false);
              });
          }}
        />
      ) : null}
    </>
  );
}
