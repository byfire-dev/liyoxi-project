import { useInfiniteQuery } from "@tanstack/react-query";
import { Alert, Button, Modal } from "antd";
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { appDateTimeFormat as date } from "@liyoxi/shared/format/datetime";
import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { ConfirmPanel, confirmReady, type ConfirmInput } from "../../../components/ConfirmAction";
import { InfoList } from "../../../components/InfoList";
import { ErrorState } from "../../../components/StateBlock";
import { AccessContext } from "../../../lib/permissions";
import { actorScope } from "../../system/staff-access";
import type { AppServices } from "../../../app/services";
import { DETAIL_KEY } from "./model";
import { createTicketDetailApi } from "./api";
import { createM5TicketApi, TicketActionFailure, type M5Ticket, type M5TicketApi } from "./m5-api";
import {
  actionAllowed,
  actionPermitted,
  actionCommand,
  actionLabels,
  createTicketActionIntent,
  emptyActionFields,
  ticketActionError,
  type TicketAction,
  type TicketCommand,
} from "./m5-actions";
import { M5ActionFields } from "./m5-fields";
import { M5Resources } from "./m5-resources";

export function TicketM5Panel(props: { ticket: M5Ticket; services: AppServices; refresh(): void }) {
  const access = useContext(AccessContext);
  return (
    <TicketOperations key={`${actorScope(access)}:${props.ticket.deliveryTicketId}`} {...props} />
  );
}
function send(
  api: M5TicketApi,
  ticket: M5Ticket,
  command: TicketCommand,
  key: string,
  signal: AbortSignal,
) {
  const id = ticket.deliveryTicketId;
  switch (command.action) {
    case "assign-editor":
      return api.assignEditor(id, command.body, key, signal);
    case "assign-publisher":
      return api.assignPublisher(id, command.body, key, signal);
    case "force-transition":
      return api.force(id, command.body, key, signal);
    case "reevaluate":
      return api.reevaluate(id, key, signal);
    case "rework":
      return api.rework(id, command.body, key, signal);
    case "remind":
      return api.remind(id, command.body, key, signal);
    case "reschedule":
      return api.reschedule(ticket.orderItem.orderItemId, command.body, key, signal);
    case "reissue":
      return api.reissue(id, command.body, key, signal);
    case "cancel-reissue":
      return api.cancelReissue(command.targetId, command.body, key, signal);
    case "publish-reissue":
      return api.publishReissue(command.targetId, command.body, key, signal);
    case "mark-sent":
      return api.markSent(command.targetId, key, signal);
    case "feedback":
      return api.feedback(command.targetId, command.body, key, signal);
    case "normalize":
      return api.normalize(command.targetId, command.body, key, signal);
    case "recheck":
      return api.recheck(command.targetId, key, signal);
    case "restamp":
      return api.restamp(command.targetId, command.body, key, signal);
  }
}
function TicketOperations({
  ticket,
  services,
  refresh,
}: {
  ticket: M5Ticket;
  services: AppServices;
  refresh(): void;
}) {
  const access = useContext(AccessContext),
    scope = actorScope(access);
  const api = useMemo(() => createM5TicketApi(services), [services]),
    uploads = useMemo(() => createTicketDetailApi(services), [services]),
    intent = useMemo(() => createTicketActionIntent(), []),
    lifetime = useRef(new AbortController()),
    operationPending = useRef(false),
    uploadsPending = useRef(false),
    command = useRef<TicketCommand | undefined>(undefined);
  const [selection, setSelection] = useState<{ action: TicketAction; productionId?: string }>(),
    [snapshot, setSnapshot] = useState(ticket),
    [fields, setFields] = useState(emptyActionFields),
    [confirmation, setConfirmation] = useState<ConfirmInput>({ checked: false, typed: "" }),
    [busy, setBusy] = useState(false),
    [uploading, setUploading] = useState(false),
    [error, setError] = useState<string>(),
    [notice, setNotice] = useState<string>();
  useEffect(() => {
    lifetime.current = new AbortController();
    intent.activate();
    return () => {
      lifetime.current.abort();
      intent.close();
    };
  }, [intent]);
  const history = useInfiniteQuery({
    queryKey: [...DETAIL_KEY, scope, "activities", ticket.deliveryTicketId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => api.activity(ticket.deliveryTicketId, signal, pageParam),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const read = async (signal: AbortSignal) => {
    await services.queryClient.cancelQueries({ queryKey: [...DETAIL_KEY, scope, ticket.ticketNo] });
    return api.get(ticket.deliveryTicketId, signal);
  };
  const open = async (action: TicketAction, productionId?: string) => {
    if (operationPending.current || intent.locked) return;
    operationPending.current = true;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const fresh = await read(lifetime.current.signal);
      if (lifetime.current.signal.aborted) return;
      if (!actionAllowed(fresh, action, access))
        throw new TicketActionFailure("STATE_NOT_ALLOWED", 409);
      setSnapshot(fresh);
      command.current = undefined;
      intent.reset();
      setFields({
        ...emptyActionFields(),
        reasonCode: action === "reissue" ? "" : "workload",
        date: fresh.orderItem.agreedLaunchDate ?? "",
        scene: fresh.remindScenes[0] ?? "",
      });
      setConfirmation({ checked: false, typed: "" });
      setSelection({ action, productionId });
    } catch (failure) {
      if (!lifetime.current.signal.aborted) setError(ticketActionError(failure));
    } finally {
      operationPending.current = false;
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  };
  const submit = async () => {
    if (
      !selection ||
      !confirmReady(spec, confirmation) ||
      operationPending.current ||
      uploadsPending.current
    )
      return;
    operationPending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      command.current ??= actionCommand(snapshot, selection.action, fields, selection.productionId);
      const own = command.current;
      const outcome = await intent.submit(
        own,
        read,
        async (fresh, retry) => {
          if (
            fresh.deliveryTicketId !== snapshot.deliveryTicketId ||
            !actionPermitted(access, own.action)
          )
            throw new TicketActionFailure("PERMISSION_DENIED", 403);
          if (
            !retry &&
            (fresh.lockVersion !== snapshot.lockVersion ||
              fresh.step !== snapshot.step ||
              !actionAllowed(fresh, own.action, access) ||
              fresh.currentSample?.sampleId !== snapshot.currentSample?.sampleId ||
              fresh.currentSample?.versionNo !== snapshot.currentSample?.versionNo)
          )
            throw new TicketActionFailure("PRECONDITION_CHANGED", 409);
          if (
            !retry &&
            (own.action === "normalize" || own.action === "restamp" || own.action === "recheck")
          ) {
            const facts = await api.productionRecord(
              fresh.orderItem.orderItemId,
              own.targetId,
              lifetime.current.signal,
            );
            const record = facts.items.find(
              (row) =>
                row.productionRecordId === own.targetId &&
                row.orderItemId === fresh.orderItem.orderItemId,
            );
            if (!record?.actions.includes(own.action))
              throw new TicketActionFailure("PRECONDITION_CHANGED", 409);
          }
        },
        (key, signal) => send(api, snapshot, own, key, signal),
      );
      if (!outcome || lifetime.current.signal.aborted) return;
      services.queryClient.setQueryData([...DETAIL_KEY, scope, ticket.ticketNo], outcome.current);
      if (own.action === "reevaluate") {
        const value = outcome.value as Awaited<ReturnType<M5TicketApi["reevaluate"]>>;
        setNotice(
          value.skippedReason === "paused"
            ? "工单仍在暂停，本次没有推进"
            : value.skippedReason === "terminal"
              ? "工单已结束，本次没有推进"
              : value.transitions.length
                ? `本次实际迁移 ${value.transitions.length} 次，已读取当前步骤`
                : "本次没有发生步骤迁移",
        );
      } else
        setNotice(
          ["normalize", "restamp", "recheck"].includes(own.action)
            ? "处理已受理，请刷新制作事实查看结果；衍生文件仍需显式登记"
            : own.action === "mark-sent"
              ? "已登记员工发送记录，渠道到达仍以实际证据为准"
              : "已重新读取当前工单，请核对状态与活动记录",
        );
      setSelection(undefined);
      command.current = undefined;
      refresh();
      void history.refetch();
    } catch (failure) {
      if (!lifetime.current.signal.aborted) setError(ticketActionError(failure));
    } finally {
      operationPending.current = false;
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  };
  const reread = async () => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    try {
      const value = await read(lifetime.current.signal);
      if (!lifetime.current.signal.aborted) {
        services.queryClient.setQueryData([...DETAIL_KEY, scope, ticket.ticketNo], value);
        refresh();
        if (intent.phase === "unknown") {
          setError("已读取当前状态，仍保留原意图；请恢复原键以确认本次结果");
        } else {
          intent.reset();
          command.current = undefined;
          setSelection(undefined);
          setError(undefined);
        }
      }
    } catch (failure) {
      if (!lifetime.current.signal.aborted) setError(ticketActionError(failure));
    } finally {
      operationPending.current = false;
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  };
  const label = selection ? actionLabels[selection.action] : "工单操作";
  const spec = {
    title: label,
    echo: [
      { label: "工单", value: snapshot.ticketNo },
      { label: "门店", value: snapshot.store.storeName ?? "未命名门店" },
      {
        label: "当前步骤",
        value:
          statusToneByEnum("delivery_ticket.step", snapshot.step)?.admin?.label ?? snapshot.step,
      },
    ],
    checkLabel: "我已核对当前对象、内容与影响",
    confirmText: intent.locked ? "恢复原意图" : "确认操作",
    ...(selection?.action === "force-transition"
      ? { sensitive: { label: "请输入完整工单号", expected: snapshot.ticketNo }, danger: true }
      : {}),
  };
  const actions: TicketAction[] = [
    "assign-editor",
    "assign-publisher",
    "remind",
    "reschedule",
    "rework",
    "reissue",
    "cancel-reissue",
    "publish-reissue",
    "mark-sent",
    "feedback",
    "reevaluate",
    "force-transition",
  ];
  return (
    <div className="lyx-production-sections">
      {ticket.isPaused ? (
        <Alert
          type="warning"
          title="工单暂停中"
          description={
            <ul>
              {ticket.pauses.map((pause) => (
                <li key={`${pause.refType}:${pause.refId}`}>
                  {{
                    cancel_review: "取消审批中",
                    plan_amendment: "方案变更待确认",
                    qualification: "资质处理中",
                    qualification_hold: "资质处理中",
                  }[pause.reason] ?? pause.reason}{" "}
                  · {date.dateTime(pause.createdAt)}
                </li>
              ))}
            </ul>
          }
        />
      ) : null}
      <InfoList
        items={[
          { label: "当前截止", value: ticket.stepDueAt ? date.dateTime(ticket.stepDueAt) : "暂无" },
          {
            label: "暂停保留",
            value: ticket.pauseRemainingMin === null ? "—" : `${ticket.pauseRemainingMin} 分钟`,
          },
          { label: "使用止日", value: date.date(ticket.usageEndDate) },
        ]}
      />
      {notice ? <Alert type="info" title={notice} /> : null}
      {error && !selection ? <Alert type="error" title={error} /> : null}
      <div className="lyx-production-actions">
        {actions
          .filter((action) => actionAllowed(ticket, action, access))
          .map((action) => (
            <Button
              key={action}
              disabled={busy || intent.locked}
              danger={action === "force-transition"}
              onClick={() => void open(action)}
            >
              {actionLabels[action]}
            </Button>
          ))}
      </div>
      {ticket.openReissue ? (
        <section className="lyx-production-card">
          <h3>当前补发</h3>
          <p>
            第 {ticket.openReissue.episodeNos.join("、")} 集 · {ticket.openReissue.note}
          </p>
          <ul>
            {ticket.openReissue.replacements.map((row) => (
              <li key={row.episodeNo}>
                第 {row.episodeNo} 集 · {row.status === "qc_passed" ? "已质检通过" : row.status}
              </li>
            ))}
          </ul>
          <p>替换行须通过现有成片登记与质检后才可发布补发。</p>
        </section>
      ) : null}
      <M5Resources
        ticket={ticket}
        api={api}
        access={access}
        onAction={(action, id) => void open(action, id)}
      />
      <section className="lyx-production-card">
        <h3>步骤时限</h3>
        <ul>
          {ticket.stages.map((stage) => (
            <li key={`${stage.step}:${stage.visitNo}`}>
              {statusToneByEnum("delivery_ticket.step", stage.step)?.admin?.label ?? stage.step} ·
              第 {stage.visitNo} 次 · {stage.dueAt ? date.dateTime(stage.dueAt) : "暂无截止"} ·{" "}
              {stage.isBreached ? "已超时" : stage.completedAt ? "已完成" : "处理中"}
            </li>
          ))}
        </ul>
      </section>
      <section className="lyx-production-card">
        <h3>工单活动</h3>
        {history.isError ? (
          <ErrorState message="活动读取失败" onRetry={() => void history.refetch()} />
        ) : (
          <ul>
            {history.data?.pages
              .flatMap((page) => page.items)
              .map((row) => (
                <li key={row.activityId}>
                  {date.dateTime(row.occurredAt)} · {row.actorName ?? "系统"} · {row.summary}
                  {row.reasonText ? ` · ${row.reasonText}` : ""}
                </li>
              ))}
          </ul>
        )}
        {history.hasNextPage ? (
          <Button loading={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
            读取更多活动
          </Button>
        ) : null}
      </section>
      {selection ? (
        <Modal
          open
          title={label}
          className="lyx-m5-modal"
          footer={null}
          width={640}
          closable={!busy && !intent.locked}
          keyboard={!busy && !intent.locked}
          mask={{ closable: !busy && !intent.locked }}
          onCancel={() => {
            if (!busy && !intent.locked) setSelection(undefined);
          }}
        >
          <M5ActionFields
            key={`${snapshot.deliveryTicketId}:${selection.action}`}
            ticket={snapshot}
            action={selection.action}
            fields={fields}
            disabled={busy || intent.locked || uploading}
            api={api}
            access={access}
            uploadApi={uploads}
            onUploading={(value) => {
              uploadsPending.current = value;
              setUploading(value);
            }}
            setFields={(value) => {
              setFields(value);
              command.current = undefined;
              setConfirmation({ checked: false, typed: "" });
            }}
          />
          <ConfirmPanel
            spec={spec}
            input={confirmation}
            onInputChange={setConfirmation}
            submitting={busy || uploading}
            notice={error ? { tone: "warning", message: error } : undefined}
            onCancel={() => {
              if (!busy && !intent.locked) setSelection(undefined);
            }}
            onConfirm={() => void submit()}
          />
          {error ? (
            <Button disabled={busy || uploading} onClick={() => void reread()}>
              重新读取并核对
            </Button>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
