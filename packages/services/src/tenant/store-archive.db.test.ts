import { beforeAll, describe, expect, it, vi } from "vitest";
import { createIdentityContext, isAppError, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { createTenant, findI5Violations, findI17Violations, orderCloseFactsPort } from "./index.js";
import { archiveHarness, archiveIdem, memberContext, SLOW } from "./__fixtures__/store-archive.js";
import type { ArchiveHarness } from "./__fixtures__/store-archive.js";

const db = useSeededDatabase("services");
let h: ArchiveHarness;
beforeAll(async () => {
  h = archiveHarness(await db.prisma());
}, SLOW);

describe("门店停用：真实事务与系统级联", { timeout: SLOW }, () => {
  it("清理目标店范围，只移除失去最后启用门店的店员；老板与其他关系保留", async () => {
    const owner = await h.owner();
    const removed = await h.clerk(owner);
    const survivor = await h.clerk(owner, [owner.secondId, owner.storeId]);
    const untouched = await h.clerk(owner, [owner.storeId]);
    const foreign = await h.owner();
    const foreignBefore = await h.trace(foreign);
    const portal = await h.prisma.portalSession.create({
      data: {
        id: uuidv7(),
        tokenHash: new Uint8Array(32).fill(31),
        portalTicketId: uuidv7(),
        approvedByUserId: owner.userId,
        entityId: owner.entityId,
        storeId: owner.secondId,
        grantScope: "store",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
        expiresAt: new Date(h.clock.now().getTime() + 7_200_000),
        ip: "203.0.113.18",
        userAgent: "archive fixture",
      },
    });
    expect((await h.tx.run((tx) => h.tenant.getQuotaUsage(tx, owner.entityId))).seatsUsed).toBe(3);
    await h.prisma.entityMember.update({
      where: { id: owner.memberId },
      data: { lastStoreId: owner.secondId },
    });
    const before = await h.trace(owner);
    const result = await h.tenant.archiveStore(owner.ctx, { storeId: owner.secondId });
    expect(result).toMatchObject({
      store: {
        storeId: owner.secondId,
        lifecycle: "archived",
        archiveReason: "by_owner",
        actions: ["restore"],
      },
      revokedInvitationCount: 0,
      removedMemberCount: 1,
    });
    expect(Object.keys(result).sort()).toEqual([
      "removedMemberCount",
      "revokedInvitationCount",
      "store",
    ]);
    const after = await h.trace(owner);
    expect(after.entity).toEqual(before.entity);
    expect(after.stores.find((s) => s.id === owner.secondId)).toMatchObject({
      lifecycle: "archived",
      archivedAt: h.clock.now(),
      archiveActorType: "merchant",
      archiveActorId: owner.userId,
      archiveClient: "weapp",
      archiveReason: "by_owner",
    });
    expect(after.members.find((m) => m.id === removed.memberId)).toMatchObject({
      status: "removed",
      removeReason: "store_archived",
      removeActorType: "system",
      removeActorId: null,
      removeClient: null,
      lastStoreId: null,
    });
    for (const id of [owner.memberId, survivor.memberId])
      expect(after.members.find((m) => m.id === id)).toMatchObject({
        status: "active",
        lastStoreId: null,
      });
    expect(after.members.find((m) => m.id === untouched.memberId)).toEqual(
      before.members.find((m) => m.id === untouched.memberId),
    );
    expect(after.links.some((r) => r.storeId === owner.secondId)).toBe(false);
    expect(after.links.filter((r) => r.entityMemberId === survivor.memberId)).toMatchObject([
      { storeId: owner.storeId },
    ]);
    expect(after.history.map((r) => r.event)).toEqual([
      "store.archive",
      "entity_member.cascade_remove",
    ]);
    expect(after.audits).toHaveLength(2);
    expect(after.events.map((r) => r.eventType)).toEqual([
      "store.archived",
      "entity_member.removed",
    ]);
    expect(after.events[1]?.payload).toMatchObject({
      v: 1,
      merchantUserId: removed.userId,
      entityMemberId: removed.memberId,
      removeReason: "store_archived",
      transition: "entity_member.cascade_remove",
    });
    expect(
      await h.tenant.resolveMembership(h.prisma, {
        merchantUserId: removed.userId,
        storeId: owner.secondId,
      }),
    ).toBeNull();
    expect(
      await h.tenant.resolveMembership(h.prisma, {
        merchantUserId: survivor.userId,
        storeId: owner.storeId,
      }),
    ).toMatchObject({ role: "clerk" });
    expect(
      await h.tenant.resolveMembership(h.prisma, {
        merchantUserId: owner.userId,
        storeId: owner.secondId,
      }),
    ).toMatchObject({ role: "owner", storeMode: "archived" });
    expect(await h.trace(foreign)).toEqual(foreignBefore);
    expect(await h.prisma.portalSession.findUniqueOrThrow({ where: { id: portal.id } })).toEqual(
      portal,
    );
    expect((await h.tx.run((tx) => h.tenant.getQuotaUsage(tx, owner.entityId))).seatsUsed).toBe(2);
    expect(await h.tx.run((tx) => findI5Violations(tx))).toEqual([]);
    expect(await h.tx.run((tx) => findI17Violations(tx))).toEqual([]);
  });

  it("全部数据库 pending 邀请含时钟已过期都撤销并原子取消原 timer，其他店不动", async () => {
    const owner = await h.owner();
    const elapsed = await h.card(owner);
    h.clock.set(new Date(new Date(elapsed.expiresAt).getTime() + 1));
    const shared = await h.card(owner);
    const targetCtx = memberContext(owner.userId, owner.entityId, owner.secondId);
    await h.invitations.markInvitationShared(targetCtx, { invitationId: shared.invitationId });
    const sibling = await h.card(owner, owner.storeId);
    const siblingBefore = await h.prisma.invitation.findUniqueOrThrow({
      where: { id: sibling.invitationId },
    });
    const result = await h.tenant.archiveStore(owner.ctx, { storeId: owner.secondId });
    expect(result.revokedInvitationCount).toBe(2);
    for (const id of [elapsed.invitationId, shared.invitationId]) {
      const row = await h.prisma.invitation.findUniqueOrThrow({ where: { id } });
      expect(row).toMatchObject({
        status: "revoked",
        tokenEnc: null,
        revokeReason: "store_archived",
        revokeActorType: "system",
        revokeActorId: null,
        revokedAt: h.clock.now(),
      });
      expect(await h.prisma.invitationRequest.count({ where: { invitationId: id } })).toBe(1);
      expect(await h.prisma.timer.findMany({ where: { subjectId: id } })).toMatchObject([
        { status: "cancelled", kind: "invitation.expire" },
      ]);
      expect(
        await h.prisma.statusTransition.count({
          where: {
            subjectId: id,
            event: "invitation.revoke",
            actorType: "system",
            reasonCode: "store_archived",
          },
        }),
      ).toBe(1);
    }
    expect(
      await h.prisma.invitation.findUniqueOrThrow({ where: { id: sibling.invitationId } }),
    ).toEqual(siblingBefore);
    expect(
      await h.prisma.timer.findMany({ where: { subjectId: sibling.invitationId } }),
    ).toMatchObject([{ status: "scheduled" }]);
  });

  it("同键重放原 DTO 零旁写，异键重复停用拒绝，最后启用门店拒绝", async () => {
    const owner = await h.owner();
    const idem = archiveIdem(owner.ctx, owner.secondId);
    const first = await h.tenant.archiveStore(owner.ctx, { storeId: owner.secondId }, { idem });
    const snapshot = await h.state();
    h.clock.advance(1);
    expect(await h.tenant.archiveStore(owner.ctx, { storeId: owner.secondId }, { idem })).toEqual(
      first,
    );
    expect(await h.state()).toEqual(snapshot);
    await expect(
      h.tenant.archiveStore(owner.ctx, { storeId: owner.secondId }),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED" });
    await expect(
      h.tenant.archiveStore(owner.ctx, { storeId: owner.storeId }),
    ).rejects.toMatchObject({ error: "LAST_ACTIVE_STORE" });
    expect(await h.state()).toEqual(snapshot);
  });

  it.each(["clerk", "missing", "foreign", "disabled", "noStore", "portal", "system"] as const)(
    "%s 拒绝且没有任何业务旁写",
    async (mode) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const other = await h.owner();
      if (mode === "disabled")
        await h.prisma.merchantUser.update({
          where: { id: owner.userId },
          data: { status: "disabled" },
        });
      const ctx =
        mode === "clerk"
          ? clerk.ctx
          : mode === "noStore"
            ? memberContext(owner.userId, owner.entityId)
            : mode === "portal"
              ? createIdentityContext({
                  actor: { type: "merchant", id: owner.userId, client: "portal" },
                  entityId: owner.entityId,
                  storeId: owner.storeId,
                })
              : mode === "system"
                ? createIdentityContext({
                    actor: { type: "system", job: "test" },
                    entityId: owner.entityId,
                    storeId: owner.storeId,
                  })
                : owner.ctx;
      const storeId =
        mode === "missing" ? uuidv7() : mode === "foreign" ? other.secondId : owner.secondId;
      const before = await h.state();
      await expect(h.tenant.archiveStore(ctx, { storeId })).rejects.toMatchObject({
        error:
          mode === "clerk"
            ? "ROLE_FORBIDDEN"
            : mode === "missing" || mode === "foreign"
              ? "NOT_FOUND"
              : "NOT_A_MEMBER",
      });
      expect(await h.state()).toEqual(before);
    },
  );

  it("当前门店已归档拒绝继续写；有效其他店可读已归档目标", async () => {
    const owner = await h.owner();
    const oldCtx = memberContext(owner.userId, owner.entityId, owner.secondId);
    await h.tenant.archiveStore(oldCtx, { storeId: owner.secondId });
    const before = await h.state();
    await expect(h.tenant.archiveStore(oldCtx, { storeId: owner.storeId })).rejects.toMatchObject({
      error: "STORE_ARCHIVED",
    });
    const list = await h.tenant.listStores({ merchantUserId: owner.userId });
    expect(list.items.find((s) => s.storeId === owner.secondId)).toMatchObject({
      lifecycle: "archived",
    });
    expect(await h.state()).toEqual(before);
  });

  it.each(["second_event", "outer"] as const)(
    "%s 失败回滚门店/成员/邀请/timer/历史事件",
    async (mode) => {
      const owner = await h.owner();
      await h.clerk(owner);
      await h.card(owner);
      const before = await h.state();
      const failure = new Error(`archive ${mode}`);
      let restore = () => {};
      let tenant = h.tenant;
      if (mode === "second_event") {
        const original = h.events.emit.bind(h.events);
        let count = 0;
        const spy = vi.spyOn(h.events, "emit").mockImplementation(async (...args) => {
          const result = await original(...args);
          if (++count === 2) throw failure;
          return result;
        });
        restore = () => spy.mockRestore();
      } else {
        const runner: TxRunner = {
          run: (fn, options) =>
            h.tx.run(async (tx) => {
              await fn(tx);
              throw failure;
            }, options),
        };
        tenant = createTenant({
          tx: runner,
          clock: h.clock,
          flow: h.flow,
          events: h.events,
          assembly: h.assembly,
          archiveTimers: h.timers,
        });
      }
      try {
        await expect(tenant.archiveStore(owner.ctx, { storeId: owner.secondId })).rejects.toThrow(
          failure,
        );
        expect(await h.state()).toEqual(before);
      } finally {
        restore();
      }
    },
  );

  it.each(["store", "invitation", "member"] as const)(
    "%s 直接 flow/伪系统不取得私有级联权限",
    async (kind) => {
      const owner = await h.owner();
      const clerk = await h.clerk(owner);
      const card = await h.card(owner);
      const before = await h.state();
      const id =
        kind === "store"
          ? owner.secondId
          : kind === "invitation"
            ? card.invitationId
            : clerk.memberId;
      const event =
        kind === "store"
          ? "store.archive"
          : kind === "invitation"
            ? "invitation.revoke"
            : "entity_member.cascade_remove";
      const ctx =
        kind === "store"
          ? owner.ctx
          : createIdentityContext({
              actor: { type: "system", job: "tenant.store.archive" },
              entityId: owner.entityId,
              storeId: owner.secondId,
            });
      const attempt = h.tx.run((tx) =>
        h.flow.transition(tx, ctx, {
          ...(kind === "store"
            ? ({ machine: "store", stateField: "lifecycle" } as const)
            : kind === "invitation"
              ? ({ machine: "invitation", stateField: "status" } as const)
              : ({ machine: "entity_member", stateField: "status" } as const)),
          id,
          entityId: owner.entityId,
          storeId: owner.secondId,
          event,
          reasonCode: kind === "store" ? "by_owner" : "store_archived",
          emit: {
            type:
              kind === "store"
                ? "store.archived"
                : kind === "invitation"
                  ? "invitation.revoked"
                  : "entity_member.removed",
            payload:
              kind === "store"
                ? { v: 1, entityId: owner.entityId, storeId: id, archiveReason: "by_owner" }
                : kind === "invitation"
                  ? {
                      v: 1,
                      invitationId: id,
                      entityId: owner.entityId,
                      storeId: owner.secondId,
                    }
                  : {
                      v: 1,
                      entityMemberId: id,
                      entityId: owner.entityId,
                      merchantUserId: clerk.userId,
                      role: "clerk",
                      removeReason: "store_archived",
                    },
          },
        }),
      );
      const error: unknown = await attempt.catch((e: unknown) => e);
      expect(isAppError(error) && error.error).toBe("STATE_NOT_ALLOWED");
      expect(isAppError(error) && error.details).toMatchObject({ reason: "guard" });
      expect(await h.state()).toEqual(before);
    },
  );

  it("新入口缺 timer 装配拒绝；真实阻断端口失败整笔回滚而非视为零", async () => {
    const owner = await h.owner();
    const missing = createTenant({ tx: h.tx, clock: h.clock, flow: h.flow, assembly: h.assembly });
    expect(() => missing.archiveStore(owner.ctx, { storeId: owner.secondId })).toThrowError(
      expect.objectContaining({ error: "INTERNAL" }),
    );
    const failure = new Error("真实阻断拥有者不可用");
    const assembly = {
      ...h.assembly,
      port: ((port) => {
        if (port === orderCloseFactsPort) throw failure;
        return h.assembly.port(port);
      }) as typeof h.assembly.port,
    };
    // 构造时必需的计费历史装配仍是原 portEntries；只有调用真实阻断公口时失败。
    const tenant = createTenant({
      tx: h.tx,
      clock: h.clock,
      flow: h.flow,
      events: h.events,
      assembly,
      archiveTimers: h.timers,
    });
    const before = await h.state();
    await expect(tenant.archiveStore(owner.ctx, { storeId: owner.secondId })).rejects.toThrow(
      failure,
    );
    expect(await h.state()).toEqual(before);
  });

  it("I5 报告无启用门店的有效店员，不修复事实且不把老板计作孤儿", async () => {
    const owner = await h.owner();
    const orphan = await h.clerk(owner, []);
    const before = await h.state();
    const violations = await h.tx.run((tx) => findI5Violations(tx));
    expect(violations).toEqual([
      {
        subject: { type: "entity_member", id: orphan.memberId },
        entityId: owner.entityId,
        detail: { activeStores: 0 },
      },
    ]);
    expect(await h.state()).toEqual(before);
  });
});
