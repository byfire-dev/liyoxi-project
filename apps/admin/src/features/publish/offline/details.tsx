import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { Button, Space } from "antd";
import { useState } from "react";
import type { AppServices } from "../../../app/services";
import { InfoList } from "../../../components/InfoList";
import { EvidenceHistory } from "../patrol/interaction";
import type { OfflineApi, OfflineDetail } from "./api";
import { OfflineActionModal } from "./actions";
import { actionLabels, type OfflineAction } from "./model";
const events: Readonly<Record<string, string>> = {
  created: "创建下架任务",
  auto_reminded: "自动提醒",
  manual_reminded: "人工提醒",
  merchant_confirmed: "商家已确认",
  sample_released: "免抽查放行",
  found_online: "抽查仍在线",
  basis_reopened: "核查依据变化",
  escalated: "已升级",
  breach_notified: "违约提醒已登记",
  checked: "后台核查通过",
  voided: "任务取消",
  check_due_recalculated: "核查截止调整",
  follow_up: "跟进记录",
};
export function OfflineDetails({
  detail,
  api,
  services,
  canCheck,
  canBreach,
  refresh,
}: {
  detail: OfflineDetail;
  api: OfflineApi;
  services: AppServices;
  canCheck: boolean;
  canBreach: boolean;
  refresh(): void;
}) {
  const [action, setAction] = useState<OfflineAction>();
  return (
    <div className="lyx-lifecycle-details">
      <InfoList
        items={[
          { label: "门店", value: detail.store.storeName ?? "未命名门店" },
          { label: "作品", value: `${detail.dramaTitle} · ${detail.episodeCount} 集` },
          { label: "发布账号", value: detail.account.accountName },
          {
            label: "核查依据",
            value:
              detail.basis === "live"
                ? "已核验上线"
                : detail.basis === "delivered_unverified"
                  ? "已交付未核验上线"
                  : String(detail.basis),
          },
          { label: "使用期止日", value: detail.usageEndDate },
          { label: "下架截止", value: detail.dueDate },
          {
            label: "逾期情况",
            value: detail.isOverdue ? `已逾期 ${detail.overdueDays ?? "—"} 天` : "未逾期",
          },
          {
            label: "商家确认",
            value: detail.merchantConfirmedAt
              ? `${date.dateTime(detail.merchantConfirmedAt)} · ${detail.merchantConfirmedByName ?? "商家"}`
              : "尚未确认",
          },
          {
            label: "下架方式",
            value:
              detail.merchantMethod === "delete"
                ? "删除作品"
                : detail.merchantMethod === "private"
                  ? "仅自己可见"
                  : detail.merchantMethod === "not_published"
                    ? "未发布"
                    : String(detail.merchantMethod ?? "—"),
          },
          {
            label: "后台核查",
            value: detail.checkedAt
              ? `${date.dateTime(detail.checkedAt)} · ${detail.checkMethod === "manual" ? "人工核查" : (detail.checkMethod ?? "已处理")}`
              : "尚未核查",
          },
          {
            label: "核查截止",
            value: detail.checkDueAt
              ? `${date.dateTime(detail.checkDueAt)}${detail.isCheckOverdue ? " · 核查逾期" : ""}`
              : "—",
          },
          { label: "仍在线次数", value: String(detail.stillOnlineCount) },
          { label: "工单状态", value: String(detail.ticket.step) },
        ]}
      />
      {detail.results.length ? (
        <section>
          <h3 className="lyx-section-title">核查清单记录</h3>
          {detail.results.map((item) => (
            <p key={item.key}>
              {item.label}：{item.result === "pass" ? "通过" : (item.result ?? "未记录")}
            </p>
          ))}
        </section>
      ) : null}
      <EvidenceHistory ids={detail.evidenceFileIds} api={api} />
      <section>
        <h3 className="lyx-section-title">处理记录</h3>
        <ul className="lyx-lifecycle-history">
          {detail.timeline.map((item, index) => (
            <li key={`${item.at}:${index}`}>
              {date.dateTime(item.at)} · {events[String(item.kind)] ?? String(item.kind)} ·{" "}
              {item.actorName ?? (item.actorType === "system" ? "系统" : "操作人")}
              {item.note ? ` · ${item.note}` : ""}
            </li>
          ))}
        </ul>
      </section>
      <Space wrap>
        {(Object.keys(actionLabels) as OfflineAction[])
          .filter(
            (kind) =>
              detail.actions.includes(kind) &&
              (kind === "send-breach-notice" ? canBreach : canCheck),
          )
          .map((kind) => (
            <Button
              key={kind}
              type={kind === "check" ? "primary" : "default"}
              danger={kind === "mark-online"}
              disabled={kind === "send-breach-notice" && detail.isBreachNoticedToday}
              onClick={() => setAction(kind)}
            >
              {actionLabels[kind]}
            </Button>
          ))}
      </Space>
      {action && (action === "send-breach-notice" ? canBreach : canCheck) ? (
        <OfflineActionModal
          kind={action}
          detail={detail}
          api={api}
          services={services}
          refresh={refresh}
          close={() => setAction(undefined)}
        />
      ) : null}
    </div>
  );
}
