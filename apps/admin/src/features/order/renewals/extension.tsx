import { Alert, Button, Checkbox, Form, Input, InputNumber, Select, Skeleton } from "antd";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DiffBlock } from "../../../components/DiffBlock";
import { InfoList } from "../../../components/InfoList";
import { ErrorState } from "../../../components/StateBlock";
import { BillingDialog } from "../../billing/plans/dialog";
import { billingError } from "../../billing/plans/api";
import { createBillingIntent, createBillingRead, pointsText } from "../../billing/plans/model";
import { extensionBody } from "./model";
import type { RenewalsApi, TermDetail } from "./api";
const blocked: Record<string, string> = {
  no_term: "没有可延长周期",
  term_refunded: "周期已退款",
  refund_in_progress: "退款在办",
  pending_exists: "已有待审延长",
};
export function ExtensionDialog({
  row,
  api,
  scope,
  onClose,
  onSaved,
}: {
  row: TermDetail;
  api: RenewalsApi;
  scope: string;
  onClose(): void;
  onSaved(no: string | null): void;
}) {
  const [form] = Form.useForm<{ days: number; reasonCode: string; note: string }>(),
    [intent] = useState(() => createBillingIntent("term-extension-request")),
    [reader] = useState(createBillingRead),
    [quote, setQuote] = useState<Awaited<ReturnType<RenewalsApi["quote"]>>>(),
    [pending, setPending] = useState(false),
    [error, setError] = useState<string>(),
    [confirmed, setConfirmed] = useState(false);
  const reasons = useQuery({
    queryKey: ["billing", scope, "extend-reasons"],
    queryFn: ({ signal }) => api.reasons(signal),
  });
  useEffect(() => {
    reader.activate();
    return () => reader.close();
  }, [reader]);
  const allowed = !!quote && quote.mode !== "not_applicable" && !quote.blockReasons.length;
  return (
    <BillingDialog
      title={`发起补偿延长 · ${row.entity.name}`}
      intent={intent}
      onClose={onClose}
      submitText="提交审批"
      disabled={!allowed || !confirmed || !reasons.data?.items.some((r) => r.isEnabled)}
      submit={async () => {
        if (!quote) return;
        const draft = await form.validateFields();
        if (!reasons.data?.items.some((r) => r.isEnabled && r.code === draft.reasonCode))
          throw new Error("请选择当前启用的延长原因");
        const body = extensionBody(row, draft, quote),
          result = await intent.submit(body, (key, signal) => api.create(body, key, signal));
        if (result !== undefined) {
          onSaved(result.requestNo);
          onClose();
        }
      }}
    >
      <Alert
        type="info"
        title="提交后等待不同员工审批，不立即延长；周期顺延和积分恢复仅展示服务端试算。"
      />
      <Form
        form={form}
        layout="vertical"
        initialValues={{ days: 7, note: "" }}
        onValuesChange={() => {
          reader.invalidate();
          intent.change();
          setQuote(undefined);
          setPending(false);
          setConfirmed(false);
          setError(undefined);
        }}
      >
        <Form.Item name="days" label="延长天数（1–90）" rules={[{ required: true }]}>
          <InputNumber min={1} max={90} precision={0} />
        </Form.Item>
        {reasons.isPending ? (
          <Skeleton active />
        ) : reasons.isError ? (
          <ErrorState onRetry={() => void reasons.refetch()} />
        ) : (
          <Form.Item name="reasonCode" label="延长原因" rules={[{ required: true }]}>
            <Select
              options={reasons.data.items
                .filter((r) => r.isEnabled && r.typeKey === "extend_reason")
                .map((r) => ({ value: r.code, label: r.name }))}
            />
          </Form.Item>
        )}
        <Form.Item
          name="note"
          label="补偿依据（1–200字）"
          rules={[{ required: true, whitespace: true, max: 200 }]}
        >
          <Input.TextArea maxLength={200} showCount />
        </Form.Item>
      </Form>
      <Button
        loading={pending}
        onClick={() =>
          void (async () => {
            try {
              const draft = await form.validateFields();
              setPending(true);
              setError(undefined);
              const result = await reader.run((signal) =>
                api.quote(row.subscriptionTermId, { days: draft.days }, signal),
              );
              if (result !== undefined) {
                setQuote(result);
                setPending(false);
              }
            } catch (cause) {
              setError(billingError(cause));
              setPending(false);
            }
          })()
        }
      >
        试算延长影响
      </Button>
      {error ? <Alert role="alert" type="error" title={error} /> : null}
      {quote ? (
        <>
          <DiffBlock
            ariaLabel="延长前后到期日"
            before={quote.prevEndDate ?? "不可用"}
            after={quote.newEndDate ?? "不可用"}
          />
          <InfoList
            items={[
              {
                label: "模式",
                value:
                  quote.mode === "extend"
                    ? "延长"
                    : quote.mode === "revive"
                      ? "恢复周期"
                      : "不适用",
              },
              { label: "积分恢复", value: pointsText(quote.restorePoints) },
              { label: "清零时间", value: quote.newEndsAt ?? "—" },
              {
                label: "顺延预约周期",
                value:
                  quote.shiftedTerms.map((t) => `${t.startDate} 至 ${t.endDate}`).join("；") ||
                  "无",
              },
            ]}
          />
          {quote.isTargetDifferent ? (
            <Alert
              type="warning"
              title={`服务端试算目标已转至周期 ${quote.targetSubscriptionTermId}；本申请仍提交原所见周期供服务端复核。`}
            />
          ) : null}
          {quote.blockReasons.length ? (
            <Alert
              type="warning"
              title={quote.blockReasons.map((k) => blocked[k] ?? k).join("；")}
            />
          ) : null}
          <Checkbox
            checked={confirmed}
            disabled={!allowed}
            onChange={(e) => setConfirmed(e.target.checked)}
          >
            已核对作用周期、顺延与恢复积分
          </Checkbox>
        </>
      ) : null}
    </BillingDialog>
  );
}
