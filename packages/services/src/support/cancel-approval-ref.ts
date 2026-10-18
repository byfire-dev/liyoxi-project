import { record } from "../audit/index.js";
import { assertPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx } from "../kernel/index.js";

/** 与 order 的固定提交插点结构相同；没有 support→order 同层依赖。 */
interface Target {
  readonly actor: { readonly ctx: IdentityContext; readonly staff?: StaffContext };
  readonly approvalId: string;
  readonly adId: string;
  readonly entityId: string;
  readonly storeId: string;
}
interface Prepared {
  readonly target: Target;
  readonly actor: Target["actor"];
  readonly staffId: string;
  readonly ctx: IdentityContext;
  readonly staff: StaffContext;
  readonly signature: string;
  attached: boolean;
}
const signature = (target: Target) =>
  JSON.stringify([target.approvalId, target.adId, target.entityId, target.storeId]);

/**
 * a05 §3.62 专用审批引用。不是 a08 的四类 processing 补关联入口：
 * 不增加客服权限、taskScope、待分配池或状态限制；已结工单仅保留历史引用。
 * 应用把这对回调传给 order；早取270，晚只重入，整个组合使用调用方同一Tx。
 */
export function createAdCancelApprovalRefCompanion(options: {
  readonly serviceTicketId: string;
  readonly clock: Clock;
}) {
  const { serviceTicketId, clock } = options;
  const prepared = new WeakMap<Tx, Prepared>();
  const ticket = async (tx: Tx, target: Target) => {
    const row = await tx.serviceTicket.findFirst({
      where: {
        id: serviceTicketId,
        entityId: target.entityId,
        storeId: target.storeId,
      },
    });
    if (!row) throw new AppError("NOT_FOUND");
    return row;
  };
  return {
    async beforeAccount(tx: Tx, target: Target): Promise<void> {
      const { ctx, staff } = target.actor;
      if (ctx.actor.type !== "staff" || !staff || ctx.actor.id !== staff.staff.id)
        throw new AppError("PERMISSION_DENIED");
      assertPermission(staff, "order.refund.request", clock.now());
      if (!(await tx.staff.findFirst({ where: { id: ctx.actor.id, status: "active" } })))
        throw new AppError("PERMISSION_DENIED");
      if (
        prepared.has(tx) ||
        (await tx.approvalRequest.findUnique({ where: { id: target.approvalId } }))
      )
        throw new AppError("INTERNAL", { message: "审批引用必须属于本次真实提交" });
      await lockRows(tx, "service_ticket", [serviceTicketId]);
      await ticket(tx, target);
      prepared.set(tx, {
        target,
        actor: target.actor,
        staffId: ctx.actor.id,
        ctx,
        staff,
        signature: signature(target),
        attached: false,
      });
    },
    async afterCreated(tx: Tx, target: Target): Promise<void> {
      const plan = prepared.get(tx);
      if (
        !plan ||
        plan.target !== target ||
        plan.actor !== target.actor ||
        plan.ctx !== target.actor.ctx ||
        plan.staff !== target.actor.staff ||
        plan.ctx.actor.type !== "staff" ||
        plan.ctx.actor.id !== plan.staffId ||
        plan.staff.staff.id !== plan.staffId ||
        plan.signature !== signature(target)
      )
        throw new AppError("INTERNAL", { message: "审批引用缺少本事务的真实预锁" });
      await lockRows(tx, "service_ticket", [serviceTicketId]);
      const row = await ticket(tx, target);
      const approval = await tx.approvalRequest.findUnique({ where: { id: target.approvalId } });
      if (
        !approval ||
        approval.kind !== "ad_cancel" ||
        approval.subjectType !== "ad" ||
        approval.subjectId !== target.adId ||
        approval.entityId !== row.entityId ||
        approval.storeId !== row.storeId ||
        approval.submitActorType !== "staff" ||
        approval.submitActorId !== plan.ctx.actor.id ||
        approval.requesterStaffId !== plan.ctx.actor.id
      )
        throw new AppError("PRECONDITION_CHANGED");
      const key = {
        serviceTicketId: row.id,
        refType: "approval_request",
        refId: approval.id,
      };
      const existing = await tx.serviceTicketRef.findUnique({
        where: { serviceTicketId_refType_refId: key },
      });
      if (plan.attached) {
        if (!existing) throw new AppError("PRECONDITION_CHANGED");
        return;
      }
      if (approval.status !== "pending") throw new AppError("PRECONDITION_CHANGED");
      if (existing)
        throw new AppError("SERVICE_TICKET_REF_EXISTS", {
          details: { refType: key.refType, refId: key.refId },
        });
      // 与本次审批同时建立，不能晚于 approval.submitted 而吞掉首次业务事件。
      await tx.serviceTicketRef.create({ data: { ...key, createdAt: approval.createdAt } });
      await record(
        tx,
        plan.ctx.actor,
        {
          requestId: plan.ctx.requestId,
          ip: plan.ctx.ip,
          userAgent: plan.ctx.userAgent,
          authMethod: null,
          sessionId: null,
        },
        {
          stream: "activity",
          category: "service_ticket",
          action: "support.service_ticket.ref_add",
          summary: "关联广告取消审批",
          target: { type: "service_ticket", id: row.id, label: row.ticketNo },
          entityId: row.entityId,
          storeId: row.storeId,
          before: null,
          after: { refType: key.refType, refId: key.refId, requestNo: approval.requestNo },
          fields: ["refType", "refId", "requestNo"],
        },
      );
      plan.attached = true;
    },
  };
}
