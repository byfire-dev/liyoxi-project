import {
  AssignStaffBodySchema,
  ForceTransitionBodySchema,
  ReworkBodySchema,
  TicketRemindBodySchema,
  RescheduleLaunchBodySchema,
  ReissueCreateBodySchema,
  ReissueCancelBodySchema,
  ReissuePublishBodySchema,
  AdminSampleRequestChangeBodySchema,
  NormalizeBodySchema,
  RestampBodySchema,
} from "@liyoxi/contract";
import { chainOf, findTransitions, SAME } from "@liyoxi/shared/machines";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { canAction, hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import { TicketActionFailure, type M5Body, type M5Ticket } from "./m5-api";

export const actionLabels = {
  "assign-editor": "指派或改派剪辑师",
  "assign-publisher": "改派发布专员",
  "force-transition": "强制更正步骤",
  reevaluate: "重新求值",
  rework: "返工",
  remind: "催办商家",
  reschedule: "调整约定上线日",
  reissue: "发起补发",
  "cancel-reissue": "取消补发",
  "publish-reissue": "发布补发",
  "mark-sent": "登记企业微信发送",
  feedback: "代录样片修改意见",
  normalize: "规范化制作文件",
  restamp: "补写AI标识",
  recheck: "重新体检",
} as const;
export type TicketAction = keyof typeof actionLabels;
const permissions: Readonly<Record<TicketAction, string | null>> = {
  "assign-editor": "delivery.ticket.assign_editor",
  "assign-publisher": "delivery.ticket.assign_publisher",
  "force-transition": "flow.admin.transition",
  reevaluate: "flow.ops.manage",
  rework: "delivery.ticket.rework",
  remind: null,
  reschedule: "delivery.plan.reschedule",
  reissue: "delivery.package.reissue",
  "cancel-reissue": "delivery.package.reissue",
  "publish-reissue": "publish.package.push",
  "mark-sent": "delivery.sample.push",
  feedback: "delivery.sample.feedback_on_behalf",
  normalize: "production.normalize",
  restamp: "production.restamp",
  recheck: "production.recheck",
};
export const actionPermitted = (access: AccessSnapshot | null, action: TicketAction) =>
  access !== null && (!permissions[action] || canAction(access, permissions[action]!));
export function actionAllowed(
  ticket: M5Ticket,
  action: TicketAction,
  access: AccessSnapshot | null,
) {
  if (!actionPermitted(access, action)) return false;
  if (action === "reschedule")
    return (
      hasModuleLevel(access, "delivery", "v") &&
      !ticket.isPaused &&
      !ticket.orderItem.usageStartDate &&
      ticket.launch.liveCount === 0 &&
      !["archived", "terminated"].includes(ticket.step)
    );
  if (action === "cancel-reissue" || action === "publish-reissue")
    return (
      ticket.openReissue?.actions.includes(action === "cancel-reissue" ? "cancel" : "publish") ??
      false
    );
  if (action === "mark-sent" || action === "feedback")
    return (
      ticket.currentSample?.actions.includes(action === "feedback" ? "request-change" : action) ??
      false
    );
  if (["normalize", "restamp", "recheck"].includes(action)) return !ticket.isPaused;
  return ticket.actions.includes(action);
}
export function forceTargets(step: M5Ticket["step"]) {
  return [
    ...new Set(
      findTransitions(chainOf("delivery_ticket", "step"), step, "admin.force").flatMap((row) =>
        row.to === SAME ? [step] : [...row.to],
      ),
    ),
  ];
}
export type TicketCommand =
  | { action: "assign-editor"; body: M5Body<"admin.deliveryTicket.assignEditor"> }
  | { action: "assign-publisher"; body: M5Body<"admin.deliveryTicket.assignPublisher"> }
  | { action: "force-transition"; body: M5Body<"admin.deliveryTicket.forceTransition"> }
  | { action: "reevaluate"; body: Record<string, never> }
  | { action: "rework"; body: M5Body<"admin.deliveryTicket.rework"> }
  | { action: "remind"; body: M5Body<"admin.deliveryTicket.remind"> }
  | { action: "reschedule"; body: M5Body<"admin.orderItem.rescheduleLaunch"> }
  | { action: "reissue"; body: M5Body<"admin.deliveryTicket.reissue.create"> }
  | { action: "cancel-reissue"; targetId: string; body: M5Body<"admin.reissue.cancel"> }
  | { action: "publish-reissue"; targetId: string; body: M5Body<"admin.reissue.publish"> }
  | { action: "mark-sent"; targetId: string; body: Record<string, never> }
  | { action: "feedback"; targetId: string; body: M5Body<"admin.sample.requestChange"> }
  | { action: "normalize"; targetId: string; body: M5Body<"admin.productionRecord.normalize"> }
  | { action: "restamp"; targetId: string; body: M5Body<"admin.productionRecord.restamp"> }
  | { action: "recheck"; targetId: string; body: Record<string, never> };

export interface ActionFields {
  staffId: string;
  reasonCode: string;
  note: string;
  toStep: string;
  date: string;
  scene: string;
  episodes: number[];
  feedbackKind: "compose" | "ad_content";
  adId: string;
  feedbackTime: string;
  feedbackFileIds: string[];
  tools: { name: string; version: string; usedFor: string }[];
  precheck?: M5Body<"admin.reissue.publish">["precheck"];
}
export const emptyActionFields = (): ActionFields => ({
  staffId: "",
  reasonCode: "workload",
  note: "",
  toStep: "",
  date: "",
  scene: "",
  episodes: [],
  feedbackKind: "compose",
  adId: "",
  feedbackTime: "",
  feedbackFileIds: [],
  tools: [],
});
export function actionCommand(
  ticket: M5Ticket,
  action: TicketAction,
  fields: ActionFields,
  productionId?: string,
): TicketCommand {
  const note = fields.note.trim();
  switch (action) {
    case "assign-editor":
    case "assign-publisher":
      return {
        action,
        body: AssignStaffBodySchema.parse({
          staffId: fields.staffId,
          ...((action === "assign-editor" ? ticket.editor : ticket.publisher)
            ? { reasonCode: fields.reasonCode }
            : {}),
          note: note || undefined,
        }),
      };
    case "force-transition":
      if (!forceTargets(ticket.step).includes(fields.toStep))
        throw new TicketActionFailure("STATE_NOT_ALLOWED", 409);
      return {
        action,
        body: ForceTransitionBodySchema.parse({
          toStep: fields.toStep,
          note,
          confirm: { ticketNo: ticket.ticketNo, fromStep: ticket.step },
          ...(ticket.step === "takedown" && fields.toStep === "in_service"
            ? { newUsageEndDate: fields.date }
            : {}),
        }),
      };
    case "reevaluate":
      return { action, body: {} };
    case "rework":
      return { action, body: ReworkBodySchema.parse({ reason: note }) };
    case "remind":
      return { action, body: TicketRemindBodySchema.parse({ scene: fields.scene }) };
    case "reschedule":
      return {
        action,
        body: RescheduleLaunchBodySchema.parse({ agreedLaunchDate: fields.date, reason: note }),
      };
    case "reissue":
      return {
        action,
        body: ReissueCreateBodySchema.parse({
          episodeNos: fields.episodes,
          reasonCode: fields.reasonCode,
          note,
        }),
      };
    case "cancel-reissue":
    case "publish-reissue": {
      if (!ticket.openReissue) throw new TicketActionFailure("STATE_NOT_ALLOWED", 409);
      return action === "cancel-reissue"
        ? {
            action,
            targetId: ticket.openReissue.reissueId,
            body: ReissueCancelBodySchema.parse({ note: note || undefined }),
          }
        : {
            action,
            targetId: ticket.openReissue.reissueId,
            body: ReissuePublishBodySchema.parse({
              precheck: fields.precheck,
              note: note || undefined,
            }),
          };
    }
    case "mark-sent":
    case "feedback": {
      const sample = ticket.currentSample;
      if (!sample) throw new TicketActionFailure("SAMPLE_VERSION_STALE", 409);
      if (action === "mark-sent") return { action, targetId: sample.sampleId, body: {} };
      return {
        action,
        targetId: sample.sampleId,
        body: AdminSampleRequestChangeBodySchema.parse({
          versionNo: sample.versionNo,
          feedbackKind: fields.feedbackKind,
          note,
          ...(fields.feedbackKind === "ad_content" ? { adId: fields.adId } : {}),
          ...(fields.feedbackTime.trim() ? { feedbackTimeMs: Number(fields.feedbackTime) } : {}),
          feedbackFileIds: fields.feedbackFileIds,
        }),
      };
    }
    case "normalize":
    case "restamp":
    case "recheck":
      if (!productionId) throw new TicketActionFailure("NOT_FOUND", 404);
      return action === "normalize"
        ? {
            action,
            targetId: productionId,
            body: NormalizeBodySchema.parse({ note: note || undefined }),
          }
        : action === "restamp"
          ? {
              action,
              targetId: productionId,
              body: RestampBodySchema.parse({ tools: fields.tools, note }),
            }
          : { action, targetId: productionId, body: {} };
  }
}
export function ticketActionError(error: unknown) {
  const labels: Readonly<Record<string, string>> = {
    CORRECTION_NOT_ALLOWED: "该更正不满足当前结构条件，请重新核对",
    VERSION_CONFLICT: "内容已变化，请重新读取并核对",
    CONFIRM_MISMATCH: "工单步骤已变化，请重新核对",
    PRECONDITION_CHANGED: "处理条件已变化，请重新核对",
    STATE_NOT_ALLOWED: "当前状态不允许此操作",
    SAMPLE_VERSION_STALE: "样片版本已变化，请重新读取",
    AD_CHANGED: "广告版本已变化，请重新核对",
    ASSIGNEE_INVALID: "所选员工已不可指派，请重新选择",
    LAUNCH_DATE_OUT_OF_RANGE: "约定上线日超出允许范围，请重新核对日期",
    VALIDATION_FAILED: "字段或当前条件不符，请重新读取后修正",
    TICKET_ON_HOLD: "工单仍在暂停，请先处理暂停原因",
    PERMISSION_DENIED: "当前权限不可执行此操作",
    REMINDED_TODAY: "今天已经催办，请明天再试",
    RESULT_UNCERTAIN: "上次操作结果待确认，请恢复原意图",
    RECONFIRM_REQUIRED: "请重新读取并核对后再操作",
    RESPONSE_MISMATCH: "返回的工单不匹配，请重新读取",
  };
  if (error instanceof TicketActionFailure)
    return `${labels[error.code] ?? "请求结果尚未确认，请保留原意图重试"}${error.tail ? `（请求编号 ${error.tail}）` : ""}`;
  return "请检查必填字段、原因、版次和确认内容";
}

/** Only this ticket's M5 intent: accepted POST + failed GET never causes a second write. */
export function createTicketActionIntent(makeKey = () => newIdempotencyKey("ticket-action")) {
  let active = true,
    busy = false,
    generation = 0,
    controller = new AbortController();
  let entry:
    | {
        signature: string;
        key: string;
        phase: "new" | "unknown" | "accepted" | "blocked";
        value?: unknown;
      }
    | undefined;
  return {
    get locked() {
      return entry !== undefined && entry.phase !== "new";
    },
    get pending() {
      return busy;
    },
    get phase() {
      return entry?.phase ?? "idle";
    },
    activate() {
      if (!active) {
        active = true;
        controller = new AbortController();
      }
    },
    close() {
      active = false;
      generation++;
      controller.abort();
      busy = false;
    },
    reset() {
      if (!busy) entry = undefined;
    },
    async submit(
      command: TicketCommand,
      read: (signal: AbortSignal) => Promise<M5Ticket>,
      validate: (fresh: M5Ticket, retry: boolean) => void | Promise<void>,
      send: (key: string, signal: AbortSignal) => Promise<unknown>,
    ) {
      if (!active || busy) return undefined;
      const signature = JSON.stringify(command),
        own = generation,
        signal = controller.signal;
      if (entry && entry.signature !== signature) {
        if (entry.phase === "new") entry = undefined;
        else throw new TicketActionFailure("RESULT_UNCERTAIN");
      }
      entry ??= { signature, key: makeKey(), phase: "new" };
      if (entry.phase === "blocked") throw new TicketActionFailure("RECONFIRM_REQUIRED", 409);
      const intent = entry;
      busy = true;
      const live = () => active && !signal.aborted && own === generation;
      try {
        const fresh = await read(signal);
        if (!live()) return undefined;
        await validate(fresh, intent.phase !== "new");
        if (!live()) return undefined;
        if (intent.phase !== "accepted") {
          intent.phase = "unknown";
          intent.value = await send(intent.key, signal);
          if (!live()) return undefined;
          intent.phase = "accepted";
        }
        const current = await read(signal);
        if (!live()) return undefined;
        const value = intent.value;
        entry = undefined;
        return { current, value };
      } catch (error) {
        if (!live()) return undefined;
        if (
          error instanceof TicketActionFailure &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408
        )
          intent.phase = "blocked";
        throw error;
      } finally {
        if (own === generation) busy = false;
      }
    },
  };
}
