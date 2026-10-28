import {
  PaymentExceptionResolveBodySchema,
  type PaymentExceptionResolveBody,
} from "@liyoxi/contract";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Alert, Button, Checkbox, Input, Modal, Select, Space } from "antd";
import { useContext, useState } from "react";
import type { AppServices } from "../../../app/services";
import { AccessContext } from "../../../lib/permissions";
import { moneyText } from "../payments/model";
import type { ReconcileApi } from "./api";
import { resolutionHelp, resolutionLabels } from "./labels";
import { canReturnReceipt, resolutions, resolveBody } from "./model";
import { useReconcileMutation } from "./mutation";
import type { ExceptionDetail, Resolution } from "./types";
import { OrphanReturnReceipt } from "./upload";

type ResolveResult = Awaited<ReturnType<ReconcileApi["resolve"]>>;
export function ResolveException({
  value,
  services,
  api,
  refresh,
  onDone,
  onClose,
}: {
  value: ExceptionDetail;
  services: AppServices;
  api: ReconcileApi;
  refresh: (signal: AbortSignal) => Promise<void>;
  onDone: (value: ResolveResult) => void;
  onClose: () => void;
}) {
  const access = useContext(AccessContext),
    allowed = resolutions(value, access),
    [resolution, setResolution] = useState<Resolution>(allowed[0] ?? "corrected"),
    [note, setNote] = useState(""),
    [link, setLink] = useState<string>(),
    [transferDate, setTransferDate] = useState(""),
    [serial, setSerial] = useState(""),
    [payeeName, setPayeeName] = useState(""),
    [payeeBank, setPayeeBank] = useState(""),
    [account, setAccount] = useState(""),
    [receipt, setReceipt] = useState<string | null>(null),
    [checked, setChecked] = useState<string>(),
    [validation, setValidation] = useState<string>();
  const extra = {
      linkPaymentOrderId: link,
      offlineReturn: {
        transferDate,
        bankSerialNo: serial.trim(),
        payeeName: payeeName.trim(),
        payeeBank: payeeBank.trim(),
        payeeAccount: account,
        receiptFileId: receipt ?? "",
      },
    },
    stamp = JSON.stringify({
      version: value.lockVersion,
      resolution,
      note,
      extra,
      no: value.exceptionNo,
      amount: value.amountFen,
    }),
    mutation = useReconcileMutation<PaymentExceptionResolveBody, ResolveResult>({
      command: "resolve",
      execute: (body, key, signal) => api.resolve(value, body, key, signal),
      refresh,
      onDone,
      invalidate: () => setChecked(undefined),
    }),
    disabled = mutation.busy || mutation.blocked || mutation.readOnly,
    uploadAllowed = canReturnReceipt(access),
    maySubmit = allowed.includes(resolution) && (resolution !== "offline_return" || uploadAllowed);
  function submit() {
    if (disabled || !maySubmit || checked !== stamp) return;
    try {
      const parsed = PaymentExceptionResolveBodySchema.safeParse(
        resolveBody(value, resolution, note, extra),
      );
      if (!parsed.success) {
        setValidation("请核对处理说明、候选付款单或完整的线下退回凭据");
        return;
      }
      setValidation(undefined);
      void mutation.submit(parsed.data);
    } catch {
      setValidation("处理条件已变化，请重新读取并核对");
    }
  }
  return (
    <Modal
      open
      title={`处理差异 ${value.exceptionNo}`}
      styles={{ body: { maxHeight: "calc(100vh - 260px)", overflowY: "auto" } }}
      width={680}
      footer={null}
      closable={!mutation.busy}
      keyboard={!mutation.busy}
      mask={{ closable: !mutation.busy }}
      onCancel={onClose}
    >
      <Space orientation="vertical" style={{ width: "100%" }}>
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
        {!allowed.length ? (
          <Alert type="warning" title="当前差异或权限已不可处理，请关闭并核对详情" />
        ) : null}
        <label>
          处理方式
          <Select
            aria-label="差异处理方式"
            style={{ width: "100%" }}
            disabled={disabled}
            value={resolution}
            options={allowed.map((code) => ({ value: code, label: resolutionLabels[code] }))}
            onChange={(next) => {
              setResolution(next);
              setReceipt(null);
              setChecked(undefined);
              setValidation(undefined);
            }}
          />
        </label>
        <Alert type="info" title={resolutionHelp[resolution]} />
        {resolution === "link_order" ? (
          <label>
            可关联付款单
            <Select
              aria-label="可关联付款单"
              style={{ width: "100%" }}
              disabled={disabled}
              value={link}
              options={value.linkCandidates.map((row) => ({
                value: row.paymentOrderId,
                label: `${row.orderNo} · ${row.entity.name} · ${moneyText(row.amountFen)} · ${appDateTimeFormat.dateTimeFull(row.createdAt)}`,
              }))}
              onChange={setLink}
            />
          </label>
        ) : null}
        {resolution === "offline_return" ? (
          <>
            {!uploadAllowed ? (
              <Alert
                type="warning"
                title="登记线下退回需要全量数据范围及回单确认权限，当前不可上传或提交"
              />
            ) : null}
            <label>
              实际转账日期
              <Input
                type="date"
                value={transferDate}
                disabled={disabled}
                onChange={(e) => setTransferDate(e.target.value)}
              />
            </label>
            <label>
              退回银行流水号
              <Input
                value={serial}
                maxLength={64}
                disabled={disabled}
                onChange={(e) => setSerial(e.target.value)}
              />
            </label>
            <label>
              收款户名（须与原付款人一致）
              <Input
                value={payeeName}
                maxLength={100}
                disabled={disabled}
                onChange={(e) => setPayeeName(e.target.value)}
              />
            </label>
            <label>
              收款银行
              <Input
                value={payeeBank}
                maxLength={100}
                disabled={disabled}
                onChange={(e) => setPayeeBank(e.target.value)}
              />
            </label>
            <label>
              收款账号
              <Input.Password
                value={account}
                autoComplete="off"
                maxLength={40}
                disabled={disabled}
                onChange={(e) => setAccount(e.target.value)}
              />
            </label>
            <OrphanReturnReceipt
              services={services}
              disabled={disabled || !uploadAllowed}
              onChange={setReceipt}
            />
          </>
        ) : null}
        <label>
          处理说明
          <Input.TextArea
            value={note}
            maxLength={200}
            disabled={disabled}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <Checkbox
          checked={checked === stamp}
          disabled={disabled || !maySubmit}
          onChange={(e) => setChecked(e.target.checked ? stamp : undefined)}
        >
          已核对差异 {value.exceptionNo}、金额 {moneyText(value.amountFen)} 及所选处理方式
        </Checkbox>
        <Space>
          <Button
            type="primary"
            loading={mutation.busy}
            disabled={disabled || !maySubmit || checked !== stamp}
            onClick={submit}
          >
            确认{resolutionLabels[resolution]}
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
