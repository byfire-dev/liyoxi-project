import { Alert, Button, Input, Modal, Space } from "antd";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ConfirmPanel,
  confirmReady,
  type ConfirmInput,
  type ConfirmSpec,
} from "../../../components/ConfirmAction";
import { AccessContext } from "../../../lib/permissions";
import { adjustmentError, needsReconfirm, type AdjustmentApi, type AdjustmentCase } from "./api";
import { points } from "./detail";
import {
  allowedDecisions,
  approveReady,
  createDecisionIntent,
  decisionLabels,
  kindLabels,
  type Decision,
} from "./model";

export function AdjustmentDecision({
  value,
  api,
  refresh,
  changed,
}: {
  value: AdjustmentCase;
  api: AdjustmentApi;
  refresh: (signal: AbortSignal) => Promise<AdjustmentCase>;
  changed: () => void;
}) {
  const access = useContext(AccessContext),
    intent = useMemo(() => createDecisionIntent(), []),
    alive = useRef(true),
    readController = useRef<AbortController | undefined>(undefined),
    [action, setAction] = useState<Decision>(),
    [input, setInput] = useState<ConfirmInput & { stamp?: string }>({ checked: false, typed: "" }),
    [notes, setNotes] = useState({ approve: "", reject: "", withdraw: "" }),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState<string>(),
    [stale, setStale] = useState(false),
    current = value,
    stamp = JSON.stringify(value);
  useEffect(() => {
    alive.current = true;
    intent.activate();
    return () => {
      alive.current = false;
      intent.close();
      readController.current?.abort();
    };
  }, [intent]);
  const actions = allowedDecisions(current, access),
    note = action ? notes[action] : "",
    available =
      action !== undefined &&
      actions.includes(action) &&
      (action !== "approve" || approveReady(current)),
    spec: ConfirmSpec = {
      title: `${action ? decisionLabels[action] : "处理"}${kindLabels[current.kind]}`,
      description:
        action === "approve"
          ? "通过后由服务端在同一事务执行。请核对当前依据和效果预览。"
          : "此操作只处理当前申请，不代表其他关联申请已处理。",
      echo: [
        { label: "申请单", value: current.row.requestNo ?? "—" },
        { label: "商家", value: current.row.entity.name },
        { label: "版本", value: String(current.row.approval.lockVersion) },
        current.kind === "points_adjust"
          ? {
              label: current.row.direction === "increase" ? "增加积分" : "扣减积分",
              value: points(current.row.adjustPoints),
              emphasis: true,
            }
          : { label: "延长天数", value: `${current.row.days} 天`, emphasis: true },
        ...(current.kind === "subscription_extend" && current.row.preview
          ? [
              {
                label: "当前到期预览",
                value: `${current.row.preview.prevEndDate ?? "—"} → ${current.row.preview.newEndDate ?? "—"}`,
              },
            ]
          : []),
      ],
      checkLabel:
        action === "approve"
          ? current.kind === "points_adjust"
            ? "我已核对调整依据、数量与当前积分"
            : "我已核对延长效果预览与关联积分调整"
          : "我已核对申请与处理说明",
      confirmText: action ? `确认${decisionLabels[action]}` : "确认",
      danger: action === "reject",
    };
  const close = () => {
    if (!intent.pending && !readController.current && !busy) setAction(undefined);
  };
  const reload = async (signal: AbortSignal) => {
    await refresh(signal);
    if (alive.current && !signal.aborted) {
      setStale(false);
      setInput({ checked: false, typed: "" });
    }
  };
  const submit = async () => {
    if (
      !action ||
      !available ||
      stale ||
      intent.pending ||
      busy ||
      !confirmReady(spec, input.stamp === stamp ? input : { checked: false, typed: "" })
    )
      return;
    if (action === "reject" && !note.trim()) {
      setNotice("驳回说明不能为空");
      return;
    }
    setBusy(true);
    setNotice(undefined);
    const selected = action,
      fingerprint = [
        current.kind,
        current.row.approval.approvalId,
        selected,
        current.row.approval.lockVersion,
        note.trim(),
        selected === "approve"
          ? current.kind === "points_adjust"
            ? [current.row.requestNo, current.row.direction, current.row.adjustPoints]
            : [current.row.requestNo, current.row.days]
          : undefined,
      ];
    try {
      const outcome = await intent.submit(selected, fingerprint, async (key, signal) => {
        try {
          await api.decide(current, selected, note.trim(), key, signal);
        } catch (error) {
          if (needsReconfirm(error) && !signal.aborted && alive.current) {
            setStale(true);
            setInput({ checked: false, typed: "" });
            try {
              await reload(signal);
            } catch {
              /* 刷新失败仍停在失效状态，不允许重提。 */
            }
          }
          throw error;
        }
        // 写已成功即使随后的GET失败也不会重放写；只保留明确的重新读取入口。
        if (!signal.aborted && alive.current) {
          changed();
          setStale(true);
        }
        try {
          await reload(signal);
        } catch {
          if (alive.current && !signal.aborted)
            setNotice("操作已提交成功，当前详情读取失败，请重新读取；不要再次提交");
        }
        return true;
      });
      if (outcome && alive.current) {
        setInput({ checked: false, typed: "" });
        setAction(undefined);
      }
    } catch (error) {
      if (alive.current) setNotice(adjustmentError(error));
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const manualReload = async () => {
    if (intent.pending || readController.current || busy) return;
    const controller = new AbortController();
    readController.current = controller;
    setBusy(true);
    try {
      await reload(controller.signal);
    } catch (error) {
      if (alive.current && !controller.signal.aborted) setNotice(adjustmentError(error));
    } finally {
      if (readController.current === controller) readController.current = undefined;
      if (alive.current && !controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <>
      {notice && !action ? <Alert type="warning" title={notice} /> : null}
      {stale ? (
        <Alert
          type="warning"
          title="当前详情已失效，重新读取并核对后才可处理"
          action={
            <Button disabled={busy} onClick={() => void manualReload()}>
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
            danger={next === "reject"}
            disabled={busy || stale || (next === "approve" && !approveReady(current))}
            onClick={() => {
              setAction(next);
              setInput({ checked: false, typed: "" });
              setNotice(undefined);
            }}
          >
            {decisionLabels[next]}
          </Button>
        ))}
        {!actions.length ? (
          <p>当前无可执行动作；发起人与审批人必须不同，动作以服务端当前授权为准。</p>
        ) : null}
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
        {action && action !== "approve" ? (
          <label>
            <span>{action === "reject" ? "驳回说明（必填）" : "撤回说明（可选）"}</span>
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
          input={
            available && !stale && input.stamp === stamp ? input : { checked: false, typed: "" }
          }
          onInputChange={(next) => {
            if (available && !stale) setInput({ ...next, stamp });
          }}
          submitting={busy}
          notice={notice ? { tone: "warning", message: notice } : undefined}
          onCancel={close}
          onConfirm={() => void submit()}
        />
        {stale ? (
          <Button disabled={busy} onClick={() => void manualReload()}>
            重新读取当前详情
          </Button>
        ) : null}
      </Modal>
    </>
  );
}
