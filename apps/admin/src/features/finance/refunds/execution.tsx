import { maskBankAccount } from "@liyoxi/shared/mask";
import { Alert, Button, Input, Modal, Space } from "antd";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AppServices } from "../../../app/services";
import {
  ConfirmPanel,
  confirmReady,
  type ConfirmInput,
  type ConfirmSpec,
} from "../../../components/ConfirmAction";
import { AccessContext, canAction } from "../../../lib/permissions";
import { moneyText } from "../payments/model";
import type { RefundDetail } from "./api";
import {
  RefundExecutionFailure,
  refundExecutionError,
  refundExecutionNeedsReload,
  type RefundExecutionApi,
} from "./execution-api";
import {
  allowedRefundExecutions,
  createRefundExecutionIntent,
  emptyOfflineRefund,
  executionLabels,
  pendingRefundTxn,
  refundExecutionCommand,
  refundExecutionStamp,
} from "./execution-model";
import type { OfflineRefundDraft, RefundExecution } from "./execution-types";
import { OfflineRefundUpload } from "./offline-upload";

export function RefundExecutionPanel({
  detail,
  api,
  services,
  read,
  refresh,
  changed,
}: {
  detail: RefundDetail;
  api: RefundExecutionApi;
  services: AppServices;
  read(signal: AbortSignal): Promise<RefundDetail>;
  refresh(signal: AbortSignal): Promise<RefundDetail>;
  changed(): void;
}) {
  const access = useContext(AccessContext),
    intent = useMemo(() => createRefundExecutionIntent(), []),
    active = useRef(true),
    reader = useRef<AbortController | undefined>(undefined),
    [action, setAction] = useState<RefundExecution>(),
    [draft, setDraft] = useState(() => emptyOfflineRefund(detail)),
    [input, setInput] = useState<ConfirmInput & { stamp?: string }>({ checked: false, typed: "" }),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false),
    [notice, setNotice] = useState<string>();
  useEffect(() => {
    active.current = true;
    intent.activate();
    return () => {
      active.current = false;
      intent.close();
      reader.current?.abort();
    };
  }, [intent]);
  const actions = allowedRefundExecutions(detail, access),
    stamp = refundExecutionStamp(detail),
    confirmation = JSON.stringify([stamp, draft]),
    available = action !== undefined && actions.includes(action),
    visibleInput =
      available && !stale && input.stamp === confirmation ? input : { checked: false, typed: "" },
    txn = pendingRefundTxn(detail),
    offline = action === "record-offline",
    spec: ConfirmSpec = {
      title: action ? executionLabels[action] : "处理退款执行",
      description: offline
        ? "仅登记已实际完成的线下转账。请按银行事实核对金额、流水与回单，提交后将回收权益并记入退款。"
        : action === "confirm-not-accepted"
          ? "将实时查询微信；仅在渠道确认无此退款单时回到待执行。超时或请求失败不能视为未受理。"
          : action === "retry"
            ? "使用当前商户退款单号再次请求渠道，不新建退款单。结果以重新读取的实际状态为准。"
            : "将回收权益并向微信提交退款。提交成功不等于退款到账，渠道处理中须等待实际结果。",
      echo: [
        { label: "退款单", value: detail.requestNo },
        { label: "商家", value: detail.entity?.name ?? "未关联主体" },
        { label: "退款金额", value: moneyText(detail.amountFen), emphasis: true },
        { label: "审批版本", value: String(detail.approval.lockVersion) },
        { label: "原交易单号", value: detail.paymentTxn.channelTxnNo ?? "—" },
        ...(txn ? [{ label: "商户退款单号", value: txn.outRefundNo }] : []),
        ...(offline
          ? [
              { label: "收款户名", value: draft.payeeName || "—" },
              {
                label: "收款账户",
                value: draft.payeeAccount ? maskBankAccount(draft.payeeAccount) : "—",
              },
              { label: "银行流水", value: draft.bankSerialNo || "—" },
            ]
          : []),
      ],
      checkLabel: offline
        ? "我已核对实际线下转账、金额、收款账户与回单"
        : "我已核对原交易、退款金额与当前渠道状态",
      sensitive: { label: "请输入退款单号后4位", expected: detail.requestNo.slice(-4) },
      confirmText: action ? `确认${executionLabels[action]}` : "确认",
      danger: true,
    };
  const update = (key: keyof OfflineRefundDraft, value: string | null) => {
    setDraft((previous) => ({ ...previous, [key]: value }));
    setInput({ checked: false, typed: "" });
  };
  const close = () => {
    if (!intent.pending && !reader.current && !busy) setAction(undefined);
  };
  const reload = async (signal: AbortSignal) => {
    await refresh(signal);
    if (active.current && !signal.aborted) {
      setStale(false);
      setInput({ checked: false, typed: "" });
    }
  };
  const submit = async () => {
    if (
      !action ||
      !available ||
      stale ||
      busy ||
      reader.current ||
      intent.pending ||
      !confirmReady(spec, visibleInput)
    )
      return;
    let command;
    try {
      command = refundExecutionCommand(detail, action, draft);
    } catch {
      setNotice("请核对转账日期、流水、收款信息、回单及确认内容");
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const result = await intent.submit(
        action,
        [detail.refundRequestId, stamp, command],
        async (key, signal) => {
          try {
            // 执行typed body没有版本字段；写前真实GET核当前快照，不添加伪字段。
            const current = await read(signal);
            signal.throwIfAborted();
            if (
              refundExecutionStamp(current) !== stamp ||
              !allowedRefundExecutions(current, access).includes(command.action)
            )
              throw new RefundExecutionFailure("VERSION_CONFLICT", 409);
            await api.write(detail, command, key, signal);
          } catch (error) {
            if (refundExecutionNeedsReload(error) && active.current && !signal.aborted) {
              setStale(true);
              setInput({ checked: false, typed: "" });
              try {
                await reload(signal);
              } catch {
                /* 实际读取失败时保持停写。 */
              }
            }
            throw error;
          }
          if (!active.current || signal.aborted) return true;
          changed();
          setStale(true);
          try {
            await reload(signal);
          } catch {
            if (active.current && !signal.aborted)
              setNotice("操作已提交，当前详情未读回，请重新读取，不要重复提交");
          }
          return true;
        },
      );
      if (result && active.current) {
        setAction(undefined);
        setDraft(emptyOfflineRefund(detail));
        setInput({ checked: false, typed: "" });
      }
    } catch (error) {
      if (active.current) setNotice(refundExecutionError(error));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const retryRead = async () => {
    if (intent.pending || reader.current || busy) return;
    const controller = new AbortController();
    reader.current = controller;
    setBusy(true);
    try {
      await reload(controller.signal);
    } catch (error) {
      if (active.current && !controller.signal.aborted) setNotice(refundExecutionError(error));
    } finally {
      if (reader.current === controller) reader.current = undefined;
      if (active.current && !controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <>
      {notice && !action ? <Alert type="warning" title={notice} /> : null}
      {stale ? (
        <Alert
          type="warning"
          title="当前详情已失效，请重新读取并核对后处理"
          action={
            <Button disabled={busy} onClick={() => void retryRead()}>
              重新读取执行详情
            </Button>
          }
        />
      ) : null}
      {detail.actions.includes("record-offline") &&
      canAction(access, "finance.refund.execute") &&
      ((!detail.entity &&
        (detail.paymentTxn.channel === "bank_transfer" || access?.dataScope !== "all")) ||
        !canAction(access, "finance.receipt.confirm")) ? (
        <Alert
          type="info"
          title={
            !detail.entity && detail.paymentTxn.channel === "bank_transfer"
              ? "无主体对公收款缺少购买主体户名，当前不能登记线下退款，请先核对归属"
              : !detail.entity && access?.dataScope !== "all"
                ? "无主体退款回单仅允许全范围财务人员登记"
                : "登记线下退款还需本主体回单上传权限"
          }
        />
      ) : null}
      <Space wrap>
        {actions.map((next) => (
          <Button
            key={next}
            danger
            disabled={busy || stale}
            onClick={() => {
              setAction(next);
              setDraft(emptyOfflineRefund(detail));
              setInput({ checked: false, typed: "" });
              setNotice(undefined);
            }}
          >
            {executionLabels[next]}
          </Button>
        ))}
      </Space>
      <Modal
        open={!!action}
        title={spec.title}
        footer={null}
        closable={!busy}
        keyboard={!busy}
        mask={{ closable: !busy }}
        onCancel={close}
        destroyOnHidden
        styles={{ body: { maxHeight: "calc(100vh - 260px)", overflowY: "auto" } }}
      >
        {action ? (
          <>
            {offline ? (
              <>
                <label>
                  转账日期
                  <Input
                    aria-label="转账日期"
                    type="date"
                    value={draft.transferDate}
                    disabled={busy}
                    onChange={(event) => update("transferDate", event.target.value)}
                  />
                </label>
                <label>
                  银行流水号
                  <Input
                    aria-label="银行流水号"
                    value={draft.bankSerialNo}
                    maxLength={64}
                    disabled={busy}
                    onChange={(event) => update("bankSerialNo", event.target.value)}
                  />
                </label>
                <label>
                  收款户名
                  <Input
                    aria-label="收款户名"
                    value={draft.payeeName}
                    maxLength={100}
                    disabled={busy || detail.paymentTxn.channel === "bank_transfer"}
                    onChange={(event) => update("payeeName", event.target.value)}
                  />
                </label>
                <label>
                  收款银行
                  <Input
                    aria-label="收款银行"
                    value={draft.payeeBank}
                    maxLength={100}
                    disabled={busy}
                    onChange={(event) => update("payeeBank", event.target.value)}
                  />
                </label>
                <label>
                  收款账号
                  <Input.Password
                    aria-label="收款账号"
                    value={draft.payeeAccount}
                    maxLength={40}
                    inputMode="numeric"
                    autoComplete="off"
                    visibilityToggle={false}
                    disabled={busy}
                    onChange={(event) => update("payeeAccount", event.target.value)}
                  />
                </label>
                <label>
                  处理说明{detail.paymentTxn.channel === "wechat_jsapi" ? "（必填）" : "（可选）"}
                  <Input.TextArea
                    aria-label="线下退款说明"
                    value={draft.note}
                    maxLength={200}
                    disabled={busy}
                    onChange={(event) => update("note", event.target.value)}
                  />
                </label>
                <OfflineRefundUpload
                  key={`${detail.refundRequestId}:receipt`}
                  services={services}
                  entityId={detail.entity?.entityId ?? null}
                  disabled={busy}
                  onChange={(id) => update("receiptFileId", id)}
                />
              </>
            ) : null}
            <div style={offline ? { paddingTop: "var(--lyx-space-16)" } : undefined}>
              <ConfirmPanel
                spec={spec}
                input={visibleInput}
                onInputChange={(next) => {
                  if (available && !stale) setInput({ ...next, stamp: confirmation });
                }}
                submitting={busy}
                notice={notice ? { tone: "warning", message: notice } : undefined}
                onCancel={close}
                onConfirm={() => void submit()}
              />
            </div>
            {stale ? (
              <Button disabled={busy} onClick={() => void retryRead()}>
                重新读取当前详情
              </Button>
            ) : null}
          </>
        ) : null}
      </Modal>
    </>
  );
}
