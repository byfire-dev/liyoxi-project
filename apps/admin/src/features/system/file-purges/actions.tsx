import {
  FileEraseBodySchema,
  FileRestoreBodySchema,
  PurgeApproveBodySchema,
  PurgeRejectBodySchema,
} from "@liyoxi/contract";
import { Alert, Button, Input, Modal } from "antd";
import { useState } from "react";
import {
  ConfirmAction,
  type ConfirmResult,
  type ConfirmSpec,
} from "../../../components/ConfirmAction";
import { FormField } from "../../../components/FormField";
import { hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import { PurgeFailure, type PurgeApi } from "./api";
import {
  byteCount,
  purgeActionAllowed,
  purgeBody,
  referenceSummaries,
  safePurgeText,
  type PurgeAction,
} from "./model";
export const purgeActionTitle = (kind: PurgeAction["kind"]) =>
  ({ approve: "放行", reject: "驳回", restore: "恢复", erase: "彻底删除" })[kind];
export function purgeConfirmSpec(action: PurgeAction, text: string): ConfirmSpec {
  const run = action.kind === "approve" || action.kind === "reject";
  return {
    title: purgeActionTitle(action.kind),
    description:
      action.kind === "approve"
        ? "只放行本次清单，等待任务进程逐文件复核后执行；放行不代表文件已清除。"
        : action.kind === "reject"
          ? "驳回本次运行；候选文件将在后续每日扫描重新评估。"
          : action.kind === "restore"
            ? "从对象存储历史版本恢复文件，实际结果以服务端复核为准。"
            : "不可撤销：删除此文件的全部历史版本。存在在用引用或法定保留限制时，服务端会拒绝。",
    echo: [
      ...(run
        ? [
            { label: "运行 ID", value: action.row.purgeRunId },
            { label: "候选文件数", value: String(action.row.candidateCount), emphasis: true },
            { label: "候选字节数", value: byteCount(action.row.candidateBytes), emphasis: true },
          ]
        : [
            { label: "文件 ID", value: action.row.fileId },
            { label: "文件分类", value: action.row.category },
          ]),
      { label: action.kind === "approve" ? "备注" : "原因", value: safePurgeText(text, 500) },
    ],
    sensitive:
      action.kind === "erase"
        ? { label: "请再次输入完整文件 ID", expected: action.row.fileId }
        : undefined,
    checkLabel: "我已核对目标与操作影响",
    confirmText: "确认操作",
    danger: action.kind === "erase" || action.kind === "reject",
  };
}
export async function submitPurgeAction(
  api: PurgeApi,
  action: PurgeAction,
  text: string,
  key: string,
) {
  const body = purgeBody(action, text);
  if (action.kind === "approve")
    return api.approve(action.row.purgeRunId, PurgeApproveBodySchema.parse(body), key);
  if (action.kind === "reject")
    return api.reject(action.row.purgeRunId, PurgeRejectBodySchema.parse(body), key);
  if (action.kind === "restore")
    return api.restore(action.row.fileId, FileRestoreBodySchema.parse(body), key);
  return api.erase(action.row.fileId, FileEraseBodySchema.parse(body), key);
}
export function PurgeActionDialog({
  action,
  access,
  api,
  refresh,
  onClose,
  onDone,
}: {
  action: PurgeAction;
  access: AccessSnapshot | null;
  api: PurgeApi;
  refresh(): Promise<unknown>;
  onClose(): void;
  onDone(message: string): void;
}) {
  const [text, setText] = useState(""),
    [confirming, setConfirming] = useState(false),
    [notice, setNotice] = useState<string>(),
    [refs, setRefs] = useState<{ refType: string; refId: string }[]>([]);
  if (!purgeActionAllowed(access, action)) return null;
  const confirm = async ({
    idempotencyKey,
  }: {
    idempotencyKey: string;
  }): Promise<ConfirmResult> => {
    try {
      await submitPurgeAction(api, action, text, idempotencyKey);
      await refresh();
      return { outcome: "done" };
    } catch (failure) {
      if (failure instanceof PurgeFailure && failure.code === "FILE_IN_USE") {
        setRefs(referenceSummaries(failure.details));
        setNotice("文件仍被使用，请先在业务侧处理这些引用后重新核对。");
        setConfirming(false);
        await refresh();
      } else if (
        failure instanceof PurgeFailure &&
        failure.status === 409 &&
        failure.code !== "IDEMPOTENCY_IN_PROGRESS"
      ) {
        await refresh();
        onClose();
        onDone("当前事实已变化，列表已刷新，请重新核对后操作");
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
      spec={purgeConfirmSpec(action, text)}
      action={`purge-${action.kind}`}
      onConfirm={confirm}
      onCancel={onClose}
      onDone={() => {
        onClose();
        onDone(
          action.kind === "approve"
            ? "已放行，等待任务进程执行；列表已刷新"
            : "操作成功，已刷新服务端实际状态",
        );
      }}
    />
  ) : (
    <Modal
      open
      title={purgeActionTitle(action.kind)}
      footer={null}
      onCancel={onClose}
      destroyOnHidden
    >
      <p className="lyx-confirm__desc">{purgeConfirmSpec(action, text).description}</p>
      <FormField label={action.kind === "approve" ? "备注（可选）" : "原因（必填）"}>
        {(field) => (
          <Input.TextArea
            {...field}
            rows={3}
            value={text}
            maxLength={action.kind === "erase" ? 1000 : 400}
            onChange={(event) => setText(event.target.value)}
          />
        )}
      </FormField>
      <p>
        {action.kind === "approve"
          ? "备注至多 200 字。"
          : action.kind === "erase"
            ? "请填写 10–500 字原因。"
            : "请填写 5–200 字原因。"}
      </p>
      {notice ? <Alert type="warning" title={notice} /> : null}
      {refs.length ? (
        <ul aria-label="在用引用摘要">
          {refs.map((ref) => (
            <li key={`${ref.refType}:${ref.refId}`}>
              {safePurgeText(ref.refType)} · {ref.refId}
              {["drama", "drama_copyright"].includes(ref.refType) &&
              hasModuleLevel(access, "drama") ? (
                <a className="lyx-link" href={`/dramas/${ref.refId}`}>
                  查看短剧
                </a>
              ) : (
                <span> · 关联入口受限</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="lyx-confirm__footer">
        <Button size="large" onClick={onClose}>
          取消
        </Button>
        <Button
          size="large"
          type="primary"
          danger={action.kind === "erase" || action.kind === "reject"}
          onClick={() => {
            try {
              purgeBody(action, text);
              setNotice(undefined);
              setConfirming(true);
            } catch {
              setNotice(
                action.kind === "approve"
                  ? "备注至多 200 字"
                  : action.kind === "erase"
                    ? "原因须为 10–500 字"
                    : "原因须为 5–200 字",
              );
            }
          }}
        >
          继续确认
        </Button>
      </div>
    </Modal>
  );
}
