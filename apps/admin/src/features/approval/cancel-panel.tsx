import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { Alert, Button, Input, Modal, Spin } from "antd";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmPanel, type ConfirmInput, type ConfirmSpec } from "../../components/ConfirmAction";
import { ReadOnlyValue } from "../../components/ReadOnlyValue";
import { AccessContext } from "../../lib/permissions";
import { DETAIL_QUERY } from "../../lib/query";
import { actorScope } from "../system/staff-access";
import { createCancelApi, type CancelDetail } from "./cancel-api";
import {
  cancelActionLabels,
  cancelActions,
  cancelCommand,
  cancelDecisionFacts,
  cancelKinds,
  cancelStatus,
  cancelTarget,
  createCancelIntent,
  CancelRecheckFailure,
  isCancelRejected,
  type CancelAction,
} from "./cancel-model";

export interface CancelRequestPanelProps {
  cancelRequestId: string;
  onChanged?: () => void;
}
export function CancelRequestPanel(props: CancelRequestPanelProps) {
  const access = useContext(AccessContext);
  return (
    <CancelPanelBody
      key={`${actorScope(access)}:${props.cancelRequestId}`}
      {...props}
      scope={actorScope(access)}
    />
  );
}
const time = (value: string | null) => (value ? appDateTimeFormat.dateTime(value) : "—");
const modeLabels = {
  release: "释放冻结积分",
  refund: "退回已扣积分",
  terminate_only: "仅终止服务",
} as const;
const stageLabels: Readonly<Record<string, string>> = {
  pending_start: "尚未开工",
  plan_confirm: "方案确认",
  ad_and_sample: "广告与样片制作",
  sample_pending: "样片待确认",
  post_sample: "样片后制作",
  live: "已上线",
  ad_unassigned: "广告待指派",
  ad_in_production: "广告制作中",
};
const timelineLabels = {
  submitted: "提交申请",
  approved: "审批通过",
  rejected: "驳回申请",
  withdrawn: "撤回申请",
  voided: "作废申请",
  executed: "执行积分退回",
} as const;
const closeLabels = { rejected: "已驳回", withdrawn: "已撤回", voided: "已作废" } as const;
function Breakdown({ value }: { value: CancelDetail["destination"] }) {
  return (
    <span>
      原积分批次 {value.backToOriginal} · 转为加量积分 {value.convertedToAddon} · 作废{" "}
      {value.forfeited}
    </span>
  );
}
function CancelPanelBody({
  cancelRequestId: id,
  onChanged,
  scope,
}: CancelRequestPanelProps & { scope: string }) {
  const { services } = useRouteContext({ from: "__root__" });
  const access = useContext(AccessContext),
    cache = useQueryClient();
  const api = useMemo(() => createCancelApi(services), [services]);
  const [intent] = useState(() => createCancelIntent());
  const alive = useRef(true);
  const confirmedFacts = useRef("");
  useEffect(() => {
    alive.current = true;
    intent.activate();
    return () => {
      alive.current = false;
      intent.close();
    };
  }, [intent]);
  const queryKey = ["approval", "cancel", scope, id];
  const detail = useQuery({
    queryKey,
    ...DETAIL_QUERY,
    queryFn: ({ signal }) => api.get(id, signal),
  });
  const [action, setAction] = useState<CancelAction>();
  const [note, setNote] = useState("");
  const [input, setInput] = useState<ConfirmInput>({ checked: false, typed: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [readFailed, setReadFailed] = useState(false);
  const data = detail.data;
  const apply = (value: CancelDetail) => {
    cache.setQueryData(queryKey, value);
    setReadFailed(false);
    onChanged?.();
  };
  const refresh = async () => {
    if (intent.pending) return;
    setBusy(true);
    try {
      const value = await intent.refresh((signal) => api.get(id, signal));
      if (value && alive.current) {
        apply(value);
        setNotice(intent.unresolved ? "上次提交结果未知；可用原正文与原幂等键重试。" : undefined);
        if (!intent.unresolved) setAction(undefined);
      }
    } catch {
      if (alive.current) {
        setReadFailed(true);
        setNotice("当前详情读取失败，请重试读取；不得据此判断审批或执行完成。");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const submit = async () => {
    if (!data || !action || intent.pending || intent.accepted) return;
    if (
      !intent.command &&
      (confirmedFacts.current !== cancelDecisionFacts(data) ||
        !cancelActions(data, access).includes(action) ||
        detail.isFetching ||
        readFailed)
    ) {
      setAction(undefined);
      setNotice("当前事实或操作权限已变化，请核对后重新打开确认。");
      return;
    }
    let command;
    try {
      command = intent.command ?? cancelCommand(data, action, note);
    } catch {
      setNotice("请填写 1–200 字的处理说明。");
      return;
    }
    setBusy(true);
    setNotice(undefined);
    try {
      await cache.cancelQueries({ queryKey, exact: true });
      const value = await intent.submit(
        command,
        (body, key, signal) => api.write(id, body, key, signal),
        (signal) => api.get(id, signal),
        (fresh) =>
          confirmedFacts.current === cancelDecisionFacts(fresh) &&
          cancelActions(fresh, access).includes(command.action),
      );
      if (value && alive.current) {
        apply(value);
        setAction(undefined);
      }
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof CancelRecheckFailure) {
        apply(error.detail);
        setAction(undefined);
        setInput({ checked: false, typed: "" });
        setNotice(
          intent.unresolved
            ? "当前事实已变化，上次提交结果仍未知；保留原幂等键并停止写入，请继续读取核对。"
            : "当前事实或操作权限已变化，请核对后重新确认。",
        );
      } else if (intent.accepted) {
        setReadFailed(true);
        setNotice("请求已受理，最新详情读取失败。请仅重试读取，不要重复提交。");
      } else if (isCancelRejected(error)) {
        setInput({ checked: false, typed: "" });
        setNotice(`未完成操作（${error.code}），请核对最新详情后重新确认。`);
        try {
          const value = await intent.refresh((signal) => api.get(id, signal));
          if (value && alive.current) {
            apply(value);
            setAction(undefined);
          }
        } catch {
          if (alive.current) setReadFailed(true);
        }
      } else setNotice("提交结果未知。请保留原正文重试，系统将复用同一幂等键。");
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const available = data ? cancelActions(data, access) : [];
  const spec: ConfirmSpec | undefined =
    data && action
      ? {
          title: cancelActionLabels[action],
          description:
            "本操作处理服务取消与积分；审批通过后仍须执行，页面以重新读取的当前状态为准。",
          echo: [
            { label: "取消单号", value: data.requestNo },
            { label: "目标", value: data.target.label },
            { label: "拟退积分", value: String(data.totalRefundPoints), emphasis: true },
          ],
          checkLabel:
            action === "approve"
              ? "已核对阶段规则及积分金额"
              : action === "execute"
                ? "已核对订单及退回积分"
                : "已核对目标与处理说明",
          sensitive:
            action === "approve" || action === "execute"
              ? { label: "请输入拟退积分", expected: String(data.totalRefundPoints) }
              : undefined,
          confirmText: intent.unresolved ? "用原内容重试" : cancelActionLabels[action],
          danger: action === "reject" || action === "void",
        }
      : undefined;
  return (
    <section aria-label="取消与积分退回详情">
      <div className="lyx-access-actions">
        <h3>取消与积分退回</h3>
        <Button loading={busy} onClick={() => void refresh()}>
          刷新取消详情
        </Button>
      </div>
      {notice ? (
        <Alert
          type="warning"
          title={notice}
          action={
            intent.accepted || readFailed ? (
              <Button disabled={busy} onClick={() => void refresh()}>
                重试读取
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {detail.isPending ? (
        <Spin />
      ) : detail.isError && !data ? (
        <Alert
          type="error"
          title="取消详情读取失败"
          action={<Button onClick={() => void refresh()}>重试读取</Button>}
        />
      ) : null}
      {data ? (
        <>
          <ReadOnlyValue label="取消单号" value={data.requestNo} />
          <ReadOnlyValue
            label="类型 / 状态"
            value={`${cancelKinds[data.kind]} / ${cancelStatus[data.status]}`}
          />
          <ReadOnlyValue
            label="门店 / 主体"
            value={`${data.store.storeName ?? "—"} / ${data.store.entityName ?? "—"}`}
          />
          <ReadOnlyValue
            label="取消目标"
            value={`${data.target.label} · ${data.target.no ?? "—"}`}
          />
          <ReadOnlyValue
            label="发起人"
            value={data.isSystemSubmitted ? "系统" : (data.requester?.name ?? "—")}
          />
          <ReadOnlyValue
            label="提交 / 审批期限"
            value={`${time(data.submittedAt)} / ${time(data.approvalDueAt)}`}
          />
          <ReadOnlyValue
            label="审批 / 执行期限"
            value={`${time(data.decidedAt)} / ${time(data.execDueAt)}`}
          />
          <ReadOnlyValue label="实际执行时间" value={time(data.executedAt)} />
          <ReadOnlyValue
            label="执行人"
            value={
              data.execution?.isExecutedBySystem
                ? "系统"
                : (data.execution?.executedBy?.name ?? "—")
            }
          />
          <ReadOnlyValue label="申请说明" value={data.note ?? "—"} />
          <ReadOnlyValue
            label="关闭原因 / 说明"
            value={`${data.closeReason ? closeLabels[data.closeReason] : "—"} / ${data.closeNote ?? "—"}`}
          />
          <p>
            计费积分 {data.totalBasePoints} · 扣减 {data.totalDeductPoints} · 拟退{" "}
            {data.totalRefundPoints}
          </p>
          <p>
            预计去向：
            <Breakdown value={data.destination} />
          </p>
          {data.resultTotals ? (
            <p>
              执行结果：原批次退回 {data.resultTotals.returnedPoints} · 转加量{" "}
              {data.resultTotals.convertedPoints} · 作废 {data.resultTotals.forfeitedPoints}
            </p>
          ) : (
            <p>尚无执行结果；待审批和待执行均未完成积分退回。</p>
          )}
          <ul>
            {data.lines.map((line) => (
              <li key={line.cancelRequestLineId}>
                <strong>{line.label}</strong> · {modeLabels[line.mode]} · 阶段{" "}
                {stageLabels[line.stage] ?? "其他阶段"} · 计费 {line.chargePoints} · 扣减{" "}
                {line.deductPoints} · 拟退 {line.refundPoints}
                {line.deductNote ? <p>扣减说明：{line.deductNote}</p> : null}
                <p>
                  预计：
                  <Breakdown value={line.preview} />
                </p>
                {line.result ? (
                  <p>
                    实际：
                    <Breakdown value={line.result.breakdown} /> · {time(line.result.executedAt)}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <ol>
            {data.timeline.map((row, index) => (
              <li key={index}>
                {time(row.at)} · {row.actorName ?? "系统"} · {timelineLabels[row.action]}
                {row.note ? ` · ${row.note}` : ""}
              </li>
            ))}
          </ol>
          {cancelTarget(data, access) ? (
            <p>
              <a className="lyx-link" href={cancelTarget(data, access)!}>
                查看原业务详情
              </a>
            </p>
          ) : null}
          <div className="lyx-access-actions">
            {available.map((value) => (
              <Button
                key={value}
                disabled={
                  busy || detail.isFetching || readFailed || intent.accepted || intent.unresolved
                }
                onClick={() => {
                  confirmedFacts.current = cancelDecisionFacts(data);
                  setAction(value);
                  setNote("");
                  setInput({ checked: false, typed: "" });
                  setNotice(undefined);
                }}
              >
                {cancelActionLabels[value]}
              </Button>
            ))}
            {intent.unresolved && !intent.accepted ? (
              <Button
                disabled={busy}
                onClick={() => {
                  setAction(intent.command!.action);
                  setInput({ checked: false, typed: "" });
                }}
              >
                恢复原提交
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
      <Modal
        open={Boolean(action && spec)}
        title={spec?.title}
        footer={null}
        destroyOnHidden
        closable={!busy}
        keyboard={!busy}
        mask={{ closable: !busy }}
        onCancel={() => {
          if (!busy) setAction(undefined);
        }}
      >
        {spec ? (
          <>
            {action === "reject" || action === "withdraw" || action === "void" ? (
              <label>
                处理说明
                <Input.TextArea
                  aria-label="取消处理说明"
                  maxLength={200}
                  value={note}
                  disabled={busy || intent.unresolved || intent.accepted}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
            ) : null}
            <ConfirmPanel
              spec={spec}
              input={input}
              onInputChange={setInput}
              submitting={busy || intent.accepted || readFailed}
              onCancel={() => setAction(undefined)}
              onConfirm={() => void submit()}
              notice={notice ? { tone: "warning", message: notice } : undefined}
            />
          </>
        ) : null}
      </Modal>
    </section>
  );
}
