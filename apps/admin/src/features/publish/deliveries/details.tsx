import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { Alert } from "antd";
import { useEffect, useRef, useState } from "react";
import { InfoList } from "../../../components/InfoList";
import type { QueueActionResult } from "../../../components/QueueWorkbench";
import {
  DeliveryFailure,
  type DeliveriesApi,
  type DeliveryDetail,
  type EpisodeGrid,
  type Template,
} from "./api";
import { createIntent, pushBody } from "./model";
export type Release = Awaited<ReturnType<DeliveriesApi["release"]>>;
export type Controller = (checked: readonly string[]) => Promise<QueueActionResult>;
export function ReleaseFacts({ release }: { release: Release }) {
  return (
    <section className="lyx-delivery-release">
      <h3 className="lyx-section-title">已推送成片包 · 第 {release.releaseNo} 版</h3>
      <InfoList
        labelWidth={110}
        items={[
          { label: "剧集", value: `${release.episodeCount} 集 · ${release.totalBytes} 字节` },
          { label: "推送时间", value: date.dateTime(release.pushedAt) },
          {
            label: "下载链接有效期",
            value: release.activeGrant
              ? date.dateTime(release.activeGrant.expiresAt)
              : "暂无有效下载授权",
          },
          { label: "已保存剧集", value: `${release.savedEpisodeCount} 集` },
        ]}
      />
      <p className="lyx-delivery-text">{release.publishListText || "已按剧目资料预填"}</p>
    </section>
  );
}
export function DeliveryDetails({
  detail,
  grid,
  api,
  template,
  canPush,
  refresh,
  register,
  onReleased,
  release,
}: {
  detail: DeliveryDetail;
  grid: EpisodeGrid;
  api: DeliveriesApi;
  template: Template | undefined;
  canPush: boolean;
  refresh(): void;
  register(id: string, controller: Controller | null): void;
  onReleased(release: Release): void;
  release?: Release;
}) {
  const [intent] = useState(createIntent),
    live = useRef(true);
  const [failure, setFailure] = useState<string>();
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    register(detail.deliveryTicketId, async (checked) => {
      const body = pushBody(
        template,
        checked,
        detail.orderItem.accounts.some((account) => account.status === "abnormal"),
      );
      if (!live.current || !canPush || !detail.actions.includes("push-package") || !body)
        return { outcome: "failed", message: "请完成交付前检查，并刷新确认当前工单可交付" };
      try {
        const result = await intent(
          { id: detail.deliveryTicketId, version: detail.lockVersion, body },
          async (key) => {
            setFailure(undefined);
            await api.push(detail.deliveryTicketId, body, key);
            // POST 与 C50 回放的签名都不作为页面事实；重新读取工单及不可变成片包。
            const current = await api.detail(detail.deliveryTicketId);
            return current.release ? api.release(current.release.deliveryReleaseId) : null;
          },
        );
        if (!live.current || !result)
          return { outcome: "failed", message: "当前工单已切换，请刷新核对" };
        onReleased(result);
        refresh();
        return { outcome: "done", message: "成片包已推送给商家" };
      } catch (error) {
        if (!live.current) return { outcome: "failed", message: "当前工单已切换" };
        if (
          error instanceof DeliveryFailure &&
          [
            "VERSION_CONFLICT",
            "STATE_NOT_ALLOWED",
            "PRECONDITION_CHANGED",
            "CHECKLIST_VERSION_STALE",
          ].includes(error.code ?? "")
        ) {
          refresh();
          return { outcome: "conflict" };
        }
        const message = error instanceof Error ? error.message : "没有推送成功，请重试";
        setFailure(message);
        return { outcome: "failed", message };
      }
    });
    return () => register(detail.deliveryTicketId, null);
  });
  return (
    <div className="lyx-delivery-details">
      <InfoList
        labelWidth={84}
        items={[
          { label: "门店", value: detail.store.storeName || "未命名门店" },
          { label: "订购单", value: detail.order.orderNo },
          { label: "约定上线", value: detail.agreedLaunchDate ?? "未约定" },
          { label: "交付经理", value: detail.deliveryManager?.name ?? "未分配" },
          { label: "发布专员", value: detail.publisher?.name ?? "未分配" },
          {
            label: "发布账号",
            value: detail.orderItem.accounts
              .map(
                (account) =>
                  `${account.accountName}（${account.status === "abnormal" ? "异常" : "可用"}）`,
              )
              .join("、"),
          },
        ]}
      />
      <section>
        <h3 className="lyx-section-title">
          成片剧集 · {grid.currentPassedCount}/{grid.totalEpisodes} 集质检通过
        </h3>
        <div className="lyx-delivery-grid">
          {grid.episodes.map((episode) => (
            <div className="lyx-delivery-episode" key={episode.episodeNo}>
              <strong>第 {episode.episodeNo} 集</strong>
              <span>{episode.current?.fileName ?? episode.latest?.fileName ?? "尚未登记"}</span>
              <span>
                {episode.current?.qc?.verdict === "pass"
                  ? "质检通过"
                  : episode.latest?.qc?.verdict === "fail"
                    ? "质检未通过"
                    : "待质检"}
              </span>
              <small>{episode.current ? `${episode.current.sizeBytes} 字节` : "—"}</small>
            </div>
          ))}
        </div>
        <p>
          成片包质检：
          {grid.packageQc?.verdict === "pass"
            ? "通过"
            : grid.packageQc?.verdict === "fail"
              ? "未通过"
              : "待质检"}
        </p>
      </section>
      <section>
        <h3 className="lyx-section-title">发布清单</h3>
        <p>已按剧目资料预填</p>
        <InfoList
          labelWidth={84}
          items={[
            { label: "短剧", value: detail.dramaTitle },
            { label: "集数", value: `${detail.episodeCount} 集` },
            {
              label: "发布平台",
              value: detail.platforms.map((p) => (p === "douyin" ? "抖音" : "视频号")).join("、"),
            },
          ]}
        />
      </section>
      {release ? <ReleaseFacts release={release} /> : null}
      {failure ? <Alert type="error" title={failure} /> : null}
    </div>
  );
}
