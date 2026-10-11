import type { PrismaClient } from "@liyoxi/db";
import { createIdempotencyContext, invariantNow, uuidv7 } from "../../kernel/index.js";
import type { Assembly, IdentityContext, TxRunner } from "../../kernel/index.js";
import { createFactories, snapshotTables } from "../../testing/index.js";
import type { AdjustableClock } from "../../testing/index.js";
import { createInvitationExpiry, createTenant } from "../index.js";
import { invitationServices } from "./invitations.js";
import { memberContext, SLOW } from "./member-removal.js";
import { acceptHarness } from "./invitation-accept.js";

export { memberContext, SLOW };
export const TABLES = [
  "merchant_user",
  "entity",
  "store",
  "entity_member",
  "store_member",
  "invitation",
  "invitation_request",
  "timer",
  "portal_session",
  "status_transition",
  "audit_log",
  "outbox_event",
];

export function archiveServices(prisma: PrismaClient, clock?: AdjustableClock, runner?: TxRunner) {
  const base = invitationServices(prisma, clock, runner);
  const expiry = createInvitationExpiry({
    clock: base.clock,
    flow: base.flow,
    timers: base.timers,
  });
  const timerHandlers = base.assembly.timerHandlers.map(
    (item): Assembly["timerHandlers"][number] =>
      item.kind === "invitation.expire"
        ? { ...item, handle: (tx, timer) => expiry.handle(tx, timer) }
        : item,
  );
  const invariants = base.assembly.invariants.map((item): Assembly["invariants"][number] =>
    item.code === "tenant.I30"
      ? { ...item, run: (tx, scope, ctx) => expiry.checkI30(tx, scope, invariantNow(ctx)) }
      : item,
  );
  const assembly: Assembly = {
    ...base.assembly,
    timerHandlers,
    invariants,
    timerHandler: (kind) => timerHandlers.find((item) => item.kind === kind),
    invariant: (code) => invariants.find((item) => item.code === code),
  };
  const timerDeps = { ...base.timerDeps, assembly };
  const tenant = createTenant({ ...base, assembly, archiveTimers: base.timers });
  return { ...base, assembly, tenant, invitations: base.tenant, timerDeps };
}

export function archiveHarness(prisma: PrismaClient) {
  const service = archiveServices(prisma);
  const make = createFactories({ db: prisma, clock: service.clock });
  async function owner(verified = true) {
    // 已认证主体与两家门店是合法历史前提；不冒称本测试交付认证/新增门店入口。
    const merchant = await make.merchant({ verified });
    const second = await make.store({ entityId: merchant.entity.id });
    const userId = merchant.user.id;
    return {
      userId,
      memberId: merchant.owner.id,
      entityId: merchant.entity.id,
      storeId: merchant.store.id,
      secondId: second.id,
      ctx: memberContext(userId, merchant.entity.id, merchant.store.id),
    };
  }
  async function clerk(parent: Awaited<ReturnType<typeof owner>>, stores = [parent.secondId]) {
    const user = await make.merchantUser();
    const member = await make.entityMember({
      entityId: parent.entityId,
      merchantUserId: user.id,
      invitedByMemberId: parent.memberId,
      lastStoreId: stores[0] ?? null,
    });
    for (const storeId of stores)
      await make.storeMember({
        entityId: parent.entityId,
        entityMemberId: member.id,
        storeId,
        addedByMemberId: parent.memberId,
      });
    return {
      userId: user.id,
      memberId: member.id,
      ctx: memberContext(user.id, parent.entityId, stores[0]),
    };
  }
  async function card(parent: Awaited<ReturnType<typeof owner>>, storeId = parent.secondId) {
    return service.invitations.createInvitation(
      memberContext(parent.userId, parent.entityId, storeId),
      { clientRequestId: uuidv7() },
    );
  }
  async function trace(parent: Awaited<ReturnType<typeof owner>>) {
    const scope = { entityId: parent.entityId };
    const [entity, stores, members, links, invitations, timers, history, audits, events] =
      await Promise.all([
        prisma.entity.findUniqueOrThrow({ where: { id: parent.entityId } }),
        prisma.store.findMany({ where: scope, orderBy: { id: "asc" } }),
        prisma.entityMember.findMany({ where: scope, orderBy: { id: "asc" } }),
        prisma.storeMember.findMany({ where: scope, orderBy: { id: "asc" } }),
        prisma.invitation.findMany({ where: scope, orderBy: { id: "asc" } }),
        prisma.timer.findMany({ where: { entityId: parent.entityId }, orderBy: { id: "asc" } }),
        prisma.statusTransition.findMany({ where: scope, orderBy: { seq: "asc" } }),
        prisma.auditLog.findMany({ where: scope, orderBy: { seq: "asc" } }),
        prisma.outboxEvent.findMany({ where: scope, orderBy: { seq: "asc" } }),
      ]);
    return { entity, stores, members, links, invitations, timers, history, audits, events };
  }
  return {
    ...service,
    make,
    owner,
    clerk,
    card,
    trace,
    state: () => snapshotTables(prisma, TABLES),
  };
}
export type ArchiveHarness = ReturnType<typeof archiveHarness>;
/** 接受邀请前提使用已验收的真实登录/会话；归档仍由独立真实拥有者实例处理。 */
export async function archiveAcceptWorld(prisma: PrismaClient) {
  const accepted = await acceptHarness(prisma);
  return {
    ...accepted,
    archiveSide: (client: PrismaClient, runner?: TxRunner) =>
      archiveServices(client, accepted.clock, runner),
  };
}
export type Owner = Awaited<ReturnType<ArchiveHarness["owner"]>>;
export function archiveIdem(ctx: IdentityContext, storeId: string, key = uuidv7()) {
  return createIdempotencyContext({
    mode: "required",
    scope: "m.store.archive",
    actor: ctx.actor,
    key,
    request: { method: "POST", pathParams: { storeId }, body: null, storeId: ctx.storeId },
  });
}
