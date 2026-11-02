import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Alert, Button, Select, Spin } from "antd";
import { useState } from "react";
import { useCan } from "../../../lib/permissions";
import { CancelRequestPanel } from "../../approval/cancel-panel";
import { aftercareError, type OrderAftercareApi } from "./aftercare-api";
import type { OrderDetail } from "./api";
import { OrderCancelForm } from "./cancel-form";
import { OrderLicenses } from "./license-section";

const cancelStatuses: Readonly<Record<string, string>> = {
  pending_approval: "待审批",
  pending_execution: "待执行（尚未退回）",
  done: "已执行",
  not_executed: "已关闭未执行",
};
const grantStates: Readonly<Record<string, string>> = {
  active: "可用",
  revoked: "已撤销",
  expired: "已过期",
};
const downloadKinds: Readonly<Record<string, string>> = {
  episode: "单集成片",
  zip: "成片包",
  publish_list: "发布清单",
};
const downloadClients: Readonly<Record<string, string>> = {
  weapp: "小程序",
  portal: "电脑下载页",
  admin: "运营后台",
};
const releaseStates = { pushed: "已推送", superseded: "已被新版替代", closed: "已关闭" } as const;
const variants = { common: "通用版", douyin: "抖音版", wechat_channels: "视频号版" } as const;
export function OrderAftercare({
  order,
  api,
  onChanged,
}: {
  order: OrderDetail;
  api: OrderAftercareApi;
  onChanged(): void;
}) {
  const canRequest = useCan("order.refund.request");
  const [creating, setCreating] = useState(false),
    [selected, setSelected] = useState<string>();
  const current = order.cancelRequests.find((row) => row.cancelRequestId === selected);
  return (
    <section className="lyx-order-sections" aria-label="订单售后与取消">
      <div>
        <h2 className="lyx-section-title">取消与退积分</h2>
        <p>先试算并发起申请，审批通过后由有权员工执行；提交申请不会立即退回积分。</p>
        {canRequest ? (
          <Button type="primary" onClick={() => setCreating(true)}>
            发起取消申请
          </Button>
        ) : (
          <p>当前权限仅可查看取消进度</p>
        )}
      </div>
      {!order.cancelRequests.length ? (
        <p>暂无取消申请</p>
      ) : (
        <>
          <Select
            aria-label="选择取消申请"
            value={current?.cancelRequestId}
            placeholder="选择申请查看实际进度"
            options={order.cancelRequests.map((row) => ({
              value: row.cancelRequestId,
              label: `${row.requestNo} · ${cancelStatuses[row.status] ?? "其他处理状态"}`,
            }))}
            onChange={setSelected}
          />
          {order.cancelRequests.map((row) => (
            <article key={row.cancelRequestId} className="lyx-order-item">
              <strong>
                {row.requestNo} · {cancelStatuses[row.status] ?? "其他处理状态"}
              </strong>
              <p>
                {row.lineCount} 项 · 申请退回 {row.totalRefundPoints} 积分 ·{" "}
                {row.isSystemSubmitted ? "系统发起" : (row.requester?.name ?? "—")} ·{" "}
                {date.dateTime(row.submittedAt)}
              </p>
              <Button onClick={() => setSelected(row.cancelRequestId)}>查看申请详情</Button>
            </article>
          ))}
        </>
      )}
      {current ? (
        <CancelRequestPanel
          key={current.cancelRequestId}
          cancelRequestId={current.cancelRequestId}
          onChanged={onChanged}
        />
      ) : null}
      {creating && canRequest ? (
        <OrderCancelForm
          order={order}
          api={api}
          onClose={() => setCreating(false)}
          onChanged={(fresh) => {
            const added = fresh.cancelRequests.find(
              (row) =>
                !order.cancelRequests.some((old) => old.cancelRequestId === row.cancelRequestId),
            );
            if (added) setSelected(added.cancelRequestId);
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}
export function OrderActivity({
  orderId,
  api,
  scope,
}: {
  orderId: string;
  api: OrderAftercareApi;
  scope: string;
}) {
  const query = useInfiniteQuery({
    queryKey: ["order-activity", scope, orderId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => api.activity(orderId, signal, pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    retry: false,
  });
  const rows = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="lyx-order-sections" aria-label="订单活动记录">
      <div className="lyx-order-form__actions">
        <h2 className="lyx-section-title">订单活动</h2>
        <Button onClick={() => void query.refetch()}>刷新活动</Button>
      </div>
      {query.isPending ? (
        <Spin />
      ) : query.isError ? (
        <Alert type="error" title={aftercareError(query.error)} />
      ) : !rows.length ? (
        <p>暂无订单活动</p>
      ) : (
        rows.map((row) => (
          <article key={row.activityId} className="lyx-order-item">
            <strong>{row.summary}</strong>
            <p>
              {date.dateTime(row.occurredAt)} · {row.actorName ?? "系统"}
            </p>
            {row.reasonText ? <p>{row.reasonText}</p> : null}
          </article>
        ))
      )}
      {query.hasNextPage ? (
        <Button loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          加载更多活动
        </Button>
      ) : null}
    </section>
  );
}
function Downloads({
  orderId,
  itemId,
  title,
  api,
  scope,
}: {
  orderId: string;
  itemId: string;
  title: string;
  api: OrderAftercareApi;
  scope: string;
}) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ["order-downloads", scope, orderId, itemId, page],
    queryFn: ({ signal }) => api.downloads(orderId, itemId, signal, page),
    retry: false,
  });
  return (
    <section className="lyx-order-item" aria-label={`${title}下载记录`}>
      <div className="lyx-order-item__title">
        <h3>{title} · 成片与下载证据</h3>
        <Button onClick={() => void query.refetch()}>刷新下载记录</Button>
      </div>
      {query.isPending ? (
        <Spin />
      ) : query.isError ? (
        <Alert type="error" title={aftercareError(query.error)} />
      ) : (
        <>
          <p>
            成片发布包 {query.data.releases.length} · 下载授权 {query.data.grants.length} · 下载记录{" "}
            {query.data.logs.total}
          </p>
          {query.data.releases.map((release) => (
            <article key={release.deliveryReleaseId} className="lyx-order-letter">
              <strong>
                第{release.releaseNo}包 · {release.kind === "initial" ? "首次交付" : "返工补发"} ·{" "}
                {variants[release.variant]}
              </strong>
              <p>
                {releaseStates[release.state]} · {release.episodeCount}集 · 已保存
                {release.savedEpisodeCount}集 · {date.dateTime(release.pushedAt)} 推送
              </p>
              {release.changedEpisodeNos.length ? (
                <p>替换集数：{release.changedEpisodeNos.join("、")}</p>
              ) : null}
              {release.reason ? (
                <p>
                  原因：{release.reason.name}
                  {release.note ? ` · ${release.note}` : ""}
                </p>
              ) : null}
            </article>
          ))}
          {query.data.grants.map((grant) => (
            <p key={grant.downloadGrantId}>
              {date.dateTime(grant.createdAt)} · {grantStates[grant.state] ?? "其他授权状态"}
              {grant.isExpired ? "（已过期）" : ""} · 有效至 {date.dateTime(grant.expiresAt)}
              {grant.revokeReason ? " · 已记录撤销原因" : ""}
            </p>
          ))}
          {!query.data.logs.items.length ? (
            <p>暂无实际下载记录</p>
          ) : (
            query.data.logs.items.map((row) => (
              <p key={row.downloadId}>
                {date.dateTime(row.createdAt)} · {row.actorName ?? "系统操作"} ·{" "}
                {downloadKinds[row.kind] ?? "其他下载"}
                {row.episodeNo ? ` 第${row.episodeNo}集` : ""} ·{" "}
                {downloadClients[row.client] ?? "其他客户端"}
                {row.clientAck ? ` · ${row.clientAck === "saved" ? "已保存" : "保存失败"}` : ""}
              </p>
            ))
          )}
          <div className="lyx-order-form__actions">
            <Button disabled={page <= 1} onClick={() => setPage((old) => old - 1)}>
              上一页
            </Button>
            <span>第 {page} 页</span>
            <Button
              disabled={page * query.data.logs.pageSize >= query.data.logs.total}
              onClick={() => setPage((old) => old + 1)}
            >
              下一页
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
export function OrderLicenseEvidence({
  order,
  api,
  scope,
  onChanged,
}: {
  order: OrderDetail;
  api: OrderAftercareApi;
  scope: string;
  onChanged(): void;
}) {
  return (
    <div className="lyx-order-sections">
      {order.items.map((item) => (
        <div key={item.orderItemId} className="lyx-order-sections">
          <OrderLicenses
            orderId={order.orderId}
            itemId={item.orderItemId}
            title={item.dramaTitle}
            api={api}
            scope={scope}
            onChanged={onChanged}
          />
          <Downloads
            orderId={order.orderId}
            itemId={item.orderItemId}
            title={item.dramaTitle}
            api={api}
            scope={scope}
          />
        </div>
      ))}
    </div>
  );
}
