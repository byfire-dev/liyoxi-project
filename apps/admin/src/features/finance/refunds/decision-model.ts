import {
  RefundApproveBodySchema,
  RefundRejectBodySchema,
  RefundWithdrawBodySchema,
  RefundVoidBodySchema,
  type z,
} from "@liyoxi/contract";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { canAction, type AccessSnapshot } from "../../../lib/permissions";
import type { RefundDetail } from "./api";
export const refundDecisionLabels = {
  approve: "通过审批",
  reject: "驳回",
  withdraw: "撤回",
  void: "作废",
} as const;
export type RefundDecision = keyof typeof refundDecisionLabels;
export type RefundDecisionFacts = Pick<
  RefundDetail,
  "source" | "status" | "actions" | "requester"
> & {
  approval: Pick<RefundDetail["approval"], "kind" | "actions" | "requester">;
};
export type RefundDecisionInput = Pick<
  RefundDetail,
  "refundRequestId" | "source" | "requestNo" | "amountFen"
> & {
  approval: Pick<RefundDetail["approval"], "approvalId" | "kind" | "lockVersion">;
};
export function refundDecisions(
  detail: RefundDecisionFacts,
  access: AccessSnapshot | null,
): RefundDecision[] {
  if (!access || detail.source === "staging_probe" || detail.approval.kind !== "plan_refund")
    return [];
  return (["approve", "reject", "withdraw", "void"] as const).filter((action) => {
    if (!detail.actions.includes(action)) return false;
    if (action === "void")
      return detail.status === "pending_execution" && canAction(access, "finance.refund.approve");
    if (detail.status !== "pending_approval" || !detail.approval.actions.includes(action))
      return false;
    return (
      action === "withdraw" ||
      (canAction(access, "finance.refund.approve") &&
        detail.requester?.staffId !== access.staff.id &&
        detail.approval.requester?.staffId !== access.staff.id)
    );
  });
}
type Command =
  | { action: "approve"; body: z.infer<typeof RefundApproveBodySchema> }
  | { action: "reject"; body: z.infer<typeof RefundRejectBodySchema> }
  | { action: "withdraw"; body: z.infer<typeof RefundWithdrawBodySchema> }
  | { action: "void"; body: z.infer<typeof RefundVoidBodySchema> };
export function refundDecisionCommand(
  detail: RefundDecisionInput,
  action: RefundDecision,
  note: string,
): Command {
  const confirm = { requestNo: detail.requestNo, amountFen: detail.amountFen };
  if (action === "approve")
    return {
      action,
      body: RefundApproveBodySchema.parse({
        lockVersion: detail.approval.lockVersion,
        note: note.trim() || undefined,
        confirm,
        confirmChecks: ["rule_amount_checked"],
      }),
    };
  if (action === "reject") return { action, body: RefundRejectBodySchema.parse({ note }) };
  if (action === "void") return { action, body: RefundVoidBodySchema.parse({ note, confirm }) };
  return { action, body: RefundWithdrawBodySchema.parse({ note: note.trim() || undefined }) };
}
/** 四种本域意图，原正文失败复用key；关闭scope取消且忽略迟到结果，不执行自动写重试。 */
export function createRefundDecisionIntent(makeKey = () => newIdempotencyKey("refund-decision")) {
  const keys = new Map<RefundDecision, { signature: string; key: string }>();
  let active = true,
    busy = false,
    generation = 0,
    controller = new AbortController();
  return {
    get pending() {
      return busy;
    },
    activate() {
      if (!active) {
        active = true;
        controller = new AbortController();
      }
    },
    close() {
      active = false;
      busy = false;
      generation += 1;
      controller.abort();
    },
    async submit<T>(command: Command, send: (key: string, signal: AbortSignal) => Promise<T>) {
      if (!active || busy) return undefined;
      const signature = JSON.stringify(command),
        old = keys.get(command.action),
        own = generation,
        signal = controller.signal,
        value = old?.signature === signature ? old : { signature, key: makeKey() };
      keys.set(command.action, value);
      busy = true;
      try {
        const result = await send(value.key, signal);
        if (!active || signal.aborted || generation !== own) return undefined;
        keys.delete(command.action);
        return result;
      } catch (error) {
        if (active && !signal.aborted && generation === own) throw error;
        return undefined;
      } finally {
        if (generation === own) busy = false;
      }
    },
  };
}
