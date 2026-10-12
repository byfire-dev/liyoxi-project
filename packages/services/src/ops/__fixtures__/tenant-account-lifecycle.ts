import type { PrismaClient } from "@liyoxi/db";
import { createFlow } from "../../flow/index.js";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import type { Assembly, IdentityContext, Tx, TxRunner } from "../../kernel/index.js";
import { createTenant } from "../../tenant/index.js";
import type { TenantDeps } from "../../tenant/index.js";
import { acceptHarness, APPID } from "../../tenant/__fixtures__/invitation-accept.js";
import { memberContext } from "../../tenant/__fixtures__/member-removal.js";
import { assertCurrentSessionForTest, snapshotTables, TEST_KEYRING } from "../../testing/index.js";
import { closeHarness, SLOW, TABLES } from "./admin-entity-close.js";

export { memberContext, SLOW };
export const LIFECYCLE_TABLES = [
  ...new Set([...TABLES, "merchant_user", "wechat_identity", "user_session", "agreement_consent"]),
];

/** 复用已验收的真实 billing/order/approval/timer 装配；只在竞争中使用真实登录与接受 producer。 */
export async function lifecycleHarness(prisma: PrismaClient) {
  const h = closeHarness(prisma);
  const sessions = await acceptHarness(prisma);
  function service(runner: TxRunner = h.tx, overrides: Partial<TenantDeps> = {}) {
    return createTenant({
      tx: runner,
      clock: h.clock,
      assembly: h.assembly,
      events: h.events,
      flow: h.flow,
      entityClose: { assembly: h.assembly, timers: h.timers },
      invitations: {
        keyring: () => TEST_KEYRING,
        timers: h.timers,
        checkRemark: async () => {},
        accept: {
          assertSession: (tx, principal, now) =>
            assertCurrentSessionForTest(tx, principal, now, APPID),
          checkName: async () => {},
        },
      },
      ...overrides,
    });
  }
  const tenant = service();
  async function world(draft = false) {
    const w = await h.world();
    if (draft)
      await prisma.entity.update({
        where: { id: w.entityId },
        data: { verificationStatus: "unsubmitted" },
      });
    return { ...w, memberCtx: memberContext(w.merchant.user.id, w.entityId, w.merchant.store.id) };
  }
  type World = Awaited<ReturnType<typeof world>>;
  async function clerk(w: World, stores = [w.merchant.store.id]) {
    const user = await h.make.merchantUser({ displayName: "保留账号姓名" });
    const member = await h.make.entityMember({
      entityId: w.entityId,
      merchantUserId: user.id,
      role: "clerk",
      displayName: "店员姓名",
      invitedByMemberId: w.merchant.owner.id,
      lastStoreId: stores[0] ?? null,
    });
    for (const storeId of stores)
      await h.make.storeMember({
        entityId: w.entityId,
        entityMemberId: member.id,
        storeId,
        addedByMemberId: w.merchant.owner.id,
      });
    return {
      user,
      member,
      ctx: memberContext(user.id, w.entityId, stores[0] ?? w.merchant.store.id),
    };
  }
  async function invitation(w: World, on = tenant) {
    const card = await on.createInvitation(
      w.memberCtx,
      { clientRequestId: uuidv7() },
      {
        principal: {
          merchantUserId: w.merchant.user.id,
          sessionId: uuidv7(),
          wechatIdentityId: uuidv7(),
          consentStamp: null,
        },
      },
    );
    return {
      ...card,
      row: await prisma.invitation.findUniqueOrThrow({ where: { id: card.invitationId } }),
    };
  }
  const directRunner: TxRunner = {
    run: async () => {
      throw new Error("callerTx 公口不得开启内部事务");
    },
  };
  function withAssembly(assembly: Assembly) {
    const flow = createFlow({ assembly, clock: h.clock, events: h.events });
    return service(directRunner, { assembly, flow, entityClose: { assembly, timers: h.timers } });
  }
  async function trace(id: string) {
    const [history, events, audits] = await Promise.all([
      prisma.statusTransition.findMany({ where: { subjectId: id }, orderBy: { seq: "asc" } }),
      prisma.outboxEvent.findMany({ where: { aggregateId: id }, orderBy: { seq: "asc" } }),
      prisma.auditLog.findMany({ where: { targetId: id }, orderBy: { seq: "asc" } }),
    ]);
    return { history, events, audits };
  }
  async function call(
    tx: Tx,
    kind: "abandon" | "close" | "remove" | "revoke",
    w: World,
    target: { memberId?: string; invitationId?: string } = {},
    on = service(directRunner),
  ) {
    if (kind === "abandon") return on.abandonDraftIn(tx, w.memberCtx);
    if (kind === "close") return on.closeEntityForOwnerDeletionIn(tx, w.memberCtx);
    if (kind === "remove") {
      if (!target.memberId) throw new Error("成员目标缺失");
      return on.removeMemberIn(tx, w.memberCtx, {
        kind: "owner_remove",
        memberId: target.memberId,
      });
    }
    if (!target.invitationId) throw new Error("邀请目标缺失");
    return on.revokeInvitationIn(tx, w.memberCtx, {
      invitationId: target.invitationId,
      reason: "by_owner",
    });
  }
  const system = (w: World): IdentityContext =>
    createIdentityContext({
      actor: { type: "system", job: "forged.lifecycle" },
      entityId: w.entityId,
      requestId: uuidv7(),
    });
  return {
    ...h,
    tenant,
    service,
    world,
    clerk,
    invitation,
    sessions,
    directRunner,
    withAssembly,
    trace,
    call,
    system,
    state: () => snapshotTables(prisma, LIFECYCLE_TABLES),
  };
}
export type LifecycleHarness = Awaited<ReturnType<typeof lifecycleHarness>>;
export type LifecycleWorld = Awaited<ReturnType<LifecycleHarness["world"]>>;
