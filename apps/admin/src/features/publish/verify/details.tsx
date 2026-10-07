import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { Alert, InputNumber } from "antd";
import { useEffect, useRef, useState } from "react";
import { FormField } from "../../../components/FormField";
import { InfoList } from "../../../components/InfoList";
import { RejectDialog } from "../../../components/RejectDialog";
import type { QueueActionResult } from "../../../components/QueueWorkbench";
import { createIntent } from "../deliveries/model";
import {
  VerifyFailure,
  type VerifyDetail,
  type VerifyApi,
  type Template,
  type ApproveBody,
  type RejectBody,
} from "./api";
import { approveBody, rejectBody, submittedLinks } from "./model";
export interface Controller {
  approve(checked: readonly string[]): Promise<QueueActionResult>;
  reject(): Promise<QueueActionResult>;
}
export function VerifyDetails({
  detail,
  api,
  template,
  canVerify,
  refresh,
  register,
}: {
  detail: VerifyDetail;
  api: VerifyApi;
  template: Template | undefined;
  canVerify: boolean;
  refresh(): void;
  register(id: string, controller: Controller | null): void;
}) {
  const [count, setCount] = useState<number | null>(detail.link.reportedEpisodeCount),
    [intent] = useState(createIntent);
  const [rejection, setRejection] = useState(false),
    [reason, setReason] = useState(""),
    [note, setNote] = useState(""),
    [pending, setPending] = useState(false),
    [failure, setFailure] = useState<string>();
  const [reasons, setReasons] = useState<Awaited<ReturnType<VerifyApi["reasons"]>>>([]);
  const live = useRef(true),
    rejected = useRef<((result: QueueActionResult) => void) | null>(null);
  const mutable = canVerify && detail.isCurrentRound && detail.approval.status === "pending";
  const action = async (
    kind: "approve" | "reject",
    body: ApproveBody | RejectBody,
  ): Promise<QueueActionResult> => {
    if (!live.current || !mutable || !detail.actions.includes(kind))
      return { outcome: "failed", message: "当前事项已变化，请重新核对" };
    let started = false;
    try {
      const result = await intent(
        {
          id: detail.launchSubmissionId,
          version: detail.approval.lockVersion,
          round: detail.roundNo,
          kind,
          body,
        },
        async (key) => {
          started = true;
          setPending(true);
          setFailure(undefined);
          if (kind === "approve" && "lockVersion" in body)
            await api.approve(detail.launchSubmissionId, body, key);
          else if (kind === "reject" && "reasonCodes" in body)
            await api.reject(detail.launchSubmissionId, body, key);
          // C50 回放数据不写入详情；以真实 GET 核对处理结果，随后刷新队列与下一条。
          return api.detail(detail.launchSubmissionId);
        },
      );
      if (!live.current || !result) return { outcome: "failed", message: "当前事项已切换" };
      refresh();
      return { outcome: "done", message: kind === "approve" ? "链接已通过核验" : "链接已退回修改" };
    } catch (error) {
      if (!live.current) return { outcome: "failed", message: "当前事项已切换" };
      if (
        error instanceof VerifyFailure &&
        [
          "APPROVAL_NOT_PENDING",
          "VERSION_CONFLICT",
          "STATE_NOT_ALLOWED",
          "PRECONDITION_CHANGED",
          "CONFIRM_MISMATCH",
          "CHECKLIST_VERSION_STALE",
        ].includes(error.code ?? "")
      ) {
        refresh();
        return { outcome: "conflict" };
      }
      const message = error instanceof Error ? error.message : "没有处理成功，请重试";
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
    register(detail.launchSubmissionId, {
      approve: (checked) => {
        if (!live.current || pending || rejection)
          return Promise.resolve({ outcome: "failed", message: "当前事项正在处理" });
        const body = approveBody(detail, count, template, checked);
        return body
          ? action("approve", body)
          : Promise.resolve({
              outcome: "failed",
              message: "请核对全部清单，并填写不超过填报集数的实际核验集数",
            });
      },
      reject: () =>
        new Promise((resolve) => {
          if (!live.current || !mutable || pending || rejected.current) {
            resolve({ outcome: "failed", message: "当前事项正在处理或已变化" });
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
    return () => register(detail.launchSubmissionId, null);
  });
  const cancel = () => {
    if (pending) return;
    setRejection(false);
    rejected.current?.({ outcome: "failed", message: "已取消驳回" });
    rejected.current = null;
  };
  const body = rejectBody(reason, note);
  return (
    <div className="lyx-verify-details">
      <InfoList
        labelWidth={84}
        items={[
          { label: "门店", value: detail.store.storeName ?? "未命名门店" },
          {
            label: "短剧",
            value: `${detail.orderItem.dramaTitle} · ${detail.orderItem.episodeCount} 集`,
          },
          {
            label: "发布账号",
            value: `${detail.account.accountName} · ${detail.account.accountUid}`,
          },
          { label: "平台", value: detail.account.platform === "douyin" ? "抖音" : "视频号" },
          { label: "实际上线", value: detail.link.actualLaunchDate },
          { label: "填报集数", value: `${detail.link.reportedEpisodeCount} 集` },
          { label: "提交时间", value: date.dateTime(detail.link.submittedAt) },
        ]}
      />
      <section>
        <h3 className="lyx-section-title">商家提交链接</h3>
        <div className="lyx-verify-links">
          {submittedLinks(detail).map((link) => (
            <div key={link.label}>
              <span>{link.label}</span>
              {link.safe ? (
                <a href={link.url} target="_blank" rel="noopener noreferrer">
                  {link.url}
                </a>
              ) : (
                <span>{link.url}（链接不可打开）</span>
              )}
            </div>
          ))}
        </div>
      </section>
      <FormField label="实际核验集数">
        {(field) => (
          <InputNumber
            {...field}
            aria-label="实际核验集数"
            value={mutable ? count : detail.verifiedEpisodeCount}
            min={1}
            max={detail.link.reportedEpisodeCount}
            precision={0}
            disabled={!mutable || pending || rejection}
            onChange={(value) => setCount(value)}
          />
        )}
      </FormField>
      {detail.isPartialGoesLive ? (
        <Alert type="info" title="服务端认定允许部分集上线；核验集数按实际可播放集数填写" />
      ) : null}
      <InfoList
        labelWidth={110}
        items={[
          {
            label: "预计使用期起日",
            value:
              detail.projectedUsageStartDate ??
              detail.orderItem.usageStartDate ??
              "待核验通过后确定",
          },
          { label: "使用期止日", value: detail.orderItem.usageEndDate },
        ]}
      />
      {detail.rounds.length > 1 ? (
        <section>
          <h3 className="lyx-section-title">历次核验记录</h3>
          <div className="lyx-verify-rounds">
            {detail.rounds.map((round) => (
              <p key={round.launchSubmissionId}>
                第 {round.roundNo} 轮 ·{" "}
                {round.result === "passed_partial"
                  ? "部分集数通过"
                  : round.result === "withdrawn"
                    ? "已撤回"
                    : round.result === "revoked"
                      ? "已撤销"
                      : round.result === "passed"
                        ? "已通过"
                        : round.result === "returned"
                          ? "已退回"
                          : "待核验"}{" "}
                · {date.dateTime(round.submittedAt)}
                {round.decisionNote ? ` · ${round.decisionNote}` : ""}
              </p>
            ))}
          </div>
        </section>
      ) : null}
      {failure ? <Alert type="error" title={failure} /> : null}
      {rejection ? (
        <RejectDialog
          title="退回链接修改"
          context={`${detail.account.accountName} · 第 ${detail.roundNo} 轮`}
          reasons={reasons.map((item) => ({ value: item.code, label: item.name }))}
          reason={reason}
          note={note}
          notePlaceholder="说明需要补正的链接或集数"
          noteMaxLength={200}
          onReasonChange={setReason}
          onNoteChange={setNote}
          pending={pending}
          canSubmit={!!body && reasons.some((item) => item.code === reason)}
          error={failure}
          onCancel={cancel}
          onSubmit={() => {
            if (!body || pending) return;
            void action("reject", body).then((result) => {
              if (!live.current) return;
              if (result.outcome !== "failed") {
                setRejection(false);
                rejected.current?.(result);
                rejected.current = null;
              }
            });
          }}
        />
      ) : null}
    </div>
  );
}
