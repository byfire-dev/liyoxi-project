import { createHash } from "node:crypto";

import { AdPricingSnapshotSchema } from "@liyoxi/contract";
import { createPrismaClient } from "@liyoxi/db";
import type { Prisma } from "@liyoxi/db";
import { testDatabaseUrl } from "@liyoxi/db/testing/standalone";
import { beforeAll, describe, expect, it } from "vitest";

import { createApproval } from "../approval/index.js";
import { ownTaskScope } from "../authz/index.js";
import { createFlow } from "../flow/index.js";
import type { Flow } from "../flow/index.js";
import { createBizNoIssuer, createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { bindOrder, createAdCancel, quoteAdCancel } from "../order/index.js";
import type { CancelDeps } from "../order/index.js";
import { createSla } from "../sla/index.js";
import {
  assembleForTest,
  createFactories,
  createLedgerHarness,
  openTerm,
  sampleStaffContext,
  seedBillingDeletionFacts,
  useSeededDatabase,
} from "../testing/index.js";
import { createTimers, timerKey } from "../timers/index.js";
import { closeEntityIn, findI17Violations, findI28Violations } from "./index.js";
import type { CloseEntityActor, CloseEntityInput } from "./index.js";

const db = useSeededDatabase("services", { label: "tenantclose", max: 4 });
let h: ReturnType<typeof createLedgerHarness>;
let sequence = 0;
beforeAll(async () => {
  h = createLedgerHarness(await db.prisma());
}, 120_000);

function runtime(flowTransform?: (flow: Flow) => Flow) {
  const assembly = assembleForTest({ entry: "api" });
  const realFlow = createFlow({ assembly, clock: h.clock, events: h.events });
  const flow = flowTransform?.(realFlow) ?? realFlow;
  const timers = createTimers({ assembly });
  const sla = createSla({ assembly, clock: h.clock });
  const approval = createApproval({
    assembly,
    clock: h.clock,
    flow,
    events: h.events,
    timers,
    sla,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
  });
  const cancel: CancelDeps = {
    tx: h.tx,
    clock: h.clock,
    approval,
    flow,
    ledger: h.ledger,
    events: h.events,
    timers,
    sla,
  };
  return { assembly, flow, timers, cancel, clock: h.clock };
}
async function person(): Promise<CloseEntityActor> {
  const group = await h.prisma.staffGroup.findFirstOrThrow({
    where: { staffRoleKey: "super_admin", isDefault: true },
  });
  const row = await h.make.staff({
    staffRoleKey: "super_admin",
    staffGroupId: group.id,
    isLead: true,
  });
  return {
    ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
    staff: await sampleStaffContext(h.prisma, row.id, { stepUpAt: h.clock.now() }),
  };
}
async function fixture() {
  const merchant = await h.make.merchant({ verified: true });
  const actor = await person();
  return {
    merchant,
    actor,
    input: {
      entityId: merchant.entity.id,
      reasonText: "经营主体主动申请结束经营服务",
      confirm: { activeStoreCount: 1, activeMemberCount: 1 },
    } satisfies CloseEntityInput,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function bound<T>(r: ReturnType<typeof runtime>, fn: () => Promise<T>) {
  const unbind = bindOrder(r);
  try {
    return await fn();
  } finally {
    unbind();
  }
}
function close(f: Fixture, r = runtime(), input = f.input, actor = f.actor) {
  return bound(r, () => h.tx.run((tx) => closeEntityIn(tx, r, actor, input)));
}
async function snapshot(entityId: string) {
  return {
    entity: await h.prisma.entity.findUniqueOrThrow({ where: { id: entityId } }),
    stores: await h.prisma.store.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    members: await h.prisma.entityMember.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    links: await h.prisma.storeMember.findMany({
      where: { entityId },
      orderBy: { entityMemberId: "asc" },
    }),
    invitations: await h.prisma.invitation.findMany({
      where: { entityId },
      orderBy: { id: "asc" },
    }),
    grants: await h.prisma.portalSession.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    timers: await h.prisma.timer.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    history: await h.prisma.statusTransition.findMany({
      where: { entityId },
      orderBy: { seq: "asc" },
    }),
    audits: await h.prisma.auditLog.findMany({ where: { entityId }, orderBy: { seq: "asc" } }),
    events: await h.prisma.outboxEvent.findMany({ where: { entityId }, orderBy: { seq: "asc" } }),
    requests: await h.prisma.cancelRequest.findMany({
      where: { entityId },
      orderBy: { id: "asc" },
    }),
  };
}
async function invitation(f: Fixture, status: "pending" | "expired" | "revoked" = "pending") {
  const id = uuidv7(),
    now = h.clock.now();
  return h.prisma.invitation.create({
    data: {
      id,
      entityId: f.input.entityId,
      storeId: f.merchant.store.id,
      role: "clerk",
      inviterMemberId: f.merchant.owner.id,
      tokenHash: createHash("sha256").update(id).digest(),
      tokenEnc: status === "pending" ? "v1:test:token" : null,
      status,
      expiresAt: new Date(now.getTime() + 24 * 3_600_000),
      ...(status === "revoked"
        ? {
            revokedAt: now,
            revokeActorType: "merchant",
            revokeActorId: f.merchant.user.id,
            revokeClient: "weapp",
            revokeReason: "by_owner",
          }
        : {}),
      clientRequestId: uuidv7(),
      createdAt: now,
      updatedAt: now,
    },
  });
}
async function grant(
  f: Fixture,
  options: { expired?: boolean; revoked?: boolean; userId?: string } = {},
) {
  const id = uuidv7(),
    now = h.clock.now();
  return h.prisma.portalSession.create({
    data: {
      id,
      tokenHash: createHash("sha256").update(id).digest(),
      portalTicketId: uuidv7(),
      entityId: f.input.entityId,
      storeId: f.merchant.store.id,
      approvedByUserId: options.userId ?? f.merchant.user.id,
      grantScope: "store",
      expiresAt: new Date(now.getTime() + (options.expired ? -1 : 1) * 3_600_000),
      ...(options.revoked ? { revokedAt: now, revokeReason: "owner_revoked" } : {}),
      createdAt: new Date(now.getTime() - 3 * 3_600_000),
      updatedAt: now,
      ip: "198.51.100.11",
      userAgent: "W210 owner fixture",
    },
  });
}
async function extended(f: Fixture) {
  const store = await h.make.store({ entityId: f.input.entityId });
  const clerk = await h.make.entityMember({ entityId: f.input.entityId, lastStoreId: store.id });
  await h.make.storeMember({
    entityId: f.input.entityId,
    storeId: store.id,
    entityMemberId: clerk.id,
  });
  const oldStore = await h.make.store({
    entityId: f.input.entityId,
    lifecycle: "archived",
    archivedAt: h.clock.now(),
    archiveReason: "by_owner",
    archiveActorType: "merchant",
    archiveActorId: f.merchant.user.id,
    archiveClient: "weapp",
  });
  const oldMember = await h.make.entityMember({
    entityId: f.input.entityId,
    status: "removed",
    removedAt: h.clock.now(),
    removeReason: "self",
    removeActorType: "merchant",
    removeActorId: f.merchant.user.id,
    removeClient: "weapp",
  });
  const pending = await invitation(f),
    oldInvite = await invitation(f, "revoked");
  const r = runtime();
  // invitation 的 producer 尚未交付；合法上游邀请 fixture 经真实 timer arm 创建到期行。
  const timer = await h.tx.run(async (tx) => {
    await lockRows(tx, "invitation", [pending.id]);
    return r.timers.arm(tx, {
      kind: "invitation.expire",
      subject: { type: "invitation", id: pending.id },
      key: timerKey("invitation.expire", { type: "invitation", id: pending.id }),
      fireAt: pending.expiresAt,
      entityId: f.input.entityId,
      storeId: pending.storeId,
    });
  });
  return {
    ...f,
    r,
    store,
    clerk,
    oldStore,
    oldMember,
    pending,
    oldInvite,
    timer,
    input: { ...f.input, confirm: { activeStoreCount: 2, activeMemberCount: 2 } },
  };
}

describe("真实 staff entity close owner", () => {
  it("公开结果、真实终态、四类严格事件、状态历史及员工审计同事务落库", async () => {
    const f = await extended(await fixture()),
      now = h.clock.now();
    const out = await close(f, f.r);
    expect(out).toEqual({
      entityId: f.input.entityId,
      lifecycle: "closed",
      invitationIds: [f.pending.id],
      memberIds: [f.merchant.owner.id, f.clerk.id].sort(),
      storeIds: [f.merchant.store.id, f.store.id].sort(),
      withdrawnCancelRequestIds: [],
      revokedPortalGrantCount: 0,
    });
    const after = await snapshot(f.input.entityId);
    expect(after.entity).toMatchObject({ lifecycle: "closed", closedAt: now });
    for (const id of out.memberIds)
      expect(after.members.find((row) => row.id === id)).toMatchObject({
        status: "removed",
        removedAt: now,
        removeReason: "entity_closed",
        lastStoreId: null,
        removeActorType: "staff",
        removeActorId: f.actor.staff.staff.id,
        removeClient: "admin",
      });
    for (const id of out.storeIds)
      expect(after.stores.find((row) => row.id === id)).toMatchObject({
        lifecycle: "archived",
        archivedAt: now,
        archiveReason: "entity_closed",
        archiveActorType: "staff",
        archiveActorId: f.actor.staff.staff.id,
        archiveClient: "admin",
      });
    expect(after.links).toEqual([]);
    expect(after.invitations.find((row) => row.id === f.pending.id)).toMatchObject({
      status: "revoked",
      revokedAt: now,
      tokenEnc: null,
      revokeReason: "entity_closed",
      revokeActorType: "staff",
      revokeActorId: f.actor.staff.staff.id,
      revokeClient: "admin",
    });
    expect(after.stores.find((row) => row.id === f.oldStore.id)).toEqual(f.oldStore);
    expect(after.members.find((row) => row.id === f.oldMember.id)).toEqual(f.oldMember);
    expect(after.invitations.find((row) => row.id === f.oldInvite.id)).toEqual(f.oldInvite);
    expect(
      after.history.map((row) => [row.machine, row.fromState, row.toState, row.event]),
    ).toEqual([
      ["entity", "active", "closed", "entity.close"],
      ["invitation", "pending", "revoked", "invitation.revoke"],
      ...out.memberIds.map(() => [
        "entity_member",
        "active",
        "removed",
        "entity_member.cascade_remove",
      ]),
      ...out.storeIds.map(() => ["store", "active", "archived", "store.archive_by_entity"]),
    ]);
    expect(
      after.history.every(
        (row) => row.actorType === "staff" && row.actorId === f.actor.staff.staff.id,
      ),
    ).toBe(true);
    expect(after.events.map((row) => row.eventType)).toEqual([
      "entity.closed",
      "invitation.revoked",
      "entity_member.removed",
      "entity_member.removed",
      "store.archived",
      "store.archived",
    ]);
    expect(after.events[0]?.payload).toEqual({
      v: 1,
      entityId: f.input.entityId,
      closedBy: "staff_close",
      fromState: "active",
      toState: "closed",
      transition: "entity.close",
    });
    expect(
      after.events.every(
        (row) => row.actorType === "staff" && row.actorId === f.actor.staff.staff.id,
      ),
    ).toBe(true);
    expect(after.audits).toHaveLength(6);
    expect(after.audits.find((row) => row.action === "tenant.entity.close")).toMatchObject({
      stream: "ops",
      reasonCode: "staff_close",
      reasonText: f.input.reasonText,
      actorType: "staff",
      actorId: f.actor.staff.staff.id,
      meta: { confirm: f.input.confirm },
    });
    expect(
      (await findI17Violations(h.prisma)).filter((row) => row.entityId === f.input.entityId),
    ).toEqual([]);
    expect(
      (await findI28Violations(h.prisma)).filter((row) => row.entityId === f.input.entityId),
    ).toEqual([]);
  });

  it("回显成员数包含老板，只有店员数或包括历史行均拒绝且零写", async () => {
    const f = await extended(await fixture()),
      before = await snapshot(f.input.entityId);
    for (const confirm of [
      { activeStoreCount: 2, activeMemberCount: 1 },
      { activeStoreCount: 3, activeMemberCount: 3 },
    ])
      await expect(close(f, f.r, { ...f.input, confirm })).rejects.toMatchObject({
        error: "CONFIRM_MISMATCH",
      });
    expect(await snapshot(f.input.entityId)).toEqual(before);
  });

  it.each(["stores", "members"] as const)(
    "原回显后新增有效 %s，按锁后实际数量拒绝",
    async (kind) => {
      const f = await fixture();
      if (kind === "stores") await h.make.store({ entityId: f.input.entityId });
      else await h.make.entityMember({ entityId: f.input.entityId });
      const before = await snapshot(f.input.entityId);
      await expect(close(f)).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
      expect(await snapshot(f.input.entityId)).toEqual(before);
    },
  );

  it.each(["", "太短", "理".repeat(201)])("原因不合长度拒绝且零写（%#）", async (reasonText) => {
    const f = await fixture(),
      before = await snapshot(f.input.entityId);
    await expect(close(f, runtime(), { ...f.input, reasonText })).rejects.toMatchObject({
      error: "VALIDATION_FAILED",
    });
    expect(await snapshot(f.input.entityId)).toEqual(before);
  });
  it.each([10, 200])("原因 %i 字边界合法且保存去除首尾空白后的全文", async (size) => {
    const f = await fixture(),
      reasonText = "理".repeat(size);
    await close(f, runtime(), { ...f.input, reasonText: `  ${reasonText}  ` });
    expect(
      await h.prisma.auditLog.findFirstOrThrow({
        where: { entityId: f.input.entityId, stream: "ops" },
      }),
    ).toMatchObject({ reasonText });
  });

  it.each(["permission", "stale", "missing", "disabled", "identity", "scope"] as const)(
    "拒绝 %s 的调用且保留全部原记录",
    async (kind) => {
      const f = await fixture();
      let actor = f.actor;
      if (kind === "permission")
        actor = { ...actor, staff: { ...actor.staff, permissions: new Set() } };
      if (kind === "stale" || kind === "missing")
        actor = {
          ...actor,
          staff: {
            ...actor.staff,
            stepUpAt: kind === "missing" ? null : new Date(h.clock.now().getTime() - 600_001),
          },
        };
      if (kind === "disabled")
        await h.prisma.staff.update({
          where: { id: actor.staff.staff.id },
          data: { status: "disabled", disabledAt: h.clock.now(), disabledReason: "other" },
        });
      if (kind === "identity")
        actor = {
          ...actor,
          ctx: createIdentityContext({
            actor: {
              type: "merchant",
              id: f.merchant.user.id,
              client: "weapp",
            },
          }),
        };
      if (kind === "scope")
        actor = { ...actor, staff: { ...actor.staff, scope: ownTaskScope(actor.staff.staff) } };
      const before = await snapshot(f.input.entityId);
      await expect(close(f, runtime(), f.input, actor)).rejects.toMatchObject({
        error:
          kind === "stale" || kind === "missing"
            ? "STEP_UP_REQUIRED"
            : kind === "scope"
              ? "NOT_FOUND"
              : "PERMISSION_DENIED",
      });
      expect(await snapshot(f.input.entityId)).toEqual(before);
    },
  );
  it("未知主体与范围外返回同一个 NOT_FOUND", async () => {
    const f = await fixture();
    await expect(close(f, runtime(), { ...f.input, entityId: uuidv7() })).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
  });
  it.each(["closed", "abandoned"] as const)(
    "%s 主体拒绝重复关闭，原关闭与历史原因不覆盖",
    async (lifecycle) => {
      const f = await fixture();
      await h.prisma.entity.update({
        where: { id: f.input.entityId },
        data: {
          lifecycle,
          closedAt: h.clock.now(),
        },
      });
      const before = await snapshot(f.input.entityId);
      await expect(close(f)).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
      expect(await snapshot(f.input.entityId)).toEqual(before);
    },
  );

  it("portal 真实实体范围覆盖不同授权人与过期行，别主体和已有撤销证据保持原样", async () => {
    const f = await fixture(),
      other = await fixture(),
      user = await h.make.merchantUser();
    const active = await grant(f),
      expired = await grant(f, { expired: true });
    const otherUser = await grant(f, { userId: user.id }),
      old = await grant(f, { revoked: true });
    const foreign = await grant(other, { userId: f.merchant.user.id }),
      now = h.clock.now();
    expect((await close(f)).revokedPortalGrantCount).toBe(3);
    for (const row of [active, expired, otherUser])
      expect(await h.prisma.portalSession.findUniqueOrThrow({ where: { id: row.id } })).toEqual({
        ...row,
        revokedAt: now,
        revokeReason: "membership_changed",
        updatedAt: now,
      });
    for (const row of [old, foreign])
      expect(await h.prisma.portalSession.findUniqueOrThrow({ where: { id: row.id } })).toEqual(
        row,
      );
  });

  it("只取消本次 pending 邀请的到期 timer，历史邀请、其他主体及非到期 kind 不动", async () => {
    const f = await extended(await fixture()),
      other = await fixture();
    const foreignInvite = await invitation(other),
      foreignRuntime = runtime();
    const foreignTimer = await h.tx.run(async (tx) => {
      await lockRows(tx, "invitation", [foreignInvite.id]);
      return foreignRuntime.timers.arm(tx, {
        kind: "invitation.expire",
        subject: { type: "invitation", id: foreignInvite.id },
        key: timerKey("invitation.expire", { type: "invitation", id: foreignInvite.id }),
        fireAt: foreignInvite.expiresAt,
        entityId: other.input.entityId,
        storeId: foreignInvite.storeId,
      });
    });
    const unrelated = await h.prisma.timer.create({
      data: {
        id: uuidv7(),
        kind: "sla.breach",
        subjectType: "invitation",
        subjectId: f.pending.id,
        entityId: f.input.entityId,
        storeId: f.pending.storeId,
        fireAt: f.pending.expiresAt,
        dedupeKey: `sla.breach:invitation:${f.pending.id}`,
        status: "scheduled",
      },
    });
    const historic = await h.prisma.timer.create({
      data: {
        id: uuidv7(),
        kind: "invitation.expire",
        subjectType: "invitation",
        subjectId: f.oldInvite.id,
        entityId: f.input.entityId,
        storeId: f.pending.storeId,
        fireAt: f.oldInvite.expiresAt,
        dedupeKey: `invitation.expire:invitation:${f.oldInvite.id}`,
        status: "fired",
        firedAt: h.clock.now(),
      },
    });
    await close(f, f.r);
    expect(await h.prisma.timer.findUniqueOrThrow({ where: { id: f.timer.id } })).toMatchObject({
      status: "cancelled",
    });
    for (const row of [unrelated, historic])
      expect(await h.prisma.timer.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(
      await h.prisma.timer.findUniqueOrThrow({ where: { id: foreignTimer.id } }),
    ).toMatchObject({ status: "scheduled" });
  });
});

async function block(f: Fixture, kind: string) {
  const entityId = f.input.entityId;
  if (["subscription_active", "payment_open", "refund_open", "invoice_open"].includes(kind)) {
    await h.tx.run(async (tx) => {
      await seedBillingDeletionFacts(tx, h.clock, { entityId, userId: f.merchant.user.id });
      // 上游表夹具仅保留待验的真实阻断；不以替身端口返回计数。
      if (kind !== "subscription_active")
        await tx.subscriptionTerm.updateMany({
          where: { entityId, status: { in: ["active", "scheduled"] } },
          data: { status: "ended", activatedAt: h.clock.now() },
        });
      if (kind !== "payment_open") {
        await tx.billingOrder.deleteMany({
          where: { entityId, status: { in: ["pending_payment", "pending_confirmation"] } },
        });
        await tx.billingOrder.updateMany({
          where: { entityId },
          data: { hasOpenException: false },
        });
      }
      if (kind !== "refund_open") await tx.refundRequest.deleteMany({ where: { entityId } });
      if (kind !== "invoice_open") await tx.invoiceRequest.deleteMany({ where: { entityId } });
    });
    return kind === "subscription_active" || kind === "invoice_open"
      ? 2
      : kind === "payment_open"
        ? 4
        : 1;
  }
  const term = await h.make.subscriptionTerm({ entityId, status: "ended" });
  const order = await h.make.dramaOrder({
    entityId,
    storeId: f.merchant.store.id,
    subscriptionTermId: term.id,
    status: kind === "open_order" ? "pending_start" : "ended",
  });
  if (kind === "release_online") {
    const item = await h.make.orderItem({ dramaOrderId: order.id, phase: "ended" });
    await h.make.deliveryTicket({ orderItemId: item.id, step: "in_service" });
  }
  return 1;
}
describe("所属真实六类关闭阻断", () => {
  it.each([
    "subscription_active",
    "payment_open",
    "refund_open",
    "invoice_open",
    "open_order",
    "release_online",
  ])("%s 返回准确类别/计数，关闭全部零写", async (kind) => {
    const f = await fixture(),
      count = await block(f, kind),
      before = await snapshot(f.input.entityId);
    await expect(close(f)).rejects.toMatchObject({
      error: "ENTITY_CLOSE_BLOCKED",
      details: { blockers: [{ kind, count }] },
    });
    expect(await snapshot(f.input.entityId)).toEqual(before);
  });
  it("别主体同时有六类未办结事项不污染本主体，计数不能用全局总量", async () => {
    const f = await fixture(),
      other = await fixture();
    await h.tx.run((tx) =>
      seedBillingDeletionFacts(tx, h.clock, {
        entityId: other.input.entityId,
        userId: other.merchant.user.id,
      }),
    );
    const term = await h.prisma.subscriptionTerm.findFirstOrThrow({
      where: { entityId: other.input.entityId, status: "active" },
    });
    const order = await h.make.dramaOrder({
      entityId: other.input.entityId,
      storeId: other.merchant.store.id,
      subscriptionTermId: term.id,
    });
    const item = await h.make.orderItem({ dramaOrderId: order.id, phase: "producing" });
    await h.make.deliveryTicket({ orderItemId: item.id, step: "in_service" });
    const before = await snapshot(other.input.entityId);
    expect((await close(f)).lifecycle).toBe("closed");
    expect(await snapshot(other.input.entityId)).toEqual(before);
  });
});

describe("关闭原子性与不可伪造 cascade", () => {
  it("外层真实事务在全部迁移与 portal 撤销后失败，所有行和证据回滚", async () => {
    const f = await extended(await fixture());
    await grant(f);
    const before = await snapshot(f.input.entityId),
      failure = new Error("caller rollback");
    await expect(
      bound(f.r, () =>
        h.tx.run(async (tx) => {
          expect((await closeEntityIn(tx, f.r, f.actor, f.input)).lifecycle).toBe("closed");
          expect(
            (await tx.entity.findUniqueOrThrow({ where: { id: f.input.entityId } })).lifecycle,
          ).toBe("closed");
          throw failure;
        }),
      ),
    ).rejects.toBe(failure);
    expect(await snapshot(f.input.entityId)).toEqual(before);
  });
  it.each([
    "entity.close",
    "invitation.revoke",
    "entity_member.cascade_remove",
    "store.archive_by_entity",
  ])("真实 %s 迁移、历史、审计与事件写入后故障，之前所有步骤回滚", async (event) => {
    const f = await extended(await fixture()),
      failure = new Error(`after ${event}`);
    const r = runtime((real) => ({
      ...real,
      transition: async (tx, ctx, input) => {
        const out = await real.transition(tx, ctx, input);
        if (input.event === event) throw failure;
        return out;
      },
    }));
    const before = await snapshot(f.input.entityId);
    await expect(close(f, r)).rejects.toBe(failure);
    expect(await snapshot(f.input.entityId)).toEqual(before);
  });
  it("真实 portal update 后抛错，主体/成员/门店/邀请/timer 全部回滚", async () => {
    const f = await extended(await fixture());
    await grant(f);
    const before = await snapshot(f.input.entityId),
      failure = new Error("after real portal revoke");
    await expect(
      bound(f.r, () =>
        h.tx.run(async (tx) => {
          const original = tx.portalSession.updateMany.bind(tx.portalSession);
          Object.assign(tx.portalSession, {
            updateMany: async (args: Prisma.PortalSessionUpdateManyArgs) => {
              await original(args);
              throw failure;
            },
          });
          return closeEntityIn(tx, f.r, f.actor, f.input);
        }),
      ),
    ).rejects.toBe(failure);
    expect(await snapshot(f.input.entityId)).toEqual(before);
  });

  it.each(["entity", "invitation", "entity_member", "store"] as const)(
    "%s 直接 flow 调用不能用 args 假装已核准关闭",
    async (machine) => {
      const f = await fixture(),
        inv = await invitation(f),
        r = runtime();
      const id =
        machine === "entity"
          ? f.input.entityId
          : machine === "invitation"
            ? inv.id
            : machine === "entity_member"
              ? f.merchant.owner.id
              : f.merchant.store.id;
      const event =
        machine === "entity"
          ? "entity.close"
          : machine === "invitation"
            ? "invitation.revoke"
            : machine === "entity_member"
              ? "entity_member.cascade_remove"
              : "store.archive_by_entity";
      const set =
        machine === "entity"
          ? { closed_at: h.clock.now() }
          : machine === "invitation"
            ? {
                revoked_at: h.clock.now(),
                revoke_actor_type: "staff",
                revoke_actor_id: f.actor.staff.staff.id,
                revoke_client: "admin",
                revoke_reason: "entity_closed",
                token_enc: null,
              }
            : machine === "entity_member"
              ? {
                  removed_at: h.clock.now(),
                  remove_actor_type: "staff",
                  remove_actor_id: f.actor.staff.staff.id,
                  remove_client: "admin",
                  remove_reason: "entity_closed",
                }
              : {
                  archived_at: h.clock.now(),
                  archive_actor_type: "staff",
                  archive_actor_id: f.actor.staff.staff.id,
                  archive_client: "admin",
                  archive_reason: "entity_closed",
                };
      const before = await snapshot(f.input.entityId);
      const chain =
        machine === "entity" || machine === "store"
          ? { machine, stateField: "lifecycle" as const }
          : { machine, stateField: "status" as const };
      await expect(
        h.tx.run((tx) =>
          r.flow.transition(tx, f.actor.ctx, {
            ...chain,
            id,
            event,
            entityId: f.input.entityId,
            set,
            ...(machine === "store"
              ? { ref: "02:610" }
              : machine === "entity_member"
                ? { ref: "02:695" }
                : {}),
            args: { entityClosed: true, prepared: true, actor: f.actor, confirm: f.input.confirm },
            emit: { none: true, primary: "entity.closed" },
          }),
        ),
      ).rejects.toMatchObject({
        error: machine === "store" ? "PRECONDITION_CHANGED" : "STATE_NOT_ALLOWED",
      });
      expect(await snapshot(f.input.entityId)).toEqual(before);
    },
  );

  it("关闭实体的真实状态也不能代替 same-Tx owner witness", async () => {
    const f = await fixture(),
      r = runtime();
    await h.prisma.entity.update({
      where: { id: f.input.entityId },
      data: { lifecycle: "closed", closedAt: h.clock.now() },
    });
    const before = await snapshot(f.input.entityId);
    await expect(
      h.tx.run((tx) =>
        r.flow.transition(tx, f.actor.ctx, {
          machine: "entity_member",
          stateField: "status",
          id: f.merchant.owner.id,
          event: "entity_member.cascade_remove",
          ref: "02:695",
          entityId: f.input.entityId,
          set: {
            removed_at: h.clock.now(),
            remove_reason: "entity_closed",
            remove_actor_type: "staff",
            remove_actor_id: f.actor.staff.staff.id,
            remove_client: "admin",
          },
          emit: { none: true, primary: "entity.closed" },
        }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    expect(await snapshot(f.input.entityId)).toEqual(before);
  });

  it("prepare 后集合变化拒绝整次关闭，后插门店也回滚", async () => {
    const f = await fixture();
    const r = runtime((real) => ({
      ...real,
      transition: async (tx, ctx, input) => {
        const out = await real.transition(tx, ctx, input);
        if (input.event === "entity.close")
          await createFactories({ db: tx, clock: h.clock }).store({ entityId: f.input.entityId });
        return out;
      },
    }));
    const before = await snapshot(f.input.entityId);
    await expect(close(f, r)).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
    expect(await snapshot(f.input.entityId)).toEqual(before);
  });
});

async function unsupported(tx: Tx, f: Fixture) {
  const now = h.clock.now(),
    id = uuidv7(),
    approvalId = uuidv7();
  // 仅模拟尚未交付 producer 的合法异常在途行；绝不声称该 kind 已有系统收尾 owner。
  await tx.approvalRequest.create({
    data: {
      id: approvalId,
      requestNo: `TK${approvalId.replaceAll("-", "")}`,
      kind: "qualification_cancel",
      category: "approval",
      subjectType: "store",
      subjectId: f.merchant.store.id,
      entityId: f.input.entityId,
      storeId: f.merchant.store.id,
      status: "pending",
      summarySnapshot: { title: "异常种类上游 fixture" },
      requesterStaffId: f.actor.staff.staff.id,
      submitActorType: "system",
      submittedAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  await tx.cancelRequest.create({
    data: {
      id,
      approvalRequestId: approvalId,
      kind: "qualification_cancel",
      entityId: f.input.entityId,
      storeId: f.merchant.store.id,
      reasonCode: "qualification_final",
      note: "上游异常 fixture",
      lineCount: 1,
      totalBasePoints: 100,
      totalDeductPoints: 0,
      totalRefundPoints: 100,
      status: "pending_approval",
      createdAt: now,
      updatedAt: now,
    },
  });
  return id;
}
describe("尚不支持的取消种类明确拒绝", () => {
  it("prepare 初读看到非 ad_cancel pending，不当成空批次成功", async () => {
    const f = await fixture();
    await h.tx.run((tx) => unsupported(tx, f));
    const before = await snapshot(f.input.entityId);
    await expect(close(f)).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
    expect(await snapshot(f.input.entityId)).toEqual(before);
  });
  it("真实 entity.close 迁移后出现其他种类，withdraw 复核拒绝并回滚全部迁移", async () => {
    const f = await fixture();
    const r = runtime((real) => ({
      ...real,
      transition: async (tx, ctx, input) => {
        const out = await real.transition(tx, ctx, input);
        if (input.event === "entity.close") await unsupported(tx, f);
        return out;
      },
    }));
    const before = await snapshot(f.input.entityId);
    await expect(close(f, r)).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
    expect(await snapshot(f.input.entityId)).toEqual(before);
  });
});

describe("真实残留不变量", () => {
  it("I17 报告非 active 主体的有效成员、有效门店与 pending 邀请三类真实残留", async () => {
    const f = await fixture();
    await invitation(f);
    const failure = new Error("isolate invariant fixture");
    await expect(
      h.tx.run(async (tx) => {
        await tx.entity.update({
          where: { id: f.input.entityId },
          data: { lifecycle: "closed", closedAt: h.clock.now() },
        });
        expect(
          (await findI17Violations(tx)).filter((row) => row.entityId === f.input.entityId),
        ).toEqual([
          {
            subject: { type: "entity", id: f.input.entityId },
            entityId: f.input.entityId,
            detail: { members: 1, pendingInvitations: 1, activeStores: 1 },
          },
        ]);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(
      (await findI17Violations(h.prisma)).filter((row) => row.entityId === f.input.entityId),
    ).toEqual([]);
  });
  it("I17 报告 archived 门店的真实 store_member 与 pending 邀请残留", async () => {
    const f = await fixture(),
      clerk = await h.make.entityMember({ entityId: f.input.entityId });
    await h.make.storeMember({
      entityId: f.input.entityId,
      storeId: f.merchant.store.id,
      entityMemberId: clerk.id,
    });
    await invitation(f);
    const failure = new Error("isolate archived store fixture");
    await expect(
      h.tx.run(async (tx) => {
        await tx.store.update({
          where: { id: f.merchant.store.id },
          data: {
            lifecycle: "archived",
            archivedAt: h.clock.now(),
            archiveReason: "by_owner",
            archiveActorType: "merchant",
            archiveActorId: f.merchant.user.id,
            archiveClient: "weapp",
          },
        });
        expect(
          (await findI17Violations(tx)).filter((row) => row.entityId === f.input.entityId),
        ).toEqual([
          {
            subject: { type: "store", id: f.merchant.store.id },
            entityId: f.input.entityId,
            detail: { members: 1, pendingInvitations: 1, activeStores: 0 },
          },
        ]);
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
  it.each(["entity_closed", "entity_abandoned"])(
    "I28 发现 %s 与真实父状态不符，匹配后消失",
    async (archiveReason) => {
      const f = await fixture(),
        failure = new Error("isolate archive reason fixture");
      await expect(
        h.tx.run(async (tx) => {
          await tx.store.update({
            where: { id: f.merchant.store.id },
            data: {
              lifecycle: "archived",
              archivedAt: h.clock.now(),
              archiveReason,
              archiveActorType: "system",
            },
          });
          expect(
            (await findI28Violations(tx)).filter((row) => row.entityId === f.input.entityId),
          ).toEqual([
            {
              subject: { type: "store", id: f.merchant.store.id },
              entityId: f.input.entityId,
              detail: { archiveReason, entityLifecycle: "active" },
            },
          ]);
          await tx.entity.update({
            where: { id: f.input.entityId },
            data: {
              lifecycle: archiveReason === "entity_closed" ? "closed" : "abandoned",
              closedAt: h.clock.now(),
            },
          });
          expect(
            (await findI28Violations(tx)).filter((row) => row.entityId === f.input.entityId),
          ).toEqual([]);
          throw failure;
        }),
      ).rejects.toBe(failure);
    },
  );
});

async function param(key: string, value: Prisma.InputJsonValue, staffId: string) {
  h.clock.advance(1);
  await h.prisma.paramValue.create({
    data: {
      id: uuidv7(),
      key,
      value,
      effectiveAt: h.clock.now(),
      createdAt: h.clock.now(),
      createdByStaffId: staffId,
      reason: "主体关闭广告取消集成夹具",
    },
  });
}
async function adCancel(f: Fixture, r: ReturnType<typeof runtime>) {
  const { term } = await openTerm(h, { entityId: f.input.entityId });
  await param("refund.points.auto_approve_before_production", false, f.actor.staff.staff.id);
  await param("refund.require_distinct_executor", false, f.actor.staff.staff.id);
  for (const [key, value] of [
    [
      "cancelDeductionBp",
      {
        planConfirm: 3000,
        adAndSample: 3000,
        samplePending: 5000,
        postSample: null,
        adInProduction: 3000,
      },
    ],
    ["expiredTermRefund", { merchant: "forfeit", platform: "addon", qualification: "addon" }],
  ] as const) {
    h.clock.advance(1);
    await h.prisma.billingParam.create({
      data: {
        id: uuidv7(),
        key,
        value,
        effectiveAt: h.clock.now(),
        changeId: uuidv7(),
        createdAt: h.clock.now(),
      },
    });
  }
  const id = uuidv7(),
    adNo = `GG20260105${String(++sequence).padStart(5, "0")}`,
    now = h.clock.now();
  const ctx = createIdentityContext({
    actor: { type: "system", job: "lyxtest.tenant_close_ad" },
    entityId: f.input.entityId,
  });
  const held = await h.tx.run((tx) =>
    h.ledger.hold(tx, {
      entityId: f.input.entityId,
      storeId: f.merchant.store.id,
      refType: "ad",
      refId: id,
      pricing: { kind: "ad" },
      title: { code: "ad_hold", args: { adNo, unitPoints: 50, discountBp: term.discountBp } },
      ctx,
    }),
  );
  const pricing = AdPricingSnapshotSchema.parse(held.snapshot);
  const consent = await h.make.agreementConsent({
    scene: "ad_request",
    merchantUserId: f.merchant.user.id,
    entityId: f.input.entityId,
    storeId: f.merchant.store.id,
    bizId: id,
  });
  // M5 无广告提交 producer；只插广告上游行，账本冻结/取消/审批均走真实公开实现。
  await h.prisma.ad.create({
    data: {
      id,
      adNo,
      entityId: f.input.entityId,
      storeId: f.merchant.store.id,
      requestedByUserId: f.merchant.user.id,
      type: "opening",
      durationSec: 3,
      promoPointCodes: ["TEST"],
      status: "pending_assign",
      unitPricePoints: pricing.unitPoints,
      discountBp: pricing.discountBp,
      chargePoints: held.points,
      pricingSnapshot: held.snapshot,
      pointHoldId: held.pointHoldId,
      freeRevisionQuota: pricing.freeRevisions,
      agreementConsentId: consent.id,
      submittedAt: now,
      firstDueAt: now,
      createdAt: now,
      updatedAt: now,
    },
  });
  const quote = await h.tx.run((tx) =>
    quoteAdCancel(
      tx,
      {
        scope: f.actor.staff.scope,
        adId: id,
        body: { reasonCode: "merchant_request" },
      },
      h.clock.now(),
    ),
  );
  const request = await createAdCancel(r.cancel).submit(f.actor, id, {
    reasonCode: "merchant_request",
    note: "商家申请取消广告制作",
    expect: quote.expect,
  });
  h.clock.set(new Date(term.endsAt.getTime() + 1));
  // 通过真实账本 advance 结束订阅，避免 subscription_active 阻断；held 广告点数仍保持原冻结。
  await h.tx.run((tx) => h.ledger.advance(tx, f.input.entityId));
  f.actor = {
    ...f.actor,
    staff: await sampleStaffContext(h.prisma, f.actor.staff.staff.id, { stepUpAt: h.clock.now() }),
  };
  return { id, request, held };
}
async function finances(entityId: string) {
  return {
    account: await h.prisma.billingAccount.findUniqueOrThrow({ where: { entityId } }),
    holds: await h.prisma.pointHold.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    lots: await h.prisma.pointLot.findMany({ where: { entityId }, orderBy: { id: "asc" } }),
    allocations: await h.prisma.pointHoldAlloc.findMany({
      where: { pointHold: { entityId } },
      orderBy: [{ pointHoldId: "asc" }, { allocNo: "asc" }],
    }),
    operations: await h.prisma.ledgerOperation.findMany({
      where: { entityId },
      orderBy: { id: "asc" },
    }),
    entries: await h.prisma.pointLedgerEntry.findMany({
      where: { entityId },
      orderBy: { id: "asc" },
    }),
  };
}
describe("真实广告取消 owner 及并发", () => {
  it("真实 pending ad_cancel 由 tenant 关闭驱动系统撤回，原申请/审批/timer/指针一致且账本不动", async () => {
    const f = await fixture(),
      r = runtime(),
      ad = await adCancel(f, r);
    const before = await finances(f.input.entityId);
    expect((await close(f, r)).withdrawnCancelRequestIds).toEqual([ad.request.id]);
    expect(
      await h.prisma.cancelRequest.findUniqueOrThrow({ where: { id: ad.request.id } }),
    ).toMatchObject({ status: "not_executed", closeReason: "withdrawn", closedAt: h.clock.now() });
    expect(
      await h.prisma.approvalRequest.findUniqueOrThrow({
        where: { id: ad.request.approvalRequestId },
      }),
    ).toMatchObject({ status: "withdrawn" });
    expect(await h.prisma.ad.findUniqueOrThrow({ where: { id: ad.id } })).toMatchObject({
      status: "pending_assign",
      openCancelRequestId: null,
    });
    expect(
      await h.prisma.timer.count({
        where: {
          subjectId: ad.request.approvalRequestId,
          status: { in: ["scheduled", "dispatched", "failed"] },
        },
      }),
    ).toBe(0);
    const event = await h.prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: ad.request.id, eventType: "cancel.withdrawn" },
    });
    expect(event).toMatchObject({ actorType: "system", actorId: null });
    expect(await finances(f.input.entityId)).toEqual(before);
  });

  it("实际 cancel.withdrawn 事件落库后故障，tenant 全部与审批/指针/timer/账本原子回滚", async () => {
    const f = await fixture(),
      r = runtime(),
      ad = await adCancel(f, r);
    const before = await snapshot(f.input.entityId),
      money = await finances(f.input.entityId);
    const approval = await h.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: ad.request.approvalRequestId },
    });
    const originalAd = await h.prisma.ad.findUniqueOrThrow({ where: { id: ad.id } }),
      failure = new Error("after cancel.withdrawn");
    await expect(
      bound(r, () =>
        h.tx.run(async (tx) => {
          const original = tx.outboxEvent.create.bind(tx.outboxEvent);
          Object.assign(tx.outboxEvent, {
            create: async (args: Prisma.OutboxEventCreateArgs) => {
              const row = await original(args);
              if (args.data.eventType === "cancel.withdrawn") throw failure;
              return row;
            },
          });
          return closeEntityIn(tx, r, f.actor, f.input);
        }),
      ),
    ).rejects.toBe(failure);
    expect(await snapshot(f.input.entityId)).toEqual(before);
    expect(await finances(f.input.entityId)).toEqual(money);
    expect(
      await h.prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } }),
    ).toEqual(approval);
    expect(await h.prisma.ad.findUniqueOrThrow({ where: { id: ad.id } })).toEqual(originalAd);
  });

  it("二十轮两个真实关闭竞争只提交一个关闭结果，历史/审计/事件不重复", async () => {
    const r = runtime();
    await bound(r, async () => {
      for (let round = 0; round < 20; round++) {
        const f = await fixture();
        const results = await Promise.allSettled([
          h.tx.run((tx) => closeEntityIn(tx, r, f.actor, f.input)),
          h.tx.run((tx) => closeEntityIn(tx, r, f.actor, f.input)),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const failed = results.find((result) => result.status === "rejected");
        expect(failed?.status === "rejected" ? failed.reason : null).toMatchObject({
          error: "STATE_NOT_ALLOWED",
        });
        const after = await snapshot(f.input.entityId);
        expect(after.history).toHaveLength(3);
        expect(after.events).toHaveLength(3);
        expect(after.audits).toHaveLength(3);
        expect(after.events.filter((row) => row.eventType === "entity.closed")).toHaveLength(1);
        expect(after.entity.lifecycle).toBe("closed");
      }
    });
  });

  it("真实第二连接先等 actor staff20，等待期间失效员工在锁后复核拒绝，无提前高锁", async () => {
    const f = await fixture(),
      r = runtime();
    let writerPid = 0,
      waiterPid = 0,
      release!: () => void,
      entered!: () => void,
      locked!: () => void;
    const held = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connected = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const writer = h.tx.run(async (tx) => {
      writerPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      await lockRows(tx, "staff", [f.actor.staff.staff.id]);
      locked();
      await proceed;
      await tx.staff.update({
        where: { id: f.actor.staff.staff.id },
        data: { status: "disabled", disabledAt: h.clock.now(), disabledReason: "other" },
      });
    });
    await held;
    const observer = createPrismaClient({
      connectionString: testDatabaseUrl(db.name, { role: null }),
      max: 1,
    });
    const before = await snapshot(f.input.entityId);
    const waiter = bound(r, () =>
      h.tx.run(async (tx) => {
        waiterPid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
        entered();
        return closeEntityIn(tx, r, f.actor, f.input);
      }),
    ).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await connected;
      expect(waiterPid).not.toBe(writerPid);
      let blocked = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const [backend] = await observer.$queryRaw<
          { waiting: boolean; blockers: number[]; query: string }[]
        >`
          SELECT wait_event_type = 'Lock' AS waiting, pg_blocking_pids(pid) AS blockers, query
          FROM pg_stat_activity WHERE pid = ${waiterPid}`;
        if (backend?.waiting) {
          expect(backend.blockers).toContain(writerPid);
          expect(backend.query).toContain('FROM "staff"');
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      release();
      await writer;
      expect(await waiter).toMatchObject({ error: { error: "PERMISSION_DENIED" } });
      expect(await snapshot(f.input.entityId)).toEqual(before);
    } finally {
      release();
      await Promise.allSettled([writer, waiter]);
      await observer.$disconnect();
    }
  });
});
