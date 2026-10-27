import { Alert, Button, Checkbox, Form, Input, InputNumber, Select } from "antd";
import { useEffect, useState } from "react";
import { DiffBlock } from "../../../components/DiffBlock";
import { InfoList } from "../../../components/InfoList";
import { BillingDialog } from "../plans/dialog";
import { billingError } from "../plans/api";
import { createBillingIntent, createBillingRead, pointsText } from "../plans/model";
import type { AccountDetail, AccountsApi } from "./api";
import { adjustmentBody, adjustmentInput, type AdjustmentDraft } from "./model";
const reasons = [
  ["compensation", "服务补偿"],
  ["platform_refund", "平台原因退回"],
  ["correction", "积分纠错"],
  ["campaign", "活动赠送"],
  ["other", "其他"],
];
const blocked: Record<string, string> = {
  account_inactive: "账户未生效",
  insufficient: "可调整积分不足",
  hold_invalid: "冻结单不可退回",
  pending_exists: "已有待审申请",
};
export function AdjustmentDialog({
  row,
  api,
  onClose,
  onSaved,
}: {
  row: AccountDetail;
  api: AccountsApi;
  onClose(): void;
  onSaved(requestNo: string | null): void;
}) {
  const [form] = Form.useForm<AdjustmentDraft>(),
    [intent] = useState(() => createBillingIntent("points-adjust-request")),
    [reader] = useState(createBillingRead),
    [quote, setQuote] = useState<Awaited<ReturnType<AccountsApi["quote"]>>>(),
    [error, setError] = useState<string>(),
    [pending, setPending] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const reason = Form.useWatch("reasonCode", form);
  useEffect(() => {
    reader.activate();
    return () => reader.close();
  }, [reader]);
  const changed = () => {
    intent.change();
    reader.invalidate();
    setQuote(undefined);
    setPending(false);
    setConfirmed(false);
    setError(undefined);
  };
  return (
    <BillingDialog
      title={`发起积分调整 · ${row.entity.name}`}
      intent={intent}
      onClose={onClose}
      submitText="提交审批"
      disabled={!quote?.isAllowed || !confirmed}
      submit={async () => {
        if (!quote) return;
        const body = adjustmentBody(row.pointAccountId, await form.validateFields(), quote);
        const result = await intent.submit(body, (key, signal) => api.create(body, key, signal));
        if (result !== undefined) {
          onSaved(result.requestNo);
          onClose();
        }
      }}
    >
      <Alert type="info" title="提交只创建申请与审批，不修改余额；由不同员工审批后入账。" />
      <Form
        form={form}
        layout="vertical"
        initialValues={{ direction: "increase", lotKind: "addon", note: "" }}
        onValuesChange={changed}
      >
        <div className="billing-grid">
          <Form.Item name="direction" label="调整方向" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "increase", label: "增加" },
                { value: "decrease", label: "减少" },
              ]}
            />
          </Form.Item>
          <Form.Item name="lotKind" label="积分类型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "plan", label: "套餐积分" },
                { value: "addon", label: "加购积分" },
              ]}
            />
          </Form.Item>
        </div>
        <Form.Item name="adjustPoints" label="调整积分" rules={[{ required: true }]}>
          <InputNumber min={1} precision={0} />
        </Form.Item>
        <Form.Item name="reasonCode" label="调整原因" rules={[{ required: true }]}>
          <Select options={reasons.map(([value, label]) => ({ value, label }))} />
        </Form.Item>
        <Form.Item
          name="pointHoldId"
          label="关联冻结单"
          rules={[{ required: reason === "platform_refund" }]}
        >
          <Input placeholder="冻结单ID；平台原因退回必填" />
        </Form.Item>
        {row.notices.heldAwaitingQualification.length ? (
          <InfoList
            items={row.notices.heldAwaitingQualification.map((h) => ({
              label: `${h.store.name} · ${h.groupRef ?? h.pointHoldId}`,
              value: `${h.pointHoldId} · ${h.qty}积分`,
            }))}
          />
        ) : null}
        <Form.Item name="storeId" label="关联门店ID（选填）">
          <Input />
        </Form.Item>
        <Form.Item name="termExtensionRequestId" label="关联延长申请ID（选填，仅增加）">
          <Input />
        </Form.Item>
        <Form.Item name="serviceTicketId" label="关联客服工单ID（选填）">
          <Input />
        </Form.Item>
        <Form.Item
          name="note"
          label="调整依据（5–200字）"
          rules={[{ required: true, min: 5, max: 200, whitespace: true }]}
        >
          <Input.TextArea maxLength={200} showCount />
        </Form.Item>
      </Form>
      <Button
        loading={pending}
        onClick={() =>
          void (async () => {
            try {
              const body = adjustmentInput(await form.validateFields());
              setPending(true);
              setError(undefined);
              const result = await reader.run((signal) =>
                api.quote(row.pointAccountId, body, signal),
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
        试算调整影响
      </Button>
      {error ? <Alert role="alert" type="error" title={error} /> : null}
      {quote ? (
        <>
          <DiffBlock
            ariaLabel="调整前后可用积分"
            before={pointsText(quote.spendableBeforePoints)}
            after={pointsText(quote.spendableAfterPoints)}
          />
          <InfoList
            items={[
              {
                label: "本类可用积分",
                value: `${quote.lotAvailableBefore} → ${quote.lotAvailableAfter}`,
              },
              { label: "套餐积分到期", value: quote.planPointsExpireAt ?? "无" },
              { label: "冻结单可退", value: pointsText(quote.pointHold?.returnablePoints) },
            ]}
          />
          {quote.blockReasons.length ? (
            <Alert
              type="warning"
              title={quote.blockReasons.map((v) => blocked[v] ?? v).join("；")}
            />
          ) : null}
          <Checkbox
            checked={confirmed}
            disabled={!quote.isAllowed}
            onChange={(e) => setConfirmed(e.target.checked)}
          >
            已核对试算、关联单据和调整依据
          </Checkbox>
        </>
      ) : null}
    </BillingDialog>
  );
}
