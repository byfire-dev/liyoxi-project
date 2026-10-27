import { useState } from "react";
import { Alert } from "antd";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { InfoList } from "../../../components/InfoList";
import { Tabs } from "../../../components/Tabs";
import { EmptyState } from "../../../components/StateBlock";
import { moneyText, pointsText } from "../../billing/plans/model";
import { paymentStatus, paymentTypes } from "./payment-model";
import type { PaymentDetail } from "./payment-api";
const at = (value: string | null) => (value ? appDateTimeFormat.dateTimeFull(value) : "—");
export function PaymentDetailPanel({ row }: { row: PaymentDetail }) {
  const [tab, setTab] = useState("overview");
  return (
    <div className="billing-stack">
      <h3>
        {row.orderNo} · {paymentStatus[row.status] ?? row.status}
      </h3>
      <Tabs
        label="付款单详情子页签"
        activeKey={tab}
        onChange={setTab}
        items={[
          { key: "overview", label: "付款信息" },
          { key: "txns", label: "支付记录" },
          { key: "proofs", label: "转账凭证" },
          { key: "refunds", label: "退款与发票" },
          { key: "logs", label: "操作日志" },
        ]}
      />
      {tab === "overview" ? (
        <>
          <InfoList
            items={[
              { label: "主体", value: row.entity.name },
              { label: "门店", value: row.store?.name ?? "主体" },
              { label: "内容", value: row.title },
              { label: "类型", value: paymentTypes[row.type] ?? row.type },
              { label: "备注", value: row.contentNote ?? "—" },
              {
                label: "应付 / 实付 / 已退",
                value: `${moneyText(row.amountFen)} / ${moneyText(row.paidAmountFen)} / ${moneyText(row.refundedAmountFen)}`,
              },
              { label: "计价式", value: row.formula?.text ?? "—" },
              { label: "生效说明", value: row.effectNote ?? "—" },
              {
                label: "套餐 / 周期 / 积分",
                value: `${row.content.planName ?? "—"} / ${row.content.months ?? "—"}个月 / ${pointsText(row.content.points)}`,
              },
              {
                label: "付款方式",
                value:
                  row.channel === "bank_transfer"
                    ? "对公转账"
                    : row.channel === "wechat_jsapi"
                      ? "微信支付"
                      : row.channel,
              },
              { label: "收款户名", value: row.bankAccount?.accountName ?? "—" },
              {
                label: "收款银行 / 脱敏账号",
                value: row.bankAccount
                  ? `${row.bankAccount.bankName} / ${row.bankAccount.accountNoMask}`
                  : "—",
              },
              { label: "合同号", value: row.contractNo ?? "—" },
              {
                label: "建立来源",
                value:
                  row.source === "admin"
                    ? `后台 · ${row.createdBy?.name ?? "—"}`
                    : `商家端 · ${row.placedBy?.displayName ?? "—"} ${row.placedBy?.phoneMask ?? ""}`,
              },
              { label: "建立 / 失效", value: `${at(row.createdAt)} / ${at(row.expiresAt)}` },
              {
                label: "付款 / 取消 / 退款",
                value: `${at(row.paidAt)} / ${at(row.cancelledAt)} / ${at(row.refundedAt)}`,
              },
              {
                label: "履约",
                value: row.fulfillment
                  ? `${row.fulfillment.status} · ${at(row.fulfillment.effectiveAt)} · ${row.fulfillment.term ? `${row.fulfillment.term.planName} ${row.fulfillment.term.startDate} 至 ${row.fulfillment.term.endDate}` : pointsText(row.fulfillment.points)}`
                  : row.fulfillmentStatus,
              },
            ]}
          />
          {row.statusNote ? <Alert type="info" title={row.statusNote} /> : null}
          {row.openExceptions.map((e) => (
            <Alert
              key={e.paymentExceptionId}
              type="warning"
              title={`${e.exceptionNo} · ${e.kind} · ${e.status}`}
            />
          ))}
        </>
      ) : null}
      {tab === "txns" ? (
        row.paymentTxns.length ? (
          row.paymentTxns.map((t) => (
            <section key={t.paymentTransactionId} className="lyx-card billing-panel">
              <h4>
                第{t.attemptNo}次 · {t.channel} · {t.status}
              </h4>
              <InfoList
                items={[
                  { label: "渠道单号", value: t.channelTxnNo ?? "—" },
                  { label: "商户单号", value: t.outTradeNo },
                  {
                    label: "渠道金额 / 费 / 已退",
                    value: `${moneyText(t.channelAmountFen)} / ${moneyText(t.feeFen)} / ${moneyText(t.refundedFen)}`,
                  },
                  { label: "成功时间", value: at(t.channelSuccessAt) },
                  {
                    label: "应用 / 对账",
                    value: `${t.isApplied ? "已应用" : "未应用"} / ${t.reconState}`,
                  },
                  { label: "付款人", value: t.payerName ?? "—" },
                  {
                    label: "确认 / 复核",
                    value: `${t.confirmedBy?.name ?? "—"} / ${t.reviewedBy?.name ?? "—"}`,
                  },
                ]}
              />
            </section>
          ))
        ) : (
          <EmptyState title="暂无支付记录" />
        )
      ) : null}
      {tab === "proofs" ? (
        row.transferProofs.length ? (
          row.transferProofs.map((p) => (
            <p key={p.transferProofId}>
              第{p.uploadNo}次上传 · {p.reviewStatus}
              <br />
              {p.uploadedBy.name ?? "未提供"} · {at(p.uploadedAt)}
              <br />
              审核时间 {at(p.reviewedAt)}
            </p>
          ))
        ) : (
          <EmptyState title="暂无转账凭证" />
        )
      ) : null}
      {tab === "refunds" ? (
        <>
          <InfoList
            items={[
              { label: "发票状态", value: row.invoice.state },
              {
                label: "最新开票申请",
                value: row.invoice.latest
                  ? `${row.invoice.latest.requestNo} · ${row.invoice.latest.status} · ${row.invoice.latest.invoiceType} · ${row.invoice.latest.medium}`
                  : "无",
              },
            ]}
          />
          {row.refundRequests.length ? (
            row.refundRequests.map((r) => (
              <p key={r.refundRequestId}>
                {r.requestNo} · {moneyText(r.amountFen)} · {r.ruleCode}
                <br />
                {r.status} · {r.closeReason ?? "—"} · {at(r.createdAt)}
              </p>
            ))
          ) : (
            <EmptyState title="暂无退款申请" />
          )}
        </>
      ) : null}
      {tab === "logs" ? (
        row.logs.length ? (
          row.logs.map((log, index) => (
            <p key={`${log.at}:${index}`}>
              {at(log.at)} · {log.actor ?? "系统"}
              <br />
              {log.action} · {log.note ?? "—"}
            </p>
          ))
        ) : (
          <EmptyState title="暂无操作日志" />
        )
      ) : null}
    </div>
  );
}
