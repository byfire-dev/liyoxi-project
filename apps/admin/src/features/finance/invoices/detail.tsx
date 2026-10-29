import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Alert, Button, Card } from "antd";
import { useEffect, useRef, useState } from "react";
import { InfoList } from "../../../components/InfoList";
import { channelLabel, moneyText } from "../payments/model";
import { invoiceError, type InvoiceApi } from "./api";
import { emailStates, invoiceMedia, invoiceStatuses, invoiceTypes } from "./model";
import type { InvoiceDetail as Detail } from "./types";
const checks: Readonly<Record<string, string>> = {
  order_paid_not_refunded: "付款已到账且未退款",
  no_refund_in_flight: "无在途退款",
  title_from_verified_license: "抬头取自已核验执照",
  not_invoiced_before: "未开具蓝票",
  special_fields_filled: "专票信息已填写",
};
const date = (value: string | null) => (value ? appDateTimeFormat.dateTimeFull(value) : "—");
export function InvoiceDetail({ row, api }: { row: Detail; api: InvoiceApi }) {
  const controller = useRef<AbortController | undefined>(undefined),
    [notice, setNotice] = useState<string>();
  useEffect(() => {
    const own = new AbortController();
    controller.current = own;
    return () => {
      own.abort();
    };
  }, []);
  const open = async (fileId: string) => {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted) return;
    const tab = window.open("about:blank", "_blank");
    if (tab) tab.opener = null;
    try {
      const signed = await api.fileUrl(fileId, signal);
      if (!signal.aborted && row.docs.some((doc) => doc.fileId === fileId) && tab)
        tab.location.href = signed.url;
      else tab?.close();
    } catch (error) {
      tab?.close();
      if (!signal.aborted) setNotice(invoiceError(error));
    }
  };
  return (
    <>
      <InfoList
        labelWidth={110}
        items={[
          { label: "申请单", value: row.requestNo },
          { label: "商家主体", value: row.entity.name },
          { label: "付款单", value: row.paymentOrder.orderNo },
          { label: "开票金额", value: <strong>{moneyText(row.amountFen)}</strong> },
          { label: "申请状态", value: invoiceStatuses[row.status] ?? "未知状态" },
          { label: "当前版本", value: String(row.lockVersion) },
          {
            label: "发票类型",
            value: `${invoiceTypes[row.invoiceType]} · ${invoiceMedia[row.medium]}`,
          },
          { label: "发票抬头", value: row.title },
          { label: "税号", value: row.taxNoMask },
          { label: "地址电话", value: row.addrTelMask ?? "—" },
          { label: "银行账户", value: row.bankAccountMask ?? "—" },
          { label: "接收邮箱", value: row.recvEmailMask ?? "—" },
          { label: "寄送信息", value: row.mailToMask ?? "—" },
          { label: "开票项目", value: row.itemName },
          { label: "付款渠道", value: channelLabel(row.orderChannel) },
          { label: "付款时间", value: date(row.orderPaidAt) },
          { label: "申请时间", value: date(row.appliedAt) },
          { label: "处理期限", value: date(row.dueAt) },
          { label: "处理说明", value: row.resultNote ?? "—" },
        ]}
      />
      {row.isHeldByRefund ? (
        <Alert
          type="warning"
          title={`退款处理中，暂停开具${row.heldByRefund ? `（${row.heldByRefund.requestNo}）` : ""}`}
        />
      ) : null}
      <Card title="开具前自动核对">
        <ul>
          {row.prechecks.map((check) => (
            <li key={check.key}>
              {checks[check.key] ?? "服务端附加核对项"}：{check.passed ? "通过" : "未通过"}
            </li>
          ))}
        </ul>
      </Card>
      {row.docs.map((doc) => (
        <Card key={doc.invoiceDocId} title={doc.docKind === "red" ? "红字发票" : "蓝字发票"}>
          <InfoList
            labelWidth={110}
            items={[
              { label: "发票号码", value: doc.invoiceNo },
              { label: "发票代码", value: doc.invoiceCode ?? "—" },
              { label: "发票金额", value: moneyText(doc.amountFen) },
              { label: "开具时间", value: date(doc.issuedAt) },
              { label: "开具人", value: doc.issuedBy?.name ?? "—" },
              { label: "邮件状态", value: emailStates[doc.emailState] ?? "未知状态" },
              { label: "邮件受理时间", value: date(doc.emailSentAt) },
              { label: "快递公司", value: doc.expressCompany?.name ?? "—" },
              { label: "运单号", value: doc.trackingNo ?? "—" },
              { label: "寄出时间", value: date(doc.shippedAt) },
              { label: "红冲说明", value: doc.redReason ?? "—" },
            ]}
          />
          {doc.fileId ? (
            <Button onClick={() => void open(doc.fileId!)}>
              查看{doc.docKind === "red" ? "红" : "蓝"}票文件
            </Button>
          ) : null}
        </Card>
      ))}
      {row.reject ? (
        <Alert
          type="warning"
          title={
            row.reject.kind === "order_refunded"
              ? "付款单已退款，申请已拒绝"
              : `已驳回：${row.reject.reason?.name ?? "—"}`
          }
          description={row.reject.note ?? "—"}
        />
      ) : null}
      {notice ? <Alert type="warning" title={notice} /> : null}
    </>
  );
}
