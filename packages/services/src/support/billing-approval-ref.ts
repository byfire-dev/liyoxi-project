// 计费审批的客服依据：归support拥有，组合根注入billing，L2不反向访问L3表。
import { AppError, lockRows } from "../kernel/index.js";
import type { Clock, Tx } from "../kernel/index.js";

interface TicketTarget {
  readonly serviceTicketId: string;
  readonly entityId: string;
}
export function createBillingApprovalRefs(options: { readonly clock: Clock }) {
  async function prepare(tx: Tx, input: TicketTarget): Promise<void> {
    await lockRows(tx, "service_ticket", [input.serviceTicketId]);
    if (
      !(await tx.serviceTicket.findFirst({
        where: { id: input.serviceTicketId, entityId: input.entityId },
        select: { id: true },
      }))
    )
      throw new AppError("VALIDATION_FAILED", {
        details: {
          fieldErrors: [{ path: "serviceTicketId", message: "客服工单必须属于当前主体" }],
        },
      });
  }
  return {
    /** 在approval.submit的validate中调用：staff20之后，其他业务锁/账户420之前。 */
    prepare,
    async attach(
      tx: Tx,
      input: TicketTarget & { readonly approvalRequestId: string },
    ): Promise<void> {
      // 先前已预锁时仅重入；若调用方漏预锁却已拿420，这里由正式锁序守卫拒绝。
      await prepare(tx, input);
      const approval = await tx.approvalRequest.findFirst({
        where: {
          id: input.approvalRequestId,
          entityId: input.entityId,
          kind: { in: ["points_adjust", "plan_refund"] },
          status: "pending",
          submitActorType: "staff",
        },
      });
      if (!approval) throw new AppError("PRECONDITION_CHANGED");
      await tx.serviceTicketRef.create({
        data: {
          serviceTicketId: input.serviceTicketId,
          refType: "approval_request",
          refId: approval.id,
          createdAt: options.clock.now(),
        },
      });
    },
    async list(tx: Tx, input: { readonly approvalRequestId: string; readonly entityId: string }) {
      const rows = await tx.serviceTicketRef.findMany({
        where: {
          refType: "approval_request",
          refId: input.approvalRequestId,
          serviceTicket: { entityId: input.entityId },
        },
        include: { serviceTicket: { select: { id: true, ticketNo: true } } },
        orderBy: [{ createdAt: "asc" }, { serviceTicketId: "asc" }],
        take: 100,
      });
      return rows.map(({ serviceTicket }) => ({
        serviceTicketId: serviceTicket.id,
        ticketNo: serviceTicket.ticketNo,
      }));
    },
  };
}
