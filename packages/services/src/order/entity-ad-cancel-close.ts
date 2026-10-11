import { AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { EntityAdCancelClosePlan, EntityAdCancelCloser } from "../tenant/index.js";
import { withdrawAdCancel } from "./ad-cancel.js";
import { boundOrder } from "./binding.js";
import type { CancelDeps } from "./cancel-context.js";
import {
  prelockAdCancelLowTargets,
  prelockAdCancelTargets,
  readAdCancelTargetGraph,
} from "./cancel-locks.js";

async function candidates(tx: Tx, entityId: string) {
  if (
    await tx.cancelRequest.findFirst({
      where: { entityId, status: "pending_approval", kind: { not: "ad_cancel" } },
      select: { id: true },
    })
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "主体存在尚不支持系统收尾的取消类型" });
  const rows = await tx.cancelRequest.findMany({
    where: { entityId, kind: "ad_cancel", status: "pending_approval" },
    select: {
      id: true,
      approvalRequest: {
        select: {
          id: true,
          kind: true,
          status: true,
          entityId: true,
          storeId: true,
          subjectType: true,
          subjectId: true,
        },
      },
      storeId: true,
      adId: true,
    },
    orderBy: { id: "asc" },
  });
  if (
    rows.some(
      (r) =>
        r.approvalRequest.kind !== "ad_cancel" ||
        r.approvalRequest.status !== "pending" ||
        r.approvalRequest.subjectType !== "ad" ||
        r.approvalRequest.subjectId !== r.adId ||
        r.approvalRequest.entityId !== entityId ||
        r.approvalRequest.storeId !== r.storeId,
    )
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "取消申请与审批关联已变化" });
  return rows.map((r) => r.id);
}
async function tenantGraph(tx: Tx, entityId: string) {
  const entity = await tx.entity.findUnique({ where: { id: entityId }, select: { id: true } });
  if (!entity) throw new AppError("NOT_FOUND");
  const [invitations, members, stores] = await Promise.all([
    tx.invitation.findMany({ where: { entityId }, select: { id: true }, orderBy: { id: "asc" } }),
    tx.entityMember.findMany({ where: { entityId }, select: { id: true }, orderBy: { id: "asc" } }),
    tx.store.findMany({ where: { entityId }, select: { id: true }, orderBy: { id: "asc" } }),
  ]);
  return {
    invitationIds: invitations.map((r) => r.id),
    memberIds: members.map((r) => r.id),
    storeIds: stores.map((r) => r.id),
  };
}
type Graph = Awaited<ReturnType<typeof readAdCancelTargetGraph>>;
async function adGraph(tx: Tx, graph: Graph) {
  return tx.ad.findMany({
    where: { id: { in: graph.adIds } },
    select: { id: true, entityId: true, storeId: true, status: true, openCancelRequestId: true },
    orderBy: { id: "asc" },
  });
}
type Witness = {
  plan: EntityAdCancelClosePlan;
  graph: Graph;
  ads: Awaited<ReturnType<typeof adGraph>>;
  deps: CancelDeps;
};
const prepared = new WeakMap<Tx, Map<string, Witness>>();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function runtime() {
  const deps = boundOrder().cancel;
  if (!deps) throw new AppError("INTERNAL", { message: "order 广告取消写侧尚未绑定运行时" });
  return deps;
}
async function unchanged(tx: Tx, witness: Witness) {
  const { plan, graph } = witness;
  if (
    !same(plan.requestIds, await candidates(tx, plan.entityId)) ||
    !same(
      { invitationIds: plan.invitationIds, memberIds: plan.memberIds, storeIds: plan.storeIds },
      await tenantGraph(tx, plan.entityId),
    ) ||
    !same(graph, await readAdCancelTargetGraph(tx, plan.requestIds)) ||
    !same(witness.ads, await adGraph(tx, graph))
  )
    throw new AppError("PRECONDITION_CHANGED", {
      message: "主体取消候选或锁图已变化，请重试整个事务",
    });
}

export const entityAdCancelCloser: EntityAdCancelCloser = {
  async prepare(tx, entityId, actorStaffIds = []) {
    const deps = runtime();
    const requestIds = await candidates(tx, entityId);
    const graph = await readAdCancelTargetGraph(tx, requestIds);
    const tenant = await tenantGraph(tx, entityId);
    const ads = await adGraph(tx, graph);
    if (
      graph.entityIds.some((id) => id !== entityId) ||
      graph.storeIds.some((id) => !tenant.storeIds.includes(id))
    )
      throw new AppError("PRECONDITION_CHANGED");
    // 新候选可能在等待主体锁时提交；取得所有低锁后只拒绝，不补任何低序锁。
    await prelockAdCancelLowTargets(tx, graph, actorStaffIds);
    await lockRows(tx, "entity", [entityId]);
    await lockRows(tx, "invitation", tenant.invitationIds);
    await lockRows(tx, "entity_member", tenant.memberIds);
    await lockRows(tx, "store", tenant.storeIds);
    const plan = Object.freeze({
      entityId,
      requestIds: Object.freeze(requestIds),
      invitationIds: Object.freeze(tenant.invitationIds),
      memberIds: Object.freeze(tenant.memberIds),
      storeIds: Object.freeze(tenant.storeIds),
    });
    const witness = { plan, graph, ads, deps };
    await unchanged(tx, witness);
    const entries = prepared.get(tx) ?? new Map<string, Witness>();
    entries.set(entityId, witness);
    prepared.set(tx, entries);
    return plan;
  },
  async withdraw(tx: Tx, ctx: IdentityContext, plan: EntityAdCancelClosePlan) {
    const deps = runtime();
    const witness = prepared.get(tx)?.get(plan.entityId);
    if (!witness || witness.plan !== plan || witness.deps !== deps)
      throw new AppError("INTERNAL", { message: "主体取消必须使用同事务真实预锁计划" });
    await unchanged(tx, witness);
    const entity = await tx.entity.findUniqueOrThrow({ where: { id: plan.entityId } });
    if (entity.lifecycle !== "closed" || entity.closedAt === null)
      throw new AppError("PRECONDITION_CHANGED", { message: "主体尚未真实关闭" });
    await prelockAdCancelTargets(tx, witness.graph);
    await unchanged(tx, witness);
    const actor = {
      ctx: createIdentityContext({
        actor: { type: "system", job: "entity.close" },
        entityId: plan.entityId,
        requestId: ctx.requestId,
      }),
    };
    for (const id of plan.requestIds)
      await withdrawAdCancel(tx, deps, actor, id, { note: "主体已关闭，系统撤回待审广告取消申请" });
    prepared.get(tx)?.delete(plan.entityId);
    return [...plan.requestIds];
  },
};
