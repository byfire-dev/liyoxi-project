import { termDates } from "@liyoxi/shared/period";
import { addDays, calendarDate, endOfDay, startOfDay } from "@liyoxi/shared/time";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFlow } from "../flow/index.js";
import { createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import type { Assembly, IdentityContext } from "../kernel/index.js";
import { entityAdCancelClosePort, membershipAuthorizationsPort } from "../tenant/index.js";
import { snapshotTables, useSeededDatabase } from "../testing/index.js";
import { lifecycleHarness, memberContext, SLOW } from "./__fixtures__/tenant-account-lifecycle.js";
import type { LifecycleHarness, LifecycleWorld } from "./__fixtures__/tenant-account-lifecycle.js";

const db = useSeededDatabase("services", { label: "accountlife", max: 1 });
let h: LifecycleHarness;
beforeAll(async () => {
  h = await lifecycleHarness(await db.prisma());
}, SLOW);
afterAll(() => {
  h?.close();
}, SLOW);
const caller = () => h.service(h.directRunner);
const row = (w: LifecycleWorld) => h.prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } });

describe("账号生命周期 callerTx：真实授权、级联及原子性", { timeout: SLOW }, () => {
  it("本人老板关闭：真实完整级联、严格历史事件、精准portal与timer，保留旧记录", async () => {
    const original = await h.world();
    const w = { ...(await h.extended(original)), memberCtx: original.memberCtx };
    await h.prisma.entityMember.update({
      where: { id: w.merchant.owner.id },
      data: { displayName: "老板关系名" },
    });
    await h.prisma.entityMember.update({
      where: { id: w.clerk.id },
      data: { displayName: "店员关系名" },
    });
    const active = await h.grant(w),
      expired = await h.grant(w, { expired: true });
    const revoked = await h.grant(w, { revoked: true }),
      foreign = await h.grant(await h.world());
    const money = await snapshotTables(h.prisma, [
      "billing_account",
      "billing_order",
      "subscription_term",
      "payment_txn",
      "point_ledger_entry",
    ]);
    let prepare = 0,
      withdraw = 0;
    const real = h.assembly.port;
    const assembly: Assembly = {
      ...h.assembly,
      port: ((key) =>
        key === entityAdCancelClosePort
          ? {
              prepare: async () => {
                prepare++;
                throw new Error("owner不得走staff低锁prepare");
              },
              withdraw: async () => {
                withdraw++;
                throw new Error("owner不得撤回staff取消申请");
              },
            }
          : real(key)) as Assembly["port"],
    };
    const now = h.clock.now();
    const result = await h.tx.run((tx) =>
      h.withAssembly(assembly).closeEntityForOwnerDeletionIn(tx, w.memberCtx),
    );
    expect(result).toEqual({
      entityId: w.entityId,
      lifecycle: "closed",
      invitationIds: [w.pending.id],
      memberIds: [w.merchant.owner.id, w.clerk.id].sort(),
      storeIds: [w.merchant.store.id, w.store.id].sort(),
      withdrawnCancelRequestIds: [],
      revokedPortalGrantCount: 2,
    });
    expect({ prepare, withdraw }).toEqual({ prepare: 0, withdraw: 0 });
    expect(await row(w)).toMatchObject({ lifecycle: "closed", closedAt: now });
    for (const [id, reason, name] of [
      [w.merchant.owner.id, "account_deleted", null],
      [w.clerk.id, "entity_closed", "店员关系名"],
    ] as const)
      expect(await h.prisma.entityMember.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "removed",
        removeReason: reason,
        displayName: name,
        lastStoreId: null,
        removeActorType: "merchant",
        removeActorId: w.merchant.user.id,
        removeClient: "weapp",
        removedAt: now,
      });
    for (const id of result.storeIds)
      expect(await h.prisma.store.findUniqueOrThrow({ where: { id } })).toMatchObject({
        lifecycle: "archived",
        archiveReason: "entity_closed",
        archiveActorType: "merchant",
        archiveActorId: w.merchant.user.id,
        archiveClient: "weapp",
        archivedAt: now,
      });
    expect(await h.prisma.storeMember.count({ where: { entityId: w.entityId } })).toBe(0);
    expect(
      await h.prisma.invitation.findUniqueOrThrow({ where: { id: w.pending.id } }),
    ).toMatchObject({
      status: "revoked",
      tokenEnc: null,
      revokeReason: "entity_closed",
      revokeActorType: "merchant",
      revokeActorId: w.merchant.user.id,
      revokeClient: "weapp",
    });
    expect(await h.prisma.timer.findUniqueOrThrow({ where: { id: w.timer.id } })).toMatchObject({
      status: "cancelled",
    });
    for (const grant of [active, expired])
      expect(
        await h.prisma.portalSession.findUniqueOrThrow({ where: { id: grant.id } }),
      ).toMatchObject({
        revokedAt: now,
        revokeReason: "membership_changed",
      });
    for (const grant of [revoked, foreign])
      expect(await h.prisma.portalSession.findUniqueOrThrow({ where: { id: grant.id } })).toEqual(
        grant,
      );
    expect(await h.prisma.store.findUniqueOrThrow({ where: { id: w.oldStore.id } })).toEqual(
      w.oldStore,
    );
    expect(
      await h.prisma.entityMember.findUniqueOrThrow({ where: { id: w.oldMember.id } }),
    ).toEqual(w.oldMember);
    expect(await h.prisma.invitation.findUniqueOrThrow({ where: { id: w.oldInvite.id } })).toEqual(
      w.oldInvite,
    );
    const history = await h.prisma.statusTransition.findMany({
      where: { entityId: w.entityId },
      orderBy: { seq: "asc" },
    });
    expect(history.map((r) => [r.machine, r.fromState, r.toState, r.event])).toEqual([
      ["entity", "active", "closed", "entity.close"],
      ["invitation", "pending", "revoked", "invitation.revoke"],
      ...result.memberIds.map(() => [
        "entity_member",
        "active",
        "removed",
        "entity_member.cascade_remove",
      ]),
      ...result.storeIds.map(() => ["store", "active", "archived", "store.archive_by_entity"]),
    ]);
    expect(
      history.every(
        (r) =>
          r.actorType === "merchant" && r.actorId === w.merchant.user.id && r.client === "weapp",
      ),
    ).toBe(true);
    const events = await h.prisma.outboxEvent.findMany({
      where: { entityId: w.entityId },
      orderBy: { seq: "asc" },
    });
    expect(events.map((r) => r.eventType)).toEqual([
      "entity.closed",
      "invitation.revoked",
      "entity_member.removed",
      "entity_member.removed",
      "store.archived",
      "store.archived",
    ]);
    expect(events[0]!.payload).toEqual({
      v: 1,
      entityId: w.entityId,
      closedBy: "owner_deletion",
      fromState: "active",
      toState: "closed",
      transition: "entity.close",
    });
    for (const event of events) {
      expect(event).toMatchObject({
        actorType: "merchant",
        actorId: w.merchant.user.id,
        client: "weapp",
      });
      expect(event.payload).toMatchObject({
        fromState: expect.any(String),
        toState: expect.any(String),
        transition: expect.any(String),
      });
    }
    const audits = await h.prisma.auditLog.findMany({ where: { entityId: w.entityId } });
    expect(audits).toHaveLength(6);
    expect(audits.find((r) => r.action === "tenant.entity.close")).toMatchObject({
      actorType: "merchant",
      actorId: w.merchant.user.id,
      reasonCode: "owner_deletion",
    });
    expect(
      await snapshotTables(h.prisma, [
        "billing_account",
        "billing_order",
        "subscription_term",
        "payment_txn",
        "point_ledger_entry",
      ]),
    ).toEqual(money);
  });

  it.each([
    "subscription_active",
    "payment_open",
    "refund_open",
    "invoice_open",
    "open_order",
    "release_online",
  ] as const)("%s：真实六阻断的精确非零事实全部零写", async (kind) => {
    const w = await h.world();
    await h.block(w, kind);
    const before = await h.state();
    await expect(
      h.tx.run((tx) => caller().closeEntityForOwnerDeletionIn(tx, w.memberCtx)),
    ).rejects.toMatchObject({
      error: "ACCOUNT_DELETION_BLOCKED",
      details: { blockers: [{ kind, count: 1 }] },
    });
    expect(await h.state()).toEqual(before);
  });

  it.each(["system", "staff", "clerk", "disabled", "removed", "closed"] as const)(
    "%s：owner关闭必须重新核实当前账号与实际老板关系",
    async (mode) => {
      const w = await h.world();
      let ctx = w.memberCtx;
      if (mode === "system") ctx = h.system(w);
      if (mode === "staff") ctx = w.ctx;
      if (mode === "clerk") ctx = (await h.clerk(w)).ctx;
      if (mode === "disabled")
        await h.prisma.merchantUser.update({
          where: { id: w.merchant.user.id },
          data: { status: "disabled" },
        });
      if (mode === "removed")
        await h.prisma.entityMember.update({
          where: { id: w.merchant.owner.id },
          data: {
            status: "removed",
            removedAt: h.clock.now(),
            removeReason: "account_deleted",
            removeActorType: "merchant",
            removeActorId: w.merchant.user.id,
            removeClient: "weapp",
            lastStoreId: null,
          },
        });
      if (mode === "closed")
        await h.prisma.entity.update({
          where: { id: w.entityId },
          data: { lifecycle: "closed", closedAt: h.clock.now() },
        });
      const before = await h.state();
      await expect(
        h.tx.run((tx) => caller().closeEntityForOwnerDeletionIn(tx, ctx)),
      ).rejects.toMatchObject({
        error:
          mode === "disabled" || mode === "removed"
            ? "NOT_A_MEMBER"
            : mode === "closed"
              ? "STATE_NOT_ALLOWED"
              : "ROLE_FORBIDDEN",
      });
      expect(await h.state()).toEqual(before);
    },
  );

  it("ctx中的其他主体不能替代当前本人老板关系，外国主体保持原样", async () => {
    const w = await h.world(),
      foreign = await h.world();
    const before = await row(foreign);
    const result = await h.tx.run((tx) =>
      caller().closeEntityForOwnerDeletionIn(
        tx,
        memberContext(w.merchant.user.id, foreign.entityId, foreign.merchant.store.id),
      ),
    );
    expect(result.entityId).toBe(w.entityId);
    expect(await row(foreign)).toEqual(before);
  });

  it("空草稿：真实事实、排序门店全集、系统历史及仅本人portal吊销", async () => {
    const w = await h.world(true),
      extra = await h.make.store({ entityId: w.entityId });
    const own = await h.grant(w),
      expired = await h.grant(w, { expired: true });
    const otherUser = await h.make.merchantUser();
    const unrelated = await h.grant(w, { userId: otherUser.id });
    const account = await h.prisma.merchantUser.findUniqueOrThrow({
      where: { id: w.merchant.user.id },
    });
    const result = await h.tx.run((tx) =>
      caller().abandonDraftIn(tx, memberContext(w.merchant.user.id)),
    );
    expect(result).toEqual({
      entityId: w.entityId,
      memberId: w.merchant.owner.id,
      storeIds: [w.merchant.store.id, extra.id].sort(),
    });
    expect(await row(w)).toMatchObject({ lifecycle: "abandoned", closedAt: h.clock.now() });
    expect(
      await h.prisma.entityMember.findUniqueOrThrow({ where: { id: result.memberId } }),
    ).toMatchObject({
      status: "removed",
      removeReason: "draft_abandoned",
      removeActorType: "system",
      removeActorId: null,
      removeClient: null,
      lastStoreId: null,
    });
    for (const id of result.storeIds)
      expect(await h.prisma.store.findUniqueOrThrow({ where: { id } })).toMatchObject({
        lifecycle: "archived",
        archiveReason: "entity_abandoned",
        archiveActorType: "system",
        archiveActorId: null,
        archiveClient: null,
      });
    expect(await h.prisma.storeMember.count({ where: { entityId: w.entityId } })).toBe(0);
    for (const grant of [own, expired])
      expect(
        await h.prisma.portalSession.findUniqueOrThrow({ where: { id: grant.id } }),
      ).toMatchObject({ revokedAt: h.clock.now(), revokeReason: "membership_changed" });
    expect(await h.prisma.portalSession.findUniqueOrThrow({ where: { id: unrelated.id } })).toEqual(
      unrelated,
    );
    expect(await h.prisma.merchantUser.findUniqueOrThrow({ where: { id: account.id } })).toEqual(
      account,
    );
    const trace = await h.trace(w.entityId);
    expect(trace.events.map((r) => r.payload)).toEqual([
      {
        v: 1,
        entityId: w.entityId,
        fromState: "active",
        toState: "abandoned",
        transition: "entity.abandon",
      },
    ]);
    expect(trace.history).toHaveLength(1);
    expect(trace.history[0]).toMatchObject({ actorType: "system", actorId: null, client: null });
  });

  it.each([
    "verified",
    "another_member",
    "pending",
    "expired_pending",
    "historical_term",
    "historical_order",
  ] as const)("%s：空草稿实际事实不满足时零写，历史/已过期pending也不能忽略", async (mode) => {
    const w = await h.world(true);
    if (mode === "verified")
      await h.prisma.entity.update({
        where: { id: w.entityId },
        data: { verificationStatus: "verified" },
      });
    if (mode === "another_member") await h.clerk(w);
    if (mode === "pending" || mode === "expired_pending") {
      const invite = await h.invitation(w);
      if (mode === "expired_pending")
        await h.prisma.invitation.update({
          where: { id: invite.invitationId },
          data: {
            createdAt: new Date(h.clock.now().getTime() - 86_400_000),
            expiresAt: new Date(h.clock.now().getTime() - 1),
          },
        });
      expect(invite.row.status).toBe("pending");
    }
    if (mode === "historical_term") {
      const period = termDates(addDays(calendarDate(h.clock.now()), -32), 1);
      await h.make.subscriptionTerm({
        entityId: w.entityId,
        status: "ended",
        endedAt: h.clock.now(),
        startDate: new Date(period.startDate),
        endDate: new Date(period.endDate),
        anchorDay: period.anchorDay,
        startsAt: startOfDay(period.startDate),
        activatedAt: startOfDay(period.startDate),
        endsAt: endOfDay(period.endDate),
      });
    }
    if (mode === "historical_order")
      await h.make.billingOrder({ entityId: w.entityId, status: "cancelled" });
    const before = await h.state();
    await expect(h.tx.run((tx) => caller().abandonDraftIn(tx, w.memberCtx))).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    expect(await h.state()).toEqual(before);
  });

  it.each(["owner_remove", "leave", "dormant", "account_deleted"] as const)(
    "%s：callerTx成员清理保留身份/协议/登录与账号名，清空全部门店关系",
    async (kind) => {
      const w = await h.world(),
        second = await h.make.store({ entityId: w.entityId });
      const person = await h.sessions.person("账号名称不应被清理");
      const member = await h.make.entityMember({
        entityId: w.entityId,
        merchantUserId: person.userId,
        role: "clerk",
        displayName: "关系显示名",
        lastStoreId: second.id,
      });
      for (const storeId of [w.merchant.store.id, second.id])
        await h.make.storeMember({ entityId: w.entityId, entityMemberId: member.id, storeId });
      const ctx =
        kind === "owner_remove" ? w.memberCtx : memberContext(person.userId, w.entityId, second.id);
      const stable = await snapshotTables(h.prisma, [
        "merchant_user",
        "wechat_identity",
        "user_session",
        "agreement_consent",
        "file_ref",
        "store_asset",
      ]);
      const result = await h.tx.run((tx) =>
        caller().removeMemberIn(
          tx,
          ctx,
          kind === "owner_remove" ? { kind, memberId: member.id } : { kind },
        ),
      );
      expect(result).toEqual({
        memberId: member.id,
        status: "removed",
        removedAt: h.clock.now().toISOString(),
      });
      const reason = kind === "owner_remove" ? "by_owner" : kind === "leave" ? "self" : kind;
      const system = kind === "dormant";
      expect(
        await h.prisma.entityMember.findUniqueOrThrow({ where: { id: member.id } }),
      ).toMatchObject({
        status: "removed",
        lastStoreId: null,
        removeReason: reason,
        displayName: kind === "dormant" || kind === "account_deleted" ? null : "关系显示名",
        removeActorType: system ? "system" : "merchant",
        removeActorId: system ? null : ctx.actor.id,
        removeClient: system ? null : "weapp",
      });
      expect(await h.prisma.storeMember.count({ where: { entityMemberId: member.id } })).toBe(0);
      expect(
        await snapshotTables(h.prisma, [
          "merchant_user",
          "wechat_identity",
          "user_session",
          "agreement_consent",
          "file_ref",
          "store_asset",
        ]),
      ).toEqual(stable);
      const trace = await h.trace(member.id);
      const transition =
        kind === "owner_remove"
          ? "entity_member.remove"
          : kind === "leave"
            ? "entity_member.leave"
            : "entity_member.cascade_remove";
      expect(trace.history).toHaveLength(1);
      expect(trace.audits).toHaveLength(1);
      expect(trace.events).toHaveLength(1);
      expect(trace.history[0]).toMatchObject({
        fromState: "active",
        toState: "removed",
        event: transition,
        reasonCode: reason,
      });
      expect(trace.events[0]!.payload).toEqual({
        v: 1,
        entityMemberId: member.id,
        entityId: w.entityId,
        merchantUserId: person.userId,
        role: "clerk",
        removeReason: reason,
        fromState: "active",
        toState: "removed",
        transition,
      });
    },
  );

  it.each(["leave", "dormant", "account_deleted"] as const)(
    "%s：老板不能通过店员清理移除自己",
    async (kind) => {
      const w = await h.world(),
        before = await h.state();
      await expect(
        h.tx.run((tx) => caller().removeMemberIn(tx, w.memberCtx, { kind })),
      ).rejects.toMatchObject({
        error: kind === "leave" ? "OWNER_CANNOT_LEAVE" : "ROLE_FORBIDDEN",
      });
      expect(await h.state()).toEqual(before);
    },
  );

  it("移除明确目标仍受当前老板和同主体约束，不能移除外国成员", async () => {
    const w = await h.world(),
      foreign = await h.world(),
      c = await h.clerk(foreign);
    const before = await h.state();
    await expect(
      h.tx.run((tx) =>
        caller().removeMemberIn(tx, w.memberCtx, { kind: "owner_remove", memberId: c.member.id }),
      ),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(await h.state()).toEqual(before);
  });

  it.each(["by_owner", "unshared_leave"] as const)(
    "%s：撤邀请沿callerTx且真实timer/密文/历史事件只写一次",
    async (reason) => {
      const w = await h.world(),
        invite = await h.invitation(w);
      const createdTrace = await h.trace(invite.invitationId);
      const result = await h.tx.run((tx) =>
        caller().revokeInvitationIn(tx, w.memberCtx, { invitationId: invite.invitationId, reason }),
      );
      expect(result).toEqual({
        invitationId: invite.invitationId,
        status: "revoked",
        revokedAt: h.clock.now().toISOString(),
      });
      expect(
        await h.prisma.invitation.findUniqueOrThrow({ where: { id: invite.invitationId } }),
      ).toMatchObject({
        status: "revoked",
        tokenEnc: null,
        revokeReason: reason,
        revokeActorId: w.merchant.user.id,
      });
      const timers = await h.prisma.timer.findMany({
        where: { subjectId: invite.invitationId, kind: "invitation.expire" },
      });
      expect(timers).toHaveLength(1);
      expect(timers[0]!.status).toBe("cancelled");
      const trace = await h.trace(invite.invitationId);
      expect(trace.history.slice(createdTrace.history.length).map((r) => r.event)).toEqual([
        "invitation.revoke",
      ]);
      expect(trace.events.slice(createdTrace.events.length).map((r) => r.payload)).toEqual([
        {
          v: 1,
          invitationId: invite.invitationId,
          entityId: w.entityId,
          storeId: w.merchant.store.id,
          fromState: "pending",
          toState: "revoked",
          transition: "invitation.revoke",
        },
      ]);
      expect(trace.audits.slice(createdTrace.audits.length)).toHaveLength(1);
      const before = await h.state();
      await expect(
        h.tx.run((tx) =>
          caller().revokeInvitationIn(tx, w.memberCtx, {
            invitationId: invite.invitationId,
            reason,
          }),
        ),
      ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
      expect(await h.state()).toEqual(before);
    },
  );

  it.each(["shared_leave", "foreign", "clerk"] as const)(
    "%s：callerTx撤邀请保留原授权及状态边界",
    async (mode) => {
      const w = await h.world(),
        invite = await h.invitation(w);
      let ctx = w.memberCtx;
      if (mode === "shared_leave")
        await h.prisma.invitation.update({
          where: { id: invite.invitationId },
          data: { sharedAt: h.clock.now() },
        });
      if (mode === "foreign") ctx = (await h.world()).memberCtx;
      if (mode === "clerk") ctx = (await h.clerk(w)).ctx;
      const before = await h.state();
      await expect(
        h.tx.run((tx) =>
          caller().revokeInvitationIn(tx, ctx, {
            invitationId: invite.invitationId,
            reason: mode === "shared_leave" ? "unshared_leave" : "by_owner",
          }),
        ),
      ).rejects.toMatchObject({
        error:
          mode === "shared_leave"
            ? "STATE_NOT_ALLOWED"
            : mode === "foreign"
              ? "NOT_FOUND"
              : "ROLE_FORBIDDEN",
      });
      expect(await h.state()).toEqual(before);
    },
  );

  it.each(["abandon", "close", "remove", "revoke"] as const)(
    "%s：成功写闭包后外层异常使整个callerTx回滚",
    async (kind) => {
      const w = await h.world(kind === "abandon");
      const target =
        kind === "remove"
          ? { memberId: (await h.clerk(w)).member.id }
          : kind === "revoke"
            ? { invitationId: (await h.invitation(w)).invitationId }
            : {};
      await h.grant(w);
      const before = await h.state(),
        failure = new Error(`outer rollback ${kind}`);
      await expect(
        h.tx.run(async (tx) => {
          await h.call(tx, kind, w, target);
          expect(
            await tx.statusTransition.count({ where: { entityId: w.entityId } }),
          ).toBeGreaterThan(0);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(await h.state()).toEqual(before);
    },
  );

  it.each(["event", "timer", "portal"] as const)(
    "%s：真实依赖落库后失败仍回滚全部级联",
    async (mode) => {
      const original = await h.world();
      const w = { ...(await h.extended(original)), memberCtx: original.memberCtx };
      await h.grant(w);
      const before = await h.state(),
        failure = new Error(`real ${mode} wrote then failed`);
      const flow = createFlow({
        assembly: h.assembly,
        clock: h.clock,
        events: {
          emit: async (...args: Parameters<typeof h.events.emit>) => {
            const result = await h.events.emit(...args);
            if (mode === "event") throw failure;
            return result;
          },
        },
      });
      const timers = {
        ...h.timers,
        cancel: async (...args: Parameters<typeof h.timers.cancel>) => {
          const result = await h.timers.cancel(...args);
          if (mode === "timer") throw failure;
          return result;
        },
      };
      const real = h.assembly.port,
        grants = real(membershipAuthorizationsPort);
      const assembly: Assembly = {
        ...h.assembly,
        port: ((key) =>
          key === membershipAuthorizationsPort
            ? {
                revokePortalGrants: async (
                  ...args: Parameters<typeof grants.revokePortalGrants>
                ) => {
                  const result = await grants.revokePortalGrants(...args);
                  if (mode === "portal") throw failure;
                  return result;
                },
              }
            : real(key)) as Assembly["port"],
      };
      const on = h.service(h.directRunner, { flow, assembly, entityClose: { assembly, timers } });
      await expect(
        h.tx.run((tx) => on.closeEntityForOwnerDeletionIn(tx, w.memberCtx)),
      ).rejects.toBe(failure);
      expect(await h.state()).toEqual(before);
    },
  );

  it.each(["merchant", "system", "extra_args"] as const)(
    "%s：直接状态迁移不能伪造私有空草稿或级联见证",
    async (mode) => {
      const w = await h.world(true),
        before = await h.state();
      const ctx: IdentityContext = mode === "system" ? h.system(w) : w.memberCtx;
      await expect(
        h.tx.run(async (tx) => {
          await lockRows(tx, "entity", [w.entityId]);
          await h.flow.transition(tx, ctx, {
            machine: "entity",
            stateField: "lifecycle",
            id: w.entityId,
            entityId: w.entityId,
            event: "entity.abandon",
            ref: "02:524",
            args: mode === "extra_args" ? { owner: true, emptyDraft: true, prepared: true } : {},
            set: { closed_at: h.clock.now() },
            emit: { type: "entity.abandoned", payload: { v: 1, entityId: w.entityId } },
          });
        }),
      ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED", details: { reason: "guard" } });
      expect(await h.state()).toEqual(before);
    },
  );

  it("成功用例结束后，同一Tx也不能重用私有级联见证到其他成员", async () => {
    const w = await h.world(),
      c = await h.clerk(w);
    const before = await h.state();
    await expect(
      h.tx.run(async (tx) => {
        await lockRows(tx, "merchant_user", [c.user.id]);
        await lockRows(tx, "entity", [w.entityId]);
        await lockRows(tx, "entity_member", [w.merchant.owner.id, c.member.id].sort());
        await caller().removeMemberIn(tx, c.ctx, { kind: "account_deleted" });
        await lockRows(tx, "entity_member", [w.merchant.owner.id]);
        await h.flow.transition(
          tx,
          createIdentityContext({
            actor: { type: "system", job: "forged" },
            entityId: w.entityId,
            requestId: uuidv7(),
          }),
          {
            machine: "entity_member",
            stateField: "status",
            id: w.merchant.owner.id,
            entityId: w.entityId,
            event: "entity_member.cascade_remove",
            ref: "02:695",
            reasonCode: "account_deleted",
            set: {
              removed_at: h.clock.now(),
              remove_actor_type: "system",
              remove_actor_id: null,
              remove_client: null,
              remove_reason: "account_deleted",
              last_store_id: null,
            },
            emit: {
              type: "entity_member.removed",
              payload: {
                v: 1,
                entityMemberId: w.merchant.owner.id,
                entityId: w.entityId,
                merchantUserId: w.merchant.user.id,
                role: "owner",
                removeReason: "account_deleted",
              },
            },
          },
        );
      }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED", details: { reason: "guard" } });
    expect(await h.state()).toEqual(before);
  });
});
