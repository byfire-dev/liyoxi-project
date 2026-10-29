import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Alert, Divider } from "antd";
import { InfoList } from "../../../components/InfoList";
import type { AdjustmentCase } from "./api";
import { kindLabels, statusLabels } from "./model";
const time = (value: string | null) =>
  value === null ? "—" : appDateTimeFormat.dateTimeFull(value);
export const points = (value: number | null) =>
  value === null ? "—" : `${value.toLocaleString("zh-CN")} 积分`;
const modeLabels = {
  extend: "顺延周期",
  revive: "复活周期",
  not_applicable: "当前不可延长",
} as const;
const blocks: Readonly<Record<string, string>> = {
  no_term: "没有可用周期",
  term_refunded: "周期已退款",
  refund_in_progress: "退款进行中",
  pending_exists: "已有待审申请",
};
export function AdjustmentDetail({ value }: { value: AdjustmentCase }) {
  const { row } = value,
    approval = row.approval;
  return (
    <>
      <InfoList
        labelWidth={110}
        items={[
          { label: "申请类型", value: kindLabels[value.kind] },
          { label: "申请单号", value: row.requestNo ?? "—" },
          { label: "商家", value: row.entity.name },
          { label: "状态", value: statusLabels[approval.status] },
          { label: "发起人", value: approval.requester?.name ?? "—" },
          { label: "发起人角色", value: approval.requesterRoleName ?? "—" },
          { label: "提交时间", value: time(approval.submittedAt) },
          { label: "处理时限", value: time(approval.dueAt) },
          { label: "审批轮次 / 版本", value: `${approval.roundNo} / ${approval.lockVersion}` },
          { label: "申请说明", value: row.note },
        ]}
      />
      {approval.badges.includes("overdue") ? (
        <Alert type="warning" title="此申请已超过处理时限" />
      ) : null}
      {value.kind === "points_adjust" ? (
        <>
          <Divider>积分调整依据与执行结果</Divider>
          <InfoList
            labelWidth={110}
            items={[
              {
                label: "方向 / 类型",
                value: `${value.row.direction === "increase" ? "增加" : "扣减"} / ${value.row.lotKind === "plan" ? "套餐积分" : "加购积分"}`,
              },
              { label: "调整数量", value: points(value.row.adjustPoints) },
              { label: "净调整", value: points(value.row.signedPoints) },
              { label: "原因码", value: value.row.reasonCode },
              { label: "提交时可用", value: points(value.row.spendableBeforePoints) },
              { label: "提交时调整预览", value: points(value.row.spendableAfterPreviewPoints) },
              { label: "当前可用", value: points(value.row.currentSpendablePoints) },
              {
                label: "已执行后可用",
                value: points(value.row.applied?.spendableAfterPoints ?? null),
              },
              { label: "入账时间", value: time(value.row.applied?.appliedAt ?? null) },
              {
                label: "冻结关联",
                value: value.row.pointHold
                  ? `${points(value.row.pointHold.qty)} · ${value.row.pointHold.status} · ${value.row.pointHold.purpose}`
                  : "—",
              },
              { label: "延长申请关联", value: value.row.termExtensionRequest?.requestNo ?? "—" },
              {
                label: "关联工单",
                value:
                  value.row.relatedServiceTickets.map((ticket) => ticket.ticketNo).join("、") ||
                  "—",
              },
            ]}
          />
        </>
      ) : (
        <>
          <Divider>周期与实时效果预览</Divider>
          <InfoList
            labelWidth={110}
            items={[
              { label: "原套餐", value: value.row.subscriptionTerm.planName },
              {
                label: "原周期",
                value: `${value.row.subscriptionTerm.startDate} 至 ${value.row.subscriptionTerm.endDate}`,
              },
              { label: "延长天数", value: `${value.row.days} 天` },
              { label: "原因", value: value.row.reason.name },
              {
                label: "当前预览",
                value: value.row.preview ? modeLabels[value.row.preview.mode] : "无当前预览",
              },
              { label: "预览原到期日", value: value.row.preview?.prevEndDate ?? "—" },
              { label: "预览新到期日", value: value.row.preview?.newEndDate ?? "—" },
              { label: "预览清零时间", value: time(value.row.preview?.newEndsAt ?? null) },
              { label: "预览恢复积分", value: points(value.row.preview?.restorePoints ?? null) },
              {
                label: "当前目标变化",
                value: value.row.preview
                  ? value.row.preview.isTargetDifferent
                    ? "目标已变化，请核对当前预览"
                    : "仍为原周期"
                  : "—",
              },
            ]}
          />
          {value.row.preview?.blockReasons.length ? (
            <Alert
              type="warning"
              title={value.row.preview.blockReasons.map((reason) => blocks[reason]).join("；")}
            />
          ) : null}
          {value.row.preview?.shiftedTerms.length ? (
            <>
              <h3>后续周期顺延预览</h3>
              <ul>
                {value.row.preview.shiftedTerms.map((term) => (
                  <li key={term.subscriptionTermId}>
                    {term.startDate} 至 {term.endDate}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <Divider>已执行快照</Divider>
          <InfoList
            labelWidth={110}
            items={[
              {
                label: "执行模式",
                value: value.row.applied
                  ? modeLabels[value.row.applied.appliedMode]
                  : "尚无执行结果",
              },
              { label: "已执行原到期日", value: value.row.applied?.prevEndDate ?? "—" },
              { label: "已执行新到期日", value: value.row.applied?.newEndDate ?? "—" },
              { label: "执行时间", value: time(value.row.applied?.appliedAt ?? null) },
              {
                label: "关联积分调整",
                value:
                  value.row.relatedAdjustments
                    .map(
                      (adjustment) => `${adjustment.requestNo ?? "未编号"} · ${adjustment.status}`,
                    )
                    .join("；") || "—",
              },
            ]}
          />
        </>
      )}
      <Divider>审批结果</Divider>
      <InfoList
        labelWidth={110}
        items={[
          {
            label: "处理人",
            value: approval.isDecidedBySystem ? "系统" : (approval.decidedBy?.name ?? "—"),
          },
          { label: "处理时间", value: time(approval.decidedAt) },
          {
            label: "处理原因",
            value: approval.reasons.map((reason) => reason.name).join("、") || "—",
          },
          { label: "处理说明", value: approval.decisionNote ?? "—" },
        ]}
      />
    </>
  );
}
