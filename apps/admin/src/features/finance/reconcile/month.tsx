import type { ReconDayRow, ReconMonth } from "@liyoxi/contract";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Button, Card, Space, Table, type TableColumnsType } from "antd";
import { InfoList } from "../../../components/InfoList";
import { moneyText } from "../payments/model";
import { billStatus, dayStatus, kindLabels, resolutionLabels } from "./labels";
import type { RerunTarget } from "./types";

const sum = (value: { count: number; amountFen: string } | null) =>
  value ? `${value.count} 笔 · ${moneyText(value.amountFen)}` : "—";
export function MonthFacts({
  value,
  mayRerun,
  rerun,
  select,
}: {
  value: ReconMonth;
  mayRerun: boolean;
  rerun: (row: RerunTarget) => void;
  select: (id: string) => void;
}) {
  const columns: TableColumnsType<ReconDayRow> = [
    { key: "day", title: "账单日", dataIndex: "billDate" },
    { key: "platform", title: "平台收款", render: (_, row) => sum(row.platformPay) },
    { key: "bill", title: "微信账单", render: (_, row) => sum(row.billPay) },
    { key: "bank", title: "对公收款", render: (_, row) => sum(row.bank) },
    {
      key: "refund",
      title: "平台 / 账单退款",
      render: (_, row) =>
        row.refund ? (
          <div>
            {row.refund.platformCount} 笔 · {moneyText(row.refund.platformFen)}
            <br />
            {row.refund.billCount} 笔 · {moneyText(row.refund.billFen)}
          </div>
        ) : (
          "—"
        ),
    },
    { key: "fee", title: "手续费", render: (_, row) => moneyText(row.feeFen) },
    {
      key: "diff",
      title: "差异与处理",
      render: (_, row) =>
        row.diff ? (
          <div>
            {sum(row.diff)}
            {row.diff.resolutions.map((r) => (
              <div key={r.resolution}>
                {resolutionLabels[r.resolution]} · {moneyText(r.amountFen)}
              </div>
            ))}
          </div>
        ) : (
          "—"
        ),
    },
    {
      key: "state",
      title: "状态 / 账单",
      render: (_, row) => (
        <div>
          {dayStatus[row.status]}
          <br />
          {row.billFileStatus ? billStatus[row.billFileStatus] : "—"}
        </div>
      ),
    },
    {
      key: "run",
      title: "运行",
      render: (_, row) => (
        <div>
          {row.runCount} 次<br />
          {row.lastRunAt ? appDateTimeFormat.dateTimeFull(row.lastRunAt) : "未运行"}
        </div>
      ),
    },
    {
      key: "action",
      title: "操作",
      render: (_, row) =>
        mayRerun && row.reconciliationId && row.actions.includes("rerun") ? (
          <Button onClick={() => rerun({ ...row, reconciliationId: row.reconciliationId! })}>
            重新对账
          </Button>
        ) : (
          "—"
        ),
    },
  ];
  return (
    <>
      <Card title={`${value.month} 对账概况`}>
        <InfoList
          labelWidth={110}
          items={[
            {
              label: "平台收款",
              value: `${sum(value.overview.platform)}（微信 ${value.overview.platform.wechatCount} 笔 / 对公 ${value.overview.platform.bankCount} 笔）`,
            },
            { label: "微信账单", value: sum(value.overview.wechatBill) },
            { label: "账单下载至", value: value.overview.wechatBill.downloadedThrough ?? "—" },
            {
              label: "退款",
              value: `${sum(value.overview.refund)} · ${value.overview.refund.isBillMatched ? "与账单一致" : "尚未与账单一致"}`,
            },
            {
              label: "未结差异",
              value: `${value.overview.diff.openCount} 笔 · ${moneyText(value.overview.diff.openAmountFen)}`,
            },
            { label: "审批处理中", value: value.overview.diff.resolvingCount },
            { label: "最早未结日", value: value.overview.diff.earliestOpenBillDate ?? "—" },
            {
              label: "逐日状态",
              value: `一致 ${value.dayStatusCounts.ok} / 差异 ${value.dayStatusCounts.diff} / 已处理 ${value.dayStatusCounts.fixed} / 等待 ${value.dayStatusCounts.wait}`,
            },
            { label: "上月对账", value: value.prevMonthAllOk ? "全部一致" : "尚未全部一致" },
          ]}
        />
      </Card>
      <Card title="逐日对账">
        <Table<ReconDayRow>
          aria-label="逐日对账"
          rowKey="billDate"
          dataSource={value.items}
          columns={columns}
          pagination={false}
          size="small"
          scroll={{ x: 1300 }}
          locale={{ emptyText: "本月暂无逐日对账记录" }}
        />
      </Card>
      {value.openExceptions.length ? (
        <Card title="待处理差异提醒（最多20条，完整记录见下方列表）">
          <Space orientation="vertical" style={{ width: "100%" }}>
            {value.openExceptions.map((row) => (
              <Button
                key={row.paymentExceptionId}
                type="link"
                onClick={() => select(row.paymentExceptionId)}
              >
                {row.exceptionNo} · {kindLabels[row.kind]} · {row.billDate} ·{" "}
                {moneyText(row.amountFen)}
                {row.isOverdue ? " · 已超时" : ""}
              </Button>
            ))}
          </Space>
        </Card>
      ) : null}
    </>
  );
}
