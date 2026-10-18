import type {
  PointAdjustmentRequestCreateBody,
  TermExtensionRequestCreateBody,
  PointAdjustmentApproveBody,
  TermExtensionApproveBody,
  BillingAdjustmentRejectBody,
  BillingAdjustmentWithdrawBody,
  PointAdjustmentInput,
} from "@liyoxi/contract";
import type { ApprovalRequest } from "@liyoxi/db";
import { AppError, uuidv7 } from "../../kernel/index.js";
import type { IdempotencyContext, Tx } from "../../kernel/index.js";
import { assertPermission } from "../../authz/index.js";
import type { AuditEntry } from "../../audit/index.js";
import type { BillingAdjustmentDeps, AdjustmentActor } from "./context.js";
import { assertAdjustmentActor, adjustmentAccountInScope } from "./context.js";
import { adjustmentQuote, extensionQuote } from "./quotes.js";
import { assertAdjustmentVisible, pointAdjustmentDetail, termExtensionDetail } from "./read.js";

export type { BillingAdjustmentDeps, BillingApprovalRefs, AdjustmentActor } from "./context.js";
export { createAdjustmentAssembly } from "./assembly.js";
type Options = { readonly idem?: IdempotencyContext };
type Kind = "points_adjust" | "subscription_extend";
type Event = "approve" | "reject" | "withdraw";
function audit(
  kind: Kind,
  action: "submit" | Event,
  entityId: string,
  approvalId?: string,
): AuditEntry {
  return {
    stream: "ops",
    category: kind === "points_adjust" ? "points_adjust" : "term_adjust",
    action: `billing.${kind}.${action}`,
    summary: `${kind === "points_adjust" ? "积分调整" : "补偿延长"}：${action === "submit" ? "提交" : action === "approve" ? "通过" : action === "reject" ? "驳回" : "撤回"}`,
    entityId,
    storeId: null,
    target: approvalId
      ? { type: "approval_request", id: approvalId }
      : { type: "entity", id: entityId },
  };
}
export function createBillingAdjustments(deps: BillingAdjustmentDeps) {
  async function enabled(tx: Tx, actor: AdjustmentActor) {
    if (
      !(await tx.staff.findFirst({
        where: { id: actor.staff.staff.id, status: "active" },
        select: { id: true },
      }))
    )
      throw new AppError("PERMISSION_DENIED");
  }
  async function request(tx: Tx, kind: Kind, id: string) {
    const r =
      kind === "points_adjust"
        ? await tx.pointAdjustmentRequest.findUnique({
            where: { id },
            include: { approvalRequest: true },
          })
        : await tx.termExtensionRequest.findUnique({
            where: { id },
            include: { approvalRequest: true },
          });
    if (!r || r.approvalRequest.kind !== kind) throw new AppError("NOT_FOUND");
    return r;
  }
  function decidePermission(kind: Kind) {
    return kind === "points_adjust"
      ? ("billing.adjust.approve" as const)
      : ("billing.extension.approve" as const);
  }
  async function assertWithdraw(tx: Tx, actor: AdjustmentActor, row: ApprovalRequest) {
    if (row.requesterStaffId === actor.staff.staff.id) return;
    assertPermission(
      actor.staff,
      decidePermission(row.kind === "points_adjust" ? "points_adjust" : "subscription_extend"),
      deps.clock.now(),
    );
    // 决定资格/同组/申请人停用仍由公共withdraw在员工20→审批30锁内正式复核。
    await assertAdjustmentVisible(tx, actor.staff, row, true);
  }
  async function decide(
    actor: AdjustmentActor,
    kind: Kind,
    id: string,
    event: Event,
    body:
      | PointAdjustmentApproveBody
      | TermExtensionApproveBody
      | BillingAdjustmentRejectBody
      | BillingAdjustmentWithdrawBody,
    options: Options,
  ) {
    assertAdjustmentActor(deps, actor, event === "withdraw" ? undefined : decidePermission(kind));
    // 权限/动态再验证在required幂等查找之前执行，撤回成功后的原键仍可重放。
    await deps.tx.run(async (tx) => {
      await enabled(tx, actor);
      const r = await request(tx, kind, id);
      if (event === "withdraw") await assertWithdraw(tx, actor, r.approvalRequest);
      else await assertAdjustmentVisible(tx, actor.staff, r.approvalRequest, true);
    });
    return deps.tx.run(async (tx) => {
      const r = await request(tx, kind, id),
        common = {
          approvalId: r.approvalRequestId,
          staff: actor.staff,
          args: body,
          audit: audit(kind, event, r.entityId, r.approvalRequestId),
        };
      if (event === "approve") {
        if (!("lockVersion" in body) || !("confirmChecks" in body))
          throw new AppError("VALIDATION_FAILED");
        await deps.approval.approve(tx, actor.identity, {
          ...common,
          lockVersion: body.lockVersion,
          confirmChecks: body.confirmChecks,
        });
      } else if (event === "reject") {
        if (!("note" in body) || !body.note) throw new AppError("VALIDATION_FAILED");
        await deps.approval.reject(tx, actor.identity, {
          ...common,
          note: body.note,
          ...("reasonCodes" in body && body.reasonCodes ? { reasonCodes: body.reasonCodes } : {}),
        });
      } else
        await deps.approval.withdraw(tx, actor.identity, {
          ...common,
          ...("note" in body ? { note: body.note } : {}),
        });
      return kind === "points_adjust"
        ? pointAdjustmentDetail(tx, deps, actor.staff, id, true)
        : termExtensionDetail(tx, deps, actor.staff, id, true);
    }, options);
  }
  return {
    adjustmentQuote: async (
      actor: AdjustmentActor,
      entityId: string,
      input: PointAdjustmentInput,
    ) => {
      assertAdjustmentActor(deps, actor, "billing.adjust.request");
      return deps.tx.run(async (tx) => {
        await adjustmentAccountInScope(tx, actor.staff, entityId);
        return adjustmentQuote(tx, entityId, input, deps.clock.now());
      });
    },
    extensionQuote: async (actor: AdjustmentActor, id: string, days: number) => {
      assertAdjustmentActor(deps, actor, "billing.extension.request");
      return deps.tx.run(async (tx) => {
        const term = await tx.subscriptionTerm.findUnique({ where: { id } });
        if (!term) throw new AppError("NOT_FOUND");
        await adjustmentAccountInScope(tx, actor.staff, term.entityId);
        return extensionQuote(tx, term.entityId, id, days, deps.clock.now());
      });
    },
    points: {
      get: (staff: AdjustmentActor["staff"], id: string) =>
        deps.tx.run((tx) => pointAdjustmentDetail(tx, deps, staff, id)),
      create: async (
        actor: AdjustmentActor,
        input: PointAdjustmentRequestCreateBody,
        options: Options = {},
      ) => {
        assertAdjustmentActor(deps, actor, "billing.adjust.request");
        await deps.tx.run(async (tx) => {
          await enabled(tx, actor);
          await adjustmentAccountInScope(tx, actor.staff, input.pointAccountId);
        });
        return deps.tx.run(async (tx) => {
          const id = uuidv7(),
            now = deps.clock.now(),
            a = await deps.approval.submit(tx, actor.identity, {
              kind: "points_adjust",
              subjectType: "billing_account",
              subjectId: input.pointAccountId,
              entityId: input.pointAccountId,
              storeId: input.storeId ?? null,
              idempotencyKey: options.idem?.key ?? null,
              input: { id, body: input },
              audit: audit("points_adjust", "submit", input.pointAccountId),
            });
          await tx.pointAdjustmentRequest.create({
            data: {
              id,
              approvalRequestId: a.approvalId,
              entityId: input.pointAccountId,
              direction: input.direction,
              lotKind: input.lotKind,
              adjustPoints: input.adjustPoints,
              reasonCode: input.reasonCode,
              note: input.note,
              pointHoldId: input.pointHoldId ?? null,
              termExtensionRequestId: input.termExtensionRequestId ?? null,
              spendableBeforePoints: input.confirm.spendableBeforePoints,
              createdAt: now,
              updatedAt: now,
            },
          });
          if (input.serviceTicketId)
            await deps.refs.attach(tx, {
              serviceTicketId: input.serviceTicketId,
              entityId: input.pointAccountId,
              approvalRequestId: a.approvalId,
            });
          return pointAdjustmentDetail(tx, deps, actor.staff, id, true);
        }, options);
      },
      approve: (
        actor: AdjustmentActor,
        id: string,
        body: PointAdjustmentApproveBody,
        options: Options = {},
      ) => decide(actor, "points_adjust", id, "approve", body, options),
      reject: (
        actor: AdjustmentActor,
        id: string,
        body: BillingAdjustmentRejectBody,
        options: Options = {},
      ) => decide(actor, "points_adjust", id, "reject", body, options),
      withdraw: (
        actor: AdjustmentActor,
        id: string,
        body: BillingAdjustmentWithdrawBody,
        options: Options = {},
      ) => decide(actor, "points_adjust", id, "withdraw", body, options),
    },
    extensions: {
      get: (staff: AdjustmentActor["staff"], id: string) =>
        deps.tx.run((tx) => termExtensionDetail(tx, deps, staff, id)),
      create: async (
        actor: AdjustmentActor,
        input: TermExtensionRequestCreateBody,
        options: Options = {},
      ) => {
        assertAdjustmentActor(deps, actor, "billing.extension.request");
        await deps.tx.run(async (tx) => {
          await enabled(tx, actor);
          const term = await tx.subscriptionTerm.findUnique({
            where: { id: input.subscriptionTermId },
          });
          if (!term) throw new AppError("NOT_FOUND");
          await adjustmentAccountInScope(tx, actor.staff, term.entityId);
        });
        return deps.tx.run(async (tx) => {
          const term = await tx.subscriptionTerm.findUniqueOrThrow({
              where: { id: input.subscriptionTermId },
            }),
            id = uuidv7(),
            now = deps.clock.now(),
            a = await deps.approval.submit(tx, actor.identity, {
              kind: "subscription_extend",
              subjectType: "subscription_term",
              subjectId: term.id,
              entityId: term.entityId,
              idempotencyKey: options.idem?.key ?? null,
              input: { id, body: input },
              audit: audit("subscription_extend", "submit", term.entityId),
            });
          await tx.termExtensionRequest.create({
            data: {
              id,
              approvalRequestId: a.approvalId,
              entityId: term.entityId,
              subscriptionTermId: term.id,
              days: input.days,
              reasonCode: input.reasonCode,
              note: input.note,
              createdAt: now,
              updatedAt: now,
            },
          });
          return termExtensionDetail(tx, deps, actor.staff, id, true);
        }, options);
      },
      approve: (
        actor: AdjustmentActor,
        id: string,
        body: TermExtensionApproveBody,
        options: Options = {},
      ) => decide(actor, "subscription_extend", id, "approve", body, options),
      reject: (
        actor: AdjustmentActor,
        id: string,
        body: BillingAdjustmentRejectBody,
        options: Options = {},
      ) => decide(actor, "subscription_extend", id, "reject", body, options),
      withdraw: (
        actor: AdjustmentActor,
        id: string,
        body: BillingAdjustmentWithdrawBody,
        options: Options = {},
      ) => decide(actor, "subscription_extend", id, "withdraw", body, options),
    },
  };
}
