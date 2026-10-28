import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Alert, Divider } from "antd";
import { InfoList } from "../../../components/InfoList";
import { moneyText } from "../payments/model";
import { exceptionStatus, kindLabels, resolutionLabels } from "./labels";
import type { ExceptionDetail } from "./types";
const time = (value: string | null | undefined) =>
  value ? appDateTimeFormat.dateTimeFull(value) : "—";
function Fact({ value }: { value: ExceptionDetail["billFact"] }) {
  if (!value) return <p>暂无事实记录</p>;
  return (
    <InfoList
      items={[
        { label: "商户单号", value: value.outTradeNo ?? "—" },
        { label: "渠道交易号", value: value.transactionId ?? "—" },
        { label: "商户退款号", value: value.outRefundNo ?? "—" },
        { label: "渠道退款号", value: value.refundId ?? "—" },
        { label: "金额", value: moneyText(value.amountFen) },
        { label: "状态", value: value.state ?? "—" },
        { label: "发生时间", value: time(value.occurredAt) },
        { label: "说明", value: value.text ?? "—" },
      ]}
    />
  );
}
export function ExceptionFacts({ value }: { value: ExceptionDetail }) {
  return (
    <>
      {value.isOverdue ? <Alert type="warning" title="差异已超处理时限，请及时核对" /> : null}
      <InfoList
        items={[
          { label: "差异单号", value: value.exceptionNo },
          { label: "差异类型", value: kindLabels[value.kind] },
          { label: "状态", value: exceptionStatus[value.status] },
          { label: "商家", value: value.entity?.name ?? "未关联主体" },
          { label: "付款单", value: value.paymentOrder?.orderNo ?? "未关联付款单" },
          { label: "账单日", value: value.billDate },
          { label: "差异金额", value: moneyText(value.amountFen) },
          { label: "差异原因", value: value.causeText ?? "—" },
          { label: "处理方式", value: resolutionLabels[value.resolution] },
          { label: "处理说明", value: value.resolutionNote ?? "—" },
          { label: "处理人", value: value.resolvedBy?.name ?? "—" },
          { label: "处理时间", value: time(value.resolvedAt) },
        ]}
      />
      {value.refundRequest ? (
        <Alert
          type="info"
          title={`已关联退款申请 ${value.refundRequest.requestNo}；状态 ${value.refundRequest.status}`}
        />
      ) : null}
      {value.hints.map((hint) => (
        <Alert key={hint.code} type="info" title={hint.text} />
      ))}
      <Divider>账单侧事实</Divider>
      <Fact value={value.billFact} />
      <Divider>平台侧事实</Divider>
      <Fact value={value.platformFact} />
      {value.wxBillLine ? (
        <>
          <Divider>账单原行</Divider>
          <InfoList
            items={[
              { label: "账单行号", value: value.wxBillLine.lineNo },
              { label: "商户单号", value: value.wxBillLine.outTradeNo },
              { label: "原订单金额", value: moneyText(value.wxBillLine.orderAmountFen) },
              { label: "退款金额", value: moneyText(value.wxBillLine.refundAmountFen) },
              { label: "发生时间", value: time(value.wxBillLine.tradedAt) },
              { label: "匹配状态", value: value.wxBillLine.matchState },
            ]}
          />
        </>
      ) : null}
    </>
  );
}
