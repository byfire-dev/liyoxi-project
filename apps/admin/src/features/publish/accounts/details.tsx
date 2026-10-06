import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { Alert, Button, Input, Radio, Select } from "antd";
import { useEffect, useRef, useState } from "react";
import { CompareTable } from "../../../components/CompareTable";
import { FormField } from "../../../components/FormField";
import { InfoList } from "../../../components/InfoList";
import { RejectDialog } from "../../../components/RejectDialog";
import type { QueueActionResult } from "../../../components/QueueWorkbench";
import { AccountFailure, type AccountDetail, type AccountsApi, type Template } from "./api";
import {
  accountTypes,
  approveBody,
  createDecisionIntent,
  fieldLabels,
  fields,
  initialDraft,
  rejectBody,
  type AccountType,
} from "./model";
export interface Controller {
  approve(checked: readonly string[]): Promise<QueueActionResult>;
  reject(): Promise<QueueActionResult>;
}
export function AccountDetails({
  detail,
  api,
  template,
  canVerify,
  refresh,
  register,
}: {
  detail: AccountDetail;
  api: AccountsApi;
  template: Template | undefined;
  canVerify: boolean;
  refresh(): void;
  register(id: string, controller: Controller | null): void;
}) {
  const [draft, setDraft] = useState(() => initialDraft(detail)),
    [intent] = useState(createDecisionIntent);
  const [rejection, setRejection] = useState(false),
    [reason, setReason] = useState(""),
    [note, setNote] = useState(""),
    [pending, setPending] = useState(false),
    [failure, setFailure] = useState<string>();
  const [reasons, setReasons] = useState<Awaited<ReturnType<AccountsApi["reasons"]>>>([]);
  const live = useRef(true),
    rejected = useRef<((result: QueueActionResult) => void) | null>(null);
  const type: AccountType =
    draft.account_type.recognized === "enterprise"
      ? "enterprise"
      : draft.account_type.recognized === "personal"
        ? "personal"
        : "none";
  const mutable =
    canVerify && detail.actions.some((action) => action === "approve" || action === "reject");
  const action = async (
    kind: "approve" | "reject",
    body: Parameters<AccountsApi["approve"]>[1] | Parameters<AccountsApi["reject"]>[1],
  ): Promise<QueueActionResult> => {
    if (!live.current || !mutable || !detail.actions.includes(kind))
      return { outcome: "failed", message: "当前事项已变化，请重新核对" };
    let started = false;
    try {
      const result = await intent(
        { id: detail.channelAccountSubmissionId, kind, body },
        async (key) => {
          if (!live.current) return null;
          started = true;
          setPending(true);
          setFailure(undefined);
          return kind === "approve" && "lockVersion" in body
            ? api.approve(detail.channelAccountSubmissionId, body, key)
            : kind === "reject" && "reasonCode" in body
              ? api.reject(detail.channelAccountSubmissionId, body, key)
              : null;
        },
      );
      if (!live.current || result === null) return { outcome: "failed", message: "当前事项已切换" };
      // 正常响应与 C50 replayed 的可空签名均不进入详情；由 GET 刷新事实与下一条。
      refresh();
      return {
        outcome: "done",
        message: kind === "approve" ? "账号已通过核验" : "账号已驳回，请商家补正",
      };
    } catch (error) {
      if (!live.current) return { outcome: "failed", message: "当前事项已切换" };
      const message = error instanceof Error ? error.message : "没有处理成功，请重试";
      if (
        error instanceof AccountFailure &&
        [
          "APPROVAL_NOT_PENDING",
          "VERSION_CONFLICT",
          "STATE_NOT_ALLOWED",
          "PRECONDITION_CHANGED",
          "CONFIRM_MISMATCH",
        ].includes(error.code ?? "")
      ) {
        refresh();
        return { outcome: "conflict" };
      }
      if (error instanceof AccountFailure && error.code === "CHECKLIST_VERSION_STALE") refresh();
      setFailure(message);
      return { outcome: "failed", message };
    } finally {
      if (started && live.current) setPending(false);
    }
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      rejected.current?.({ outcome: "failed", message: "当前事项已切换" });
      rejected.current = null;
    };
  }, []);
  useEffect(() => {
    register(detail.channelAccountSubmissionId, {
      approve: (checked) => {
        if (!live.current || pending || rejection)
          return Promise.resolve({ outcome: "failed", message: "当前事项正在处理" });
        const body = approveBody(detail, draft, type, template, checked);
        return body
          ? action("approve", body)
          : Promise.resolve({
              outcome: "failed",
              message: "请核对全部五项，选择账号类型；企业号的认证主体须与商家主体一致",
            });
      },
      reject: () =>
        new Promise((resolve) => {
          if (!live.current || pending || rejected.current) {
            resolve({ outcome: "failed", message: "当前事项正在处理" });
            return;
          }
          if (!rejectBody(draft, type, "pending", "pending")) {
            resolve({ outcome: "failed", message: "请先完成五项人工核对，再填写驳回原因" });
            return;
          }
          rejected.current = resolve;
          setReason("");
          setNote("");
          setFailure(undefined);
          setRejection(true);
          void api
            .reasons()
            .then((rows) => {
              if (live.current) setReasons(rows);
            })
            .catch((error: unknown) => {
              if (live.current)
                setFailure(error instanceof Error ? error.message : "原因没有加载成功，请重试");
            });
        }),
    });
    return () => register(detail.channelAccountSubmissionId, null);
  });
  const cancel = () => {
    if (pending) return;
    setRejection(false);
    rejected.current?.({ outcome: "failed", message: "已取消驳回" });
    rejected.current = null;
  };
  const submittedReject = rejectBody(draft, type, reason, note);
  return (
    <div className="lyx-account-details">
      <InfoList
        labelWidth={84}
        items={[
          { label: "门店", value: detail.account.store.storeName ?? "未命名门店" },
          { label: "商家主体", value: detail.account.store.entityName ?? "未填写" },
          { label: "平台", value: detail.filled.platform === "douyin" ? "抖音" : "视频号" },
          {
            label: "提交轮次",
            value: `第 ${detail.roundNo} 轮 · ${date.dateTime(detail.submittedAt)}`,
          },
        ]}
      />
      <div className="lyx-account-comparison">
        <section>
          <h3 className="lyx-section-title">主页截图</h3>
          <div className="lyx-account-images">
            {detail.screenshots.map((image, index) => (
              <a key={image.fileId} href={image.url} target="_blank" rel="noopener noreferrer">
                <img src={image.url} alt={`账号主页截图 ${index + 1}`} />
              </a>
            ))}
          </div>
          <Button onClick={refresh}>刷新截图地址</Button>
        </section>
        <section>
          <h3 className="lyx-section-title">人工核对（逐项记录）</h3>
          <CompareTable
            ariaLabel="账号人工核对"
            rows={fields.map((field) => {
              const row = detail.compareRows.find((entry) => entry.field === field),
                entry = draft[field];
              return {
                key: field,
                label: fieldLabels[field],
                value:
                  field === "account_type"
                    ? accountTypes[detail.filled.accountType]
                    : row?.filled || "—",
                result: (
                  <div className="lyx-account-compare-input">
                    <FormField
                      label={`${fieldLabels[field]}识别值`}
                      value={entry.recognized}
                      maxLength={field === "account_type" ? undefined : 100}
                    >
                      {(props) =>
                        field === "account_type" ? (
                          <Select
                            {...props}
                            aria-label="账号类型识别值"
                            value={entry.recognized || undefined}
                            placeholder="选择截图中的账号类型"
                            disabled={!mutable || pending}
                            options={Object.entries(accountTypes).map(([value, label]) => ({
                              value,
                              label,
                            }))}
                            onChange={(recognized) =>
                              setDraft((old) => ({
                                ...old,
                                [field]: { ...old[field], recognized },
                                ...(recognized !== "enterprise"
                                  ? {
                                      cert_subject_name: {
                                        ...old.cert_subject_name,
                                        recognized: "",
                                      },
                                    }
                                  : {}),
                              }))
                            }
                          />
                        ) : (
                          <Input
                            {...props}
                            value={entry.recognized}
                            maxLength={100}
                            disabled={
                              !mutable ||
                              pending ||
                              (field === "cert_subject_name" && type !== "enterprise")
                            }
                            placeholder={
                              field === "cert_subject_name" && type !== "enterprise"
                                ? "非企业号不登记认证主体"
                                : "按截图人工填写"
                            }
                            onChange={(event) =>
                              setDraft((old) => ({
                                ...old,
                                [field]: { ...old[field], recognized: event.target.value },
                              }))
                            }
                          />
                        )
                      }
                    </FormField>
                    <Radio.Group
                      aria-label={`${fieldLabels[field]}核对结论`}
                      value={entry.match}
                      disabled={!mutable || pending}
                      onChange={(event) =>
                        setDraft((old) => ({
                          ...old,
                          [field]: { ...old[field], match: event.target.value === true },
                        }))
                      }
                      options={[
                        { value: true, label: "一致" },
                        { value: false, label: "不一致" },
                      ]}
                    />
                  </div>
                ),
              };
            })}
          />
        </section>
      </div>
      {detail.otherRounds.length ? (
        <section>
          <h3 className="lyx-section-title">其他提交轮次</h3>
          {detail.otherRounds.map((round) => (
            <p key={round.channelAccountSubmissionId}>
              第 {round.roundNo} 轮 · {date.dateTime(round.submittedAt)} ·{" "}
              {round.approval.status === "approved"
                ? "已通过"
                : round.approval.status === "rejected"
                  ? "已驳回"
                  : "已结束"}
            </p>
          ))}
        </section>
      ) : null}
      {detail.approval.decisionNote ? (
        <Alert
          type={detail.approval.status === "rejected" ? "error" : "info"}
          title={detail.approval.decisionNote}
        />
      ) : null}
      {rejection ? (
        <RejectDialog
          title="驳回账号核验"
          context={`${detail.filled.accountName} · 第 ${detail.roundNo} 轮`}
          reasons={reasons.map((row) => ({ value: row.code, label: row.name }))}
          reason={reason}
          note={note}
          notePlaceholder="请写明需要商家补正的内容"
          noteMaxLength={200}
          onReasonChange={setReason}
          onNoteChange={setNote}
          pending={pending}
          canSubmit={submittedReject !== null && reasons.some((row) => row.code === reason)}
          error={failure}
          onCancel={cancel}
          onSubmit={() => {
            if (!submittedReject || !live.current) return;
            void action("reject", submittedReject).then((result) => {
              if (!live.current || result.outcome === "failed") return;
              setRejection(false);
              rejected.current?.(result);
              rejected.current = null;
            });
          }}
        />
      ) : null}
    </div>
  );
}
