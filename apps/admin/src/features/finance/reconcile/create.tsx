import {
  PaymentExceptionCreateBodySchema,
  type PaymentExceptionCreateBody,
} from "@liyoxi/contract";
import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Checkbox, Input, InputNumber, Modal, Select, Space } from "antd";
import { useContext, useState } from "react";
import { AccessContext } from "../../../lib/permissions";
import { DETAIL_QUERY } from "../../../lib/query";
import { moneyText } from "../payments/model";
import type { ReconcileApi } from "./api";
import { useReconcileMutation } from "./mutation";
import { canCreateException } from "./model";
import type { ExceptionDetail } from "./types";

export function CreateException({
  api,
  refresh,
  onCreated,
  onClose,
}: {
  api: ReconcileApi;
  refresh: (signal: AbortSignal, value?: ExceptionDetail) => Promise<void>;
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const access = useContext(AccessContext),
    [receivedAt, setReceivedAt] = useState(""),
    [amount, setAmount] = useState<number | null>(null),
    [payerName, setPayerName] = useState(""),
    [serial, setSerial] = useState(""),
    [bank, setBank] = useState<string>(),
    [note, setNote] = useState(""),
    [checked, setChecked] = useState<string>(),
    [validation, setValidation] = useState<string>();
  const banks = useQuery({
    queryKey: ["finance", "reconcile", "banks"],
    queryFn: ({ signal }) => api.banks(signal),
    ...DETAIL_QUERY,
  });
  // datetime-local 明确按北京时间解释，不随操作者电脑时区漂移。
  const instant = receivedAt ? new Date(`${receivedAt}+08:00`) : null,
    body = {
      receivedAt: instant && Number.isFinite(instant.getTime()) ? instant.toISOString() : "",
      amountFen: amount,
      payerName: payerName.trim(),
      bankSerialNo: serial.trim(),
      payerBankCode: bank,
      note: note.trim(),
      confirm: { amountFen: amount, bankSerialNo: serial.trim() },
    },
    stamp = JSON.stringify(body),
    mutation = useReconcileMutation<PaymentExceptionCreateBody, ExceptionDetail>({
      command: "create",
      execute: (value, key, signal) => api.create(value, key, signal),
      refresh,
      onDone: (value) => onCreated(value.paymentExceptionId),
      invalidate: () => setChecked(undefined),
    }),
    disabled =
      mutation.busy || mutation.blocked || mutation.readOnly || !canCreateException(access);
  function submit() {
    if (checked !== stamp || disabled) return;
    const parsed = PaymentExceptionCreateBodySchema.safeParse(body);
    if (!parsed.success) {
      setValidation("请核对到账时间、正整数分金额、付款人、流水号与说明");
      return;
    }
    setValidation(undefined);
    void mutation.submit(parsed.data);
  }
  return (
    <Modal
      open
      title="登记未关联对公收款"
      styles={{ body: { maxHeight: "calc(100vh - 260px)", overflowY: "auto" } }}
      footer={null}
      closable={!mutation.busy}
      keyboard={!mutation.busy}
      mask={{ closable: !mutation.busy }}
      onCancel={onClose}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
        <Alert
          type="info"
          title="仅登记已到账且未关联的款项为待处理差异；关联付款单或线下退回须另行核对。"
        />
        {validation || mutation.notice ? (
          <Alert type="warning" title={validation ?? mutation.notice} />
        ) : null}
        {mutation.conflicts.length ? (
          <Alert
            type="warning"
            title="流水冲突记录"
            description={mutation.conflicts
              .map((row) => `${row.ref}（${row.payerBank?.name ?? "未登记银行"}）`)
              .join("；")}
          />
        ) : null}
        <label>
          到账时间（北京时间）
          <Input
            type="datetime-local"
            value={receivedAt}
            disabled={disabled}
            onChange={(e) => setReceivedAt(e.target.value)}
          />
        </label>
        <label>
          到账金额（分）
          <InputNumber
            style={{ width: "100%" }}
            min={1}
            precision={0}
            value={amount}
            disabled={disabled}
            onChange={setAmount}
          />
        </label>
        <label>
          原付款人名称
          <Input
            value={payerName}
            maxLength={100}
            disabled={disabled}
            onChange={(e) => setPayerName(e.target.value)}
          />
        </label>
        <label>
          银行流水号
          <Input
            value={serial}
            maxLength={64}
            disabled={disabled}
            onChange={(e) => setSerial(e.target.value)}
          />
        </label>
        <label>
          付款银行（可选）
          <Select
            aria-label="付款银行"
            style={{ width: "100%" }}
            allowClear
            value={bank}
            disabled={disabled}
            loading={banks.isFetching}
            options={banks.data?.items
              .filter((item) => item.isEnabled)
              .map((item) => ({ value: item.code, label: item.name }))}
            onChange={setBank}
          />
        </label>
        {banks.isError ? (
          <Alert
            type="warning"
            title="银行字典读取失败，可不选银行登记"
            action={<Button onClick={() => void banks.refetch()}>重读银行</Button>}
          />
        ) : null}
        <label>
          登记说明
          <Input.TextArea
            value={note}
            maxLength={200}
            disabled={disabled}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <Checkbox
          checked={checked === stamp}
          disabled={disabled}
          onChange={(e) => setChecked(e.target.checked ? stamp : undefined)}
        >
          已核对到账 {moneyText(amount)}、流水号 {serial.trim() || "—"}
        </Checkbox>
        <Space>
          <Button
            type="primary"
            loading={mutation.busy}
            disabled={disabled || checked !== stamp}
            onClick={submit}
          >
            登记差异
          </Button>
          {mutation.blocked || mutation.readOnly ? (
            <Button disabled={mutation.busy} onClick={() => void mutation.reread()}>
              重新读取
            </Button>
          ) : null}
          <Button disabled={mutation.busy} onClick={onClose}>
            关闭
          </Button>
        </Space>
      </Space>
    </Modal>
  );
}
