import type { PrismaClient } from "@liyoxi/db";

import { createEvents } from "../../events/index.js";
import { createFlow } from "../../flow/index.js";
import {
  createIdempotencyContext,
  createIdentityContext,
  createTxRunner,
  defineRegistration,
  implement,
  lockRows,
  uuidv7,
} from "../../kernel/index.js";
import type { IdentityContext, TxRunner } from "../../kernel/index.js";
import { assembleForTest, createClock, createFactories } from "../../testing/index.js";
import type { AdjustableClock } from "../../testing/index.js";
import { billingAccountPort, createTenant } from "../index.js";

export const SLOW = 120_000;

export function memberContext(userId: string, entityId?: string, storeId?: string) {
  return createIdentityContext({
    actor: { type: "merchant", id: userId, client: "weapp" },
    ...(entityId === undefined ? {} : { entityId }),
    ...(storeId === undefined ? {} : { storeId }),
    requestId: `req_remove_${uuidv7().slice(-24)}`,
    ip: "203.0.113.17",
  });
}

export function removalServices(
  prisma: PrismaClient,
  clock: AdjustableClock = createClock(),
  runner?: TxRunner,
) {
  const tx = runner ?? createTxRunner({ prisma, appEnv: "test" });
  const assembly = assembleForTest({
    entry: "api",
    withoutRealPorts: [billingAccountPort],
    extra: [
      defineRegistration("lyxtest_member_removal", {
        portImplementations: [
          implement(billingAccountPort, {
            async ensureForEntity(handle, _ctx, entityId) {
              await createFactories({ db: handle, clock }).billingAccount({ entityId });
              await lockRows(handle, "billing_account", [entityId], "update");
            },
          }),
        ],
      }),
    ],
  });
  const events = createEvents({ tx, clock, assembly });
  const flow = createFlow({ assembly, clock, events });
  const tenant = createTenant({ tx, clock, flow, assembly });
  return { prisma, clock, tx, assembly, events, flow, tenant };
}

export function removalHarness(prisma: PrismaClient) {
  const services = removalServices(prisma);
  const { clock, tenant } = services;
  const make = createFactories({ db: prisma, clock });
  async function owner() {
    const user = await make.merchantUser();
    const created = await tenant.createEntity(memberContext(user.id));
    const ctx = memberContext(user.id, created.entityId, created.storeId);
    return { userId: user.id, ctx, ...created };
  }
  // 接受邀请不属本片：用工厂建立合法的历史店员/门店关系，
  // 不宣称本测试执行了尚未交付的邀请 producer。
  async function clerk(parent: Awaited<ReturnType<typeof owner>>, stores = [parent.storeId]) {
    const user = await make.merchantUser();
    const member = await make.entityMember({
      entityId: parent.entityId,
      merchantUserId: user.id,
      role: "clerk",
      lastStoreId: stores[0] ?? null,
      invitedByMemberId: parent.memberId,
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
      entityId: parent.entityId,
      storeId: stores[0] ?? parent.storeId,
      ctx: memberContext(user.id, parent.entityId, stores[0] ?? parent.storeId),
    };
  }
  async function trace(memberId: string) {
    const where = { subjectId: memberId, machine: "entity_member" };
    const [member, stores, history, audits, events] = await Promise.all([
      prisma.entityMember.findUniqueOrThrow({ where: { id: memberId } }),
      prisma.storeMember.findMany({
        where: { entityMemberId: memberId },
        orderBy: { storeId: "asc" },
      }),
      prisma.statusTransition.findMany({ where, orderBy: { seq: "asc" } }),
      prisma.auditLog.findMany({ where: { targetId: memberId }, orderBy: { seq: "asc" } }),
      prisma.outboxEvent.findMany({ where: { aggregateId: memberId }, orderBy: { seq: "asc" } }),
    ]);
    return { member, stores, history, audits, events };
  }
  return { ...services, make, owner, clerk, trace };
}

export type RemovalHarness = ReturnType<typeof removalHarness>;
export type Owner = Awaited<ReturnType<RemovalHarness["owner"]>>;
export type Clerk = Awaited<ReturnType<RemovalHarness["clerk"]>>;

export function removalIdem(
  ctx: IdentityContext,
  input: { mode: "remove" | "leave"; key: string; memberId?: string; storeId?: string },
) {
  return createIdempotencyContext({
    mode: "required",
    scope: input.mode === "remove" ? "m.member.remove" : "m.me.membership.leave",
    actor: ctx.actor,
    key: input.key,
    request: {
      method: "POST",
      pathParams: input.mode === "remove" ? { memberId: input.memberId } : {},
      body: {},
      storeId: input.storeId ?? ctx.storeId,
    },
  });
}

export function barrier(parties: number) {
  let arrived = 0;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => (release = resolve));
  return async () => {
    arrived += 1;
    if (arrived === parties) release();
    await ready;
  };
}
