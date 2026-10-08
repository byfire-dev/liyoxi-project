import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { Alert, Button, Input, Modal } from "antd";
import { useState } from "react";
import {
  ConfirmAction,
  type ConfirmResult,
  type ConfirmSpec,
} from "../../../components/ConfirmAction";
import { FormField } from "../../../components/FormField";
import { type AccessSnapshot } from "../../../lib/permissions";
import { FlowOpsFailure, type FlowOpsApi } from "./api";
import { actionAllowed, reasonValid, safeText, statusLabel, type FlowAction } from "./model";
export function actionTitle(kind: FlowAction["kind"]): string {
  return kind === "reschedule"
    ? "重新排期"
    : kind === "cancel"
      ? "标记为不再需要"
      : kind === "retry-outbox"
        ? "重投死信"
        : "重置死信回调";
}
export function actionSpec(action: FlowAction, text: string): ConfirmSpec {
  const echo = [
    {
      label: "当前状态",
      value: statusLabel("status" in action.row ? action.row.status : action.row.processState),
    },
  ];
  if ("timerId" in action.row)
    echo.push(
      { label: "定时器 ID", value: action.row.timerId },
      { label: "规则", value: action.row.kind },
      { label: "到期时间", value: appDateTimeFormat.dateTimeFull(action.row.fireAt) },
    );
  else if ("outboxEventId" in action.row)
    echo.push(
      { label: "事件 ID", value: action.row.outboxEventId },
      { label: "订阅者", value: action.row.subscriber },
      { label: "事件类型", value: action.row.event.eventType },
    );
  else
    echo.push(
      { label: "收件 ID", value: action.row.webhookEventId },
      { label: "来源", value: action.row.provider },
      { label: "事件类型", value: action.row.eventType },
    );
  if (text)
    echo.push({ label: action.kind === "cancel" ? "原因" : "备注", value: safeText(text, 200) });
  return {
    title: actionTitle(action.kind),
    description:
      action.kind === "reschedule"
        ? "只恢复为待触发，不修改到期时间；已到期记录将在下一轮扫描执行。"
        : action.kind === "cancel"
          ? "取消后不再执行该定时器，并释放其去重键。"
          : action.kind === "retry-outbox"
            ? "只重新投递给本次显示的订阅者，不新建出站事件。"
            : "只将该死信恢复为待处理，由收件箱再次处理，不新建收件事件。",
    echo,
    checkLabel: "我已核对目标与操作影响",
    confirmText: "确认操作",
    danger: action.kind === "cancel",
  };
}
export async function submitFlowAction(
  api: FlowOpsApi,
  action: FlowAction,
  text: string,
  key: string,
): Promise<void> {
  const note = text.trim(),
    body = note ? { note } : {};
  if (!reasonValid(action.kind, text))
    throw new Error(action.kind === "cancel" ? "原因须为 5–200 字" : "备注至多 200 字");
  if (action.kind === "reschedule") await api.reschedule(action.row.timerId, body, key);
  else if (action.kind === "cancel") await api.cancel(action.row.timerId, { reason: note }, key);
  else if (action.kind === "retry-outbox")
    await api.retryOutbox(
      action.row.outboxEventId,
      { subscriber: action.row.subscriber, ...body },
      key,
    );
  else await api.retryWebhook(action.row.webhookEventId, body, key);
}
export function FlowActionDialog({
  action,
  access,
  api,
  refresh,
  onClose,
  onDone,
}: {
  action: FlowAction;
  access: AccessSnapshot | null;
  api: FlowOpsApi;
  refresh(): Promise<unknown>;
  onClose(): void;
  onDone(message: string): void;
}) {
  const [text, setText] = useState(""),
    [confirming, setConfirming] = useState(false),
    [notice, setNotice] = useState<string>();
  if (!actionAllowed(access, action)) return null;
  const onConfirm = async ({
    idempotencyKey,
  }: {
    idempotencyKey: string;
  }): Promise<ConfirmResult> => {
    try {
      await submitFlowAction(api, action, text, idempotencyKey);
      await refresh();
      return { outcome: "done" };
    } catch (failure) {
      if (
        failure instanceof FlowOpsFailure &&
        ["STATE_NOT_ALLOWED", "NOT_FOUND", "PRECONDITION_CHANGED"].includes(failure.code)
      ) {
        await refresh();
        onClose();
        onDone("记录状态已变化，列表已刷新，请重新核对后操作");
      }
      return {
        outcome: "failed",
        message: failure instanceof Error ? failure.message : "没有操作成功，请重试",
      };
    }
  };
  return confirming ? (
    <ConfirmAction
      open
      spec={actionSpec(action, text)}
      action={`flow-${action.kind}`}
      onConfirm={onConfirm}
      onDone={() => {
        onClose();
        onDone("操作成功，已刷新真实状态");
      }}
      onCancel={onClose}
    />
  ) : (
    <Modal open title={actionTitle(action.kind)} footer={null} onCancel={onClose} destroyOnHidden>
      <p>
        {"timerId" in action.row
          ? action.row.kind
          : "outboxEventId" in action.row
            ? `${action.row.event.eventType} · ${action.row.subscriber}`
            : `${action.row.provider} · ${action.row.eventType}`}
      </p>
      <FormField label={action.kind === "cancel" ? "原因（必填）" : "备注（可选）"}>
        {(field) => (
          <Input.TextArea
            {...field}
            value={text}
            rows={3}
            maxLength={400}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </FormField>
      <p>{action.kind === "cancel" ? "请填写 5–200 字原因。" : "备注至多 200 字。"}</p>
      {notice ? <Alert type="error" title={notice} /> : null}
      <div className="lyx-flow-dialog-footer">
        <Button onClick={onClose}>取消</Button>
        <Button
          type="primary"
          onClick={() => {
            if (!reasonValid(action.kind, text))
              setNotice(action.kind === "cancel" ? "原因须为 5–200 字" : "备注至多 200 字");
            else setConfirming(true);
          }}
        >
          继续确认
        </Button>
      </div>
    </Modal>
  );
}
