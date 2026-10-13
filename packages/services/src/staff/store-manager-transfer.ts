import { ManagerTransferBodySchema, ManagerTransferResultSchema } from "@liyoxi/contract";
import {
  assertConfirm,
  authorize,
  buildStaffContext,
  isStaffRoleKey,
  normalizeRoleConfig,
  scopeCovers,
  storeScope,
} from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { record } from "../audit/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import type { IdentityContext, StaffWorkSources, Tx, TxRunOptions } from "../kernel/index.js";
import type { StaffManagementDeps } from "./management-deps.js";
import { staffBriefOf } from "./me.js";
import { transferWork, workSources } from "./work.js";

export function createStoreManagerTransfers(deps: StaffManagementDeps) {
  async function access(tx: Tx, previous: StaffContext, storeId: string) {
    const row = await tx.staff.findUnique({ where: { id: previous.staff.id } });
    if (!row || row.status !== "active" || !isStaffRoleKey(row.staffRoleKey))
      throw new AppError("PERMISSION_DENIED");
    const role = await tx.staffRole.findUniqueOrThrow({ where: { key: row.staffRoleKey } });
    const members = row.staffGroupId
      ? await tx.staff.findMany({
          where: { staffGroupId: row.staffGroupId, status: "active" },
          select: { id: true },
        })
      : [];
    const current = buildStaffContext({
      staff: {
        id: row.id,
        roleKey: row.staffRoleKey,
        isLead: row.isLead,
        staffGroupId: row.staffGroupId,
      },
      role: normalizeRoleConfig(row.staffRoleKey, role),
      groupStaffIds: members.map((r) => r.id),
      stepUpAt: previous.stepUpAt,
    });
    authorize(
      current,
      {
        module: { module: "merchant", need: "view" },
        permission: "merchant.manager.transfer",
      },
      deps.clock.now(),
    );
    const store = await tx.store.findFirst({
      where: { id: storeId, ...storeScope(current.scope) },
    });
    if (!store) throw new AppError("NOT_FOUND");
    return { current, store };
  }
  return {
    async reassignStoreDeliveryManager(
      previous: StaffContext,
      actor: IdentityContext,
      storeId: string,
      raw: unknown,
      options: TxRunOptions = {},
    ) {
      if (
        actor.actor.type !== "staff" ||
        actor.actor.client !== "admin" ||
        actor.actor.id !== previous.staff.id ||
        actor.entityId ||
        actor.storeId
      )
        throw new AppError("PERMISSION_DENIED");
      const parsed = ManagerTransferBodySchema.safeParse(raw);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      const input = parsed.data;
      // 重放只重验当前权限与范围；原confirm是首次写守卫，不拒绝已经成功的同键回执。
      await deps.tx.run((tx) => access(tx, previous, storeId));
      return deps.tx.run(async (tx) => {
        await lockRows(
          tx,
          "staff",
          [...new Set([previous.staff.id, input.confirm.fromStaffId, input.toStaffId])].sort(),
          "share",
        );
        const first = await access(tx, previous, storeId);
        const to = await tx.staff.findUnique({ where: { id: input.toStaffId } });
        const refuse = (
          reason: "not_active" | "role_mismatch" | "same_as_current" | "out_of_scope",
        ): never => {
          throw new AppError("ASSIGNEE_INVALID", { details: { staffId: input.toStaffId, reason } });
        };
        if (!to || to.status !== "active") return refuse("not_active");
        if (to.staffRoleKey !== "delivery_manager") refuse("role_mismatch");
        if (!scopeCovers(first.current.scope, to.id)) refuse("out_of_scope");
        await lockRows(tx, "store", [storeId]);
        const { current, store } = await access(tx, previous, storeId);
        if (!scopeCovers(current.scope, to.id)) refuse("out_of_scope");
        if (!store.deliveryManagerId) throw new AppError("STORE_MANAGER_UNASSIGNED");
        assertConfirm(input.confirm, { fromStaffId: store.deliveryManagerId });
        if (store.deliveryManagerId === to.id) refuse("same_as_current");
        const from = await tx.staff.findUniqueOrThrow({ where: { id: store.deliveryManagerId } });
        const orders = deps.storeManagerOrders;
        if (!orders) throw new TypeError("单店经理转移缺少订单拥有者公口");
        const base = workSources(deps),
          scope = { storeId, entityId: store.entityId };
        let plannedNullIds: ReadonlySet<string> | undefined;
        let currentNullIds: readonly string[] = [];
        const scoped: StaffWorkSources = {
          async read(t, query) {
            const items = (await base.read(t, query)).filter(
              (item) =>
                item.source === "store_manager" &&
                item.storeId === storeId &&
                item.entityId === store.entityId,
            );
            const nullIds = await orders.readUnassignedIds(t, scope);
            if (plannedNullIds && nullIds.some((id) => !plannedNullIds!.has(id)))
              throw new AppError("BUSY", { message: "空负责人订单锁图已变化，请重试" });
            plannedNullIds ??= new Set(nullIds);
            currentNullIds = nullIds;
            if (!items.some((item) => item.subjectType === "store" && item.subjectId === storeId))
              throw new AppError("BUSY");
            return items.map((item) =>
              item.subjectType === "store"
                ? {
                    ...item,
                    locks: [
                      ...item.locks,
                      ...nullIds.map((id) => ({ table: "drama_order" as const, id })),
                    ],
                  }
                : item,
            );
          },
          async reassign(t, request) {
            if (
              request.items.some(
                (item) =>
                  item.source !== "store_manager" ||
                  item.storeId !== storeId ||
                  item.entityId !== store.entityId,
              )
            )
              throw new TypeError("单店转移范围不一致");
            await orders.syncUnassigned(t, {
              ...scope,
              ids: currentNullIds,
              staffId: to.id,
              now: request.now,
            });
            return base.reassign(t, request);
          },
        };
        const batch = await transferWork(tx, { ...deps, workSources: scoped }, actor, {
          from,
          to,
          reason: input.reasonCode,
          note: input.note,
        });
        if (!batch.batchId) throw new AppError("BUSY");
        const history = await tx.assignmentHistory.findFirstOrThrow({
          where: {
            batchId: batch.batchId,
            source: "store_manager",
            subjectType: "store",
            subjectId: storeId,
          },
          select: { id: true, contactDueAt: true },
        });
        if (!history.contactDueAt) throw new TypeError("本批门店联系时限缺失");
        const count = (subject: "drama_order" | "delivery_ticket" | "service_ticket") =>
          batch.moved
            .filter((r) => r.subjectType === subject)
            .reduce((total, r) => total + r.count, 0);
        const moved = {
          dramaOrderCount: count("drama_order"),
          deliveryTicketCount: count("delivery_ticket"),
          // M5客服拥有者尚未登记；不造事项、状态历史或移交成功计数。
          serviceTicketCount: count("service_ticket"),
        };
        await record(
          tx,
          actor.actor,
          {
            requestId: actor.requestId,
            ip: actor.ip,
            userAgent: actor.userAgent,
            sessionId: null,
            authMethod: null,
          },
          {
            stream: "ops",
            category: "manager_assign",
            action: "tenant.store.assign_manager",
            summary: "转移门店交付经理",
            target: { type: "store", id: storeId, label: store.name },
            entityId: store.entityId,
            storeId,
            before: { deliveryManagerId: from.id },
            after: { deliveryManagerId: to.id },
            fields: ["deliveryManagerId"],
            reason: { code: input.reasonCode, ...(input.note ? { text: input.note } : {}) },
            meta: { batchId: batch.batchId, impact: moved },
          },
        );
        return ManagerTransferResultSchema.parse({
          storeId,
          deliveryManager: staffBriefOf(to),
          batchId: batch.batchId,
          moved,
          contact: {
            assignmentHistoryId: history.id,
            storeId,
            toStaff: staffBriefOf(to),
            contactDueAt: history.contactDueAt.toISOString(),
            contactedAt: null,
            contactedBy: null,
          },
        });
      }, options);
    },
  };
}
