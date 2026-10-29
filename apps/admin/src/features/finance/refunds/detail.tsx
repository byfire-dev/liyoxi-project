import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Alert, Divider, Empty, Table, type TableProps } from "antd";
import type { ReactNode } from "react";
import { InfoList } from "../../../components/InfoList";
import { channelLabel, moneyText } from "../payments/model";
import type { RefundDetail } from "./api";
import { actionLabel, refundLabel, routeLabel, sourceLabels } from "./model";

const time = (value: string | null) =>
  value === null ? "—" : appDateTimeFormat.dateTimeFull(value);
const txnLabels: Readonly<Record<string, string>> = {
  created: "已建退款意图",
  processing: "渠道处理中",
  succeeded: "退款成功",
  closed: "渠道已关闭",
  abnormal: "渠道异常",
  not_accepted: "渠道未受理",
  abandoned: "已人工放弃",
};
export function RefundReadDetail({
  detail: d,
  receipt,
}: {
  detail: RefundDetail;
  receipt?: (fileId: string) => ReactNode;
}) {
  const columns: NonNullable<TableProps<RefundDetail["refundTxns"][number]>["columns"]> = [
    {
      key: "no",
      title: "商户退款单号 / 渠道",
      render: (_, r) => (
        <div className="lyx-cell-2">
          <span>{r.outRefundNo}</span>
          <span className="lyx-cell-2__sub">
            {r.channel === "offline" ? "线下退款" : "微信原路"} ·{" "}
            {r.origin === "system" ? "系统提交" : "渠道外部退款"}
          </span>
        </div>
      ),
    },
    {
      key: "amount",
      title: "金额 / 状态",
      render: (_, r) => (
        <div className="lyx-cell-2">
          <strong>{moneyText(r.amountFen)}</strong>
          <span className="lyx-cell-2__sub">
            {txnLabels[r.status]}
            {r.isLateSuccess ? " · 晚到成功" : ""}
          </span>
        </div>
      ),
    },
    {
      key: "submission",
      title: "提交 / 结果",
      render: (_, r) => (
        <div className="lyx-cell-2">
          <span>
            已提交 {r.submitCount} 次{r.isRetryHalted ? " · 自动重试已停止" : ""}
          </span>
          <span className="lyx-cell-2__sub">
            {r.successAt ? `成功于 ${time(r.successAt)}` : `最近提交 ${time(r.lastSubmitAt)}`}
          </span>
        </div>
      ),
    },
  ];
  return (
    <>
      <InfoList
        labelWidth={110}
        items={[
          { label: "退款申请", value: d.requestNo },
          { label: "当前状态", value: refundLabel(d) },
          { label: "来源", value: sourceLabels[d.source] },
          { label: "商家", value: d.entity?.name ?? "未关联主体" },
          { label: "付款单", value: d.paymentOrder?.orderNo ?? "未关联付款单" },
          { label: "申请金额", value: moneyText(d.amountFen) },
          {
            label: "核算基数 / 扣除",
            value: `${moneyText(d.baseAmountFen)} / ${moneyText(d.deductAmountFen)}`,
          },
          { label: "规则", value: d.ruleText },
          { label: "核算阶段", value: d.stageNote },
          { label: "申请原因", value: d.reason?.name ?? "—" },
          { label: "申请说明", value: d.note ?? "—" },
          { label: "申请人", value: d.requester?.name ?? "—" },
          { label: "申请时间", value: time(d.createdAt) },
          { label: "审批时间", value: time(d.decidedAt) },
          {
            label: "执行时限",
            value: (
              <>
                {time(d.execDueAt)}
                {d.isExecOverdue ? "（已超时）" : ""}
              </>
            ),
          },
          { label: "权益回收时间", value: time(d.entitlementRevokedAt) },
          {
            label: "实际执行人",
            value: d.isExecutedBySystem ? "系统" : (d.executedBy?.name ?? "—"),
          },
          { label: "最近执行时间", value: time(d.executedAt) },
          { label: "执行方式", value: routeLabel(d.execRoute) },
          { label: "完成 / 关闭时间", value: `${time(d.doneAt)} / ${time(d.closedAt)}` },
          { label: "关闭说明", value: d.closeNote ?? "—" },
        ]}
      />
      {d.invoice.needsRedInvoice ? (
        <Alert type="warning" title="原收款已开票，须完成红冲后才可执行退款" />
      ) : null}
      {d.hasExecError || d.execError ? (
        <Alert
          type="warning"
          title="最近一次执行未完成，请核对退款交易状态；未知结果不能视为未受理"
        />
      ) : null}
      <Divider>原收款与核算依据</Divider>
      <InfoList
        labelWidth={110}
        items={[
          { label: "原交易单号", value: d.paymentTxn.channelTxnNo ?? "—" },
          { label: "商户交易单号", value: d.paymentTxn.outTradeNo },
          { label: "收款渠道", value: channelLabel(d.paymentTxn.channel) },
          {
            label: "实收 / 手续费",
            value: `${moneyText(d.paymentTxn.channelAmountFen)} / ${moneyText(d.paymentTxn.feeFen)}`,
          },
          { label: "入账状态", value: d.paymentTxn.isApplied ? "已入账" : "未入账" },
          { label: "累计已退", value: moneyText(d.paymentTxn.refundedFen) },
          { label: "核算可退金额", value: moneyText(d.breakdown.refundableFen) },
          {
            label: "最新发票",
            value: d.invoice.latest
              ? `${d.invoice.latest.requestNo} · ${d.invoice.latest.status}`
              : "—",
          },
          {
            label: "当前可用路由",
            value: d.allowedRoutes.length ? d.allowedRoutes.map(routeLabel).join("、") : "无",
          },
          { label: "可否重试", value: d.canRetry ? "可按原退款单号重试" : "当前不可重试" },
          {
            label: "可否确认未受理",
            value: d.canConfirmNotAccepted ? "满足渠道未受理复核条件" : "当前不满足",
          },
          {
            label: "服务端授权动作",
            value: d.actions.length ? d.actions.map(actionLabel).join("、") : "无",
          },
        ]}
      />
      <Divider>退款交易</Divider>
      <Table
        columns={columns}
        rowKey="refundTxnId"
        dataSource={d.refundTxns}
        pagination={false}
        scroll={{ x: 520 }}
        locale={{ emptyText: <Empty description="暂无退款交易" /> }}
      />
      {d.refundTxns
        .filter((r) => r.offline !== null)
        .map((r) => (
          <InfoList
            key={r.refundTxnId}
            labelWidth={110}
            items={[
              { label: "线下退款单", value: r.outRefundNo },
              { label: "银行流水号", value: r.channelRefundNo ?? "—" },
              { label: "转账日期", value: r.offline?.transferDate ?? "—" },
              { label: "收款户名", value: r.offline?.payeeName ?? "—" },
              { label: "收款银行", value: r.offline?.payeeBank ?? "—" },
              { label: "收款账户（脱敏）", value: r.offline?.payeeAccountMask ?? "—" },
              { label: "登记人", value: r.offline?.registeredBy?.name ?? "—" },
              {
                label: "退款回单",
                value: r.offline ? (receipt?.(r.offline.receiptFileId) ?? "—") : "—",
              },
            ]}
          />
        ))}
      <Divider>关联与处理记录</Divider>
      <InfoList
        labelWidth={110}
        items={[
          { label: "来源差异", value: d.paymentException?.exceptionNo ?? "—" },
          {
            label: "客服工单",
            value: d.relatedServiceTickets.map((r) => r.ticketNo).join("、") || "—",
          },
        ]}
      />
      {d.logs.length ? (
        <ol>
          {d.logs.map((log, i) => (
            <li key={`${log.at}:${i}`}>
              {time(log.at)} · {log.actor} · {log.action}
              {log.note === null ? "" : ` · ${log.note}`}
            </li>
          ))}
        </ol>
      ) : (
        <p>暂无处理记录</p>
      )}
      <p>渠道结果与入账事实仅供查看；处理动作按当前服务端授权显示。</p>
    </>
  );
}
