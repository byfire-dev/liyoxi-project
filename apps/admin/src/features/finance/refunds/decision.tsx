import { Alert, Button, Input, Modal, Space } from "antd";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ConfirmPanel,
  confirmReady,
  type ConfirmInput,
  type ConfirmSpec,
} from "../../../components/ConfirmAction";
import { AccessContext } from "../../../lib/permissions";
import { moneyText } from "../payments/model";
import type { RefundDetail } from "./api";
import { refundDecisionError, refundNeedsReconfirm, type RefundDecisionsApi } from "./decision-api";
import {
  createRefundDecisionIntent,
  refundDecisionCommand,
  refundDecisionLabels,
  refundDecisions,
  type RefundDecision,
} from "./decision-model";
export function RefundDecisionPanel({
  detail,
  api,
  refresh,
  changed,
}: {
  detail: RefundDetail;
  api: RefundDecisionsApi;
  refresh: (signal: AbortSignal) => Promise<RefundDetail>;
  changed: () => void;
}) {
  const access = useContext(AccessContext),
    intent = useMemo(() => createRefundDecisionIntent(), []),
    active = useRef(true),
    reader = useRef<AbortController | undefined>(undefined),
    [action, setAction] = useState<RefundDecision>(),
    [notes, setNotes] = useState({ approve: "", reject: "", withdraw: "", void: "" }),
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
  const actions = refundDecisions(detail, access),
    stamp = JSON.stringify(detail),
    note = action ? notes[action] : "",
    available = action !== undefined && actions.includes(action) && !stale,
    visibleInput = available && input.stamp === stamp ? input : { checked: false, typed: "" },
    spec: ConfirmSpec = {
      title: action ? `${refundDecisionLabels[action]}退款申请` : "处理退款申请",
      description:
        action === "approve"
          ? "审批通过只进入待执行，不表示已退款。请核对实际规则、核算依据和金额。"
          : action === "void"
            ? "仅作废服务端允许的已审批未执行申请；不能恢复已回收权益或抹除已发生退款。"
            : "仅处理当前退款申请，不触发渠道打款。",
      echo: [
        { label: "退款单", value: detail.requestNo },
        { label: "商家", value: detail.entity?.name ?? "未关联主体" },
        { label: "退款金额", value: moneyText(detail.amountFen), emphasis: true },
        { label: "核算规则", value: detail.ruleText },
        { label: "审批版本", value: String(detail.approval.lockVersion) },
      ],
      checkLabel:
        action === "approve" ? "我已核对退款规则、核算依据与金额" : "我已核对申请、金额与处理说明",
      confirmText: action ? `确认${refundDecisionLabels[action]}` : "确认",
      danger: action === "reject" || action === "void",
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
      intent.pending ||
      reader.current ||
      busy ||
      !confirmReady(spec, visibleInput)
    )
      return;
    if ((action === "reject" || action === "void") && !note.trim()) {
      setNotice("处理说明不能为空");
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      const command = refundDecisionCommand(detail, action, note),
        selected = action;
      const outcome = await intent.submit(command, async (key, signal) => {
        try {
          await api.decide(detail, selected, note, key, signal);
        } catch (error) {
          if (refundNeedsReconfirm(error) && active.current && !signal.aborted) {
            setStale(true);
            setInput({ checked: false, typed: "" });
            try {
              await reload(signal);
            } catch {
              /* 旧详情失效，保持停写直到实际读取成功。 */
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
            setNotice("操作已提交成功，详情暂未读回，请重新读取，不要再次提交");
        }
        return true;
      });
      if (outcome && active.current) {
        setAction(undefined);
        setInput({ checked: false, typed: "" });
      }
    } catch (error) {
      if (active.current) setNotice(refundDecisionError(error));
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
      if (active.current && !controller.signal.aborted) setNotice(refundDecisionError(error));
    } finally {
      if (reader.current === controller) reader.current = undefined;
      if (active.current && !controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <>
      {detail.source === "staging_probe" ? (
        <Alert type="info" title="此为系统退款，仅显示实际状态，不提供人工审批决定" />
      ) : null}
      {notice && !action ? <Alert type="warning" title={notice} /> : null}
      {stale ? (
        <Alert
          type="warning"
          title="当前详情已失效，重新读取后才可继续处理"
          action={
            <Button disabled={busy} onClick={() => void retryRead()}>
              重新读取
            </Button>
          }
        />
      ) : null}
      <Space wrap>
        {actions.map((next) => (
          <Button
            key={next}
            type={next === "approve" ? "primary" : "default"}
            danger={next === "reject" || next === "void"}
            disabled={busy || stale}
            onClick={() => {
              setAction(next);
              setInput({ checked: false, typed: "" });
              setNotice(undefined);
            }}
          >
            {refundDecisionLabels[next]}
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
      >
        {action ? (
          <label>
            <span>
              {action === "reject" || action === "void" ? "处理说明（必填）" : "处理说明（可选）"}
            </span>
            <Input.TextArea
              value={note}
              maxLength={200}
              showCount
              disabled={busy}
              onChange={(event) => {
                setNotes({ ...notes, [action]: event.target.value });
                setInput({ checked: false, typed: "" });
              }}
            />
          </label>
        ) : null}
        <ConfirmPanel
          spec={spec}
          input={visibleInput}
          onInputChange={(next) => {
            if (available) setInput({ ...next, stamp });
          }}
          submitting={busy}
          notice={notice ? { tone: "warning", message: notice } : undefined}
          onCancel={close}
          onConfirm={() => void submit()}
        />
        {stale ? (
          <Button disabled={busy} onClick={() => void retryRead()}>
            重新读取当前详情
          </Button>
        ) : null}
      </Modal>
    </>
  );
}
