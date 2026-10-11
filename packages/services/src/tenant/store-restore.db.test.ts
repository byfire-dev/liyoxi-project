import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createIdentityContext,
  defineRegistration,
  implementMerchantFacts,
  isAppError,
  merchantFactsPort,
  uuidv7,
} from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { assembleForTest, useSeededDatabase } from "../testing/index.js";
import { createTenant } from "./index.js";
import { memberContext, restoreHarness, restoreIdem, SLOW } from "./__fixtures__/store-restore.js";
import type { RestoreHarness } from "./__fixtures__/store-restore.js";

const db = useSeededDatabase("services", { max: 1 });
let h: RestoreHarness;
beforeAll(async () => {
  h = restoreHarness(await db.prisma());
}, SLOW);
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.restoreParams();
});

describe("恢复门店：真实额度与单事务", { timeout: SLOW }, () => {
  it("真实归档后恢复仅清五列，不复活店员/邀请/选择，返回完整当前卡片", async () => {
    const own = await h.owner();
    const clerk = await h.clerk(own);
    const card = await h.card(own);
    await h.prisma.entityMember.update({
      where: { id: own.memberId },
      data: { lastStoreId: own.secondId },
    });
    // 合法历史授权与同意证据；恢复不能撤销或重新签发它们。
    const portal = await h.prisma.portalSession.create({
      data: {
        id: uuidv7(),
        tokenHash: new Uint8Array(32).fill(27),
        portalTicketId: uuidv7(),
        approvedByUserId: own.userId,
        entityId: own.entityId,
        storeId: own.secondId,
        grantScope: "store",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
        expiresAt: new Date(h.clock.now().getTime() + 7_200_000),
        ip: "203.0.113.27",
        userAgent: "restore-fixture",
      },
    });
    const consent = await h.make.agreementConsent({
      scene: "member_join",
      role: "clerk",
      merchantUserId: clerk.userId,
      entityId: own.entityId,
      storeId: own.secondId,
    });
    await h.tenant.archiveStore(own.ctx, { storeId: own.secondId });
    const before = await h.trace(own);
    const result = await h.tenant.restoreStore(own.ctx, { storeId: own.secondId });
    const after = await h.trace(own);
    expect(result).toEqual(
      (await h.tenant.listStores({ merchantUserId: own.userId })).items.find(
        (row) => row.storeId === own.secondId,
      ),
    );
    expect(result).toMatchObject({
      storeId: own.secondId,
      lifecycle: "active",
      archivedAt: null,
      archiveReason: null,
      isPrimary: false,
      clerkCount: 0,
      pendingInvitationCount: 0,
    });
    expect(after.stores.find((row) => row.id === own.secondId)).toMatchObject({
      lifecycle: "active",
      archivedAt: null,
      archiveActorType: null,
      archiveActorId: null,
      archiveClient: null,
      archiveReason: null,
    });
    for (const key of ["entity", "members", "links", "invitations", "timers"] as const)
      expect(after[key]).toEqual(before[key]);
    expect(after.history.slice(before.history.length)).toMatchObject([
      { event: "store.restore", fromState: "archived", toState: "active", actorId: own.userId },
    ]);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    expect(after.events.slice(before.events.length)).toMatchObject([
      {
        eventType: "store.restored",
        payload: {
          v: 1,
          storeId: own.secondId,
          entityId: own.entityId,
          fromState: "archived",
          toState: "active",
          transition: "store.restore",
        },
      },
    ]);
    expect(
      await h.prisma.invitation.findUniqueOrThrow({ where: { id: card.invitationId } }),
    ).toMatchObject({ status: "revoked", tokenEnc: null });
    expect(
      await h.tenant.resolveMembership(h.prisma, {
        merchantUserId: clerk.userId,
        storeId: own.secondId,
      }),
    ).toBeNull();
    expect(
      await h.tenant.resolveMembership(h.prisma, {
        merchantUserId: own.userId,
        storeId: own.secondId,
      }),
    ).toMatchObject({ role: "owner", storeMode: "active" });
    expect(await h.prisma.portalSession.findUnique({ where: { id: portal.id } })).toEqual(portal);
    expect(await h.prisma.agreementConsent.findUnique({ where: { id: consent.id } })).toEqual(
      consent,
    );
  });

  it.each(["active", "target_archived", "other_archived"] as const)(
    "%s 老板上下文可恢复同主体门店",
    async (mode) => {
      const own = await h.archived();
      let contextId = own.storeId;
      if (mode === "target_archived") contextId = own.secondId;
      if (mode === "other_archived") {
        const other = await h.make.store({ entityId: own.entityId });
        await h.tenant.archiveStore(own.ctx, { storeId: other.id });
        contextId = other.id;
      }
      expect(
        await h.tenant.restoreStore(memberContext(own.userId, own.entityId, contextId), {
          storeId: own.secondId,
        }),
      ).toMatchObject({ storeId: own.secondId, lifecycle: "active" });
    },
  );

  it.each(["override", "default", "plan"] as const)(
    "%s 使用既有正式额度来源，启用草稿同样计数",
    async (mode) => {
      const own = await h.archived();
      await h.prisma.entity.update({
        where: { id: own.entityId },
        data: { storeLimitOverride: mode === "override" ? 2 : null },
      });
      if (mode === "default") await h.limit(2);
      if (mode === "plan") await h.make.subscriptionTerm({ entityId: own.entityId, maxStores: 2 });
      const usage = await h.tx.run((tx) => h.tenant.getQuotaUsage(tx, own.entityId));
      expect(usage).toMatchObject({
        storesUsed: 1,
        storeLimit: 2,
        limitReason: mode === "plan" ? "plan" : "inactive",
      });
      await h.tenant.restoreStore(own.ctx, { storeId: own.secondId });
      expect(await h.tx.run((tx) => h.tenant.getQuotaUsage(tx, own.entityId))).toMatchObject({
        storesUsed: 2,
        storesOver: 0,
      });
    },
  );

  it.each(["inactive", "plan"] as const)("%s 超限三个details且整笔零写", async (mode) => {
    const own = await h.archived();
    await h.prisma.entity.update({
      where: { id: own.entityId },
      data: { storeLimitOverride: null },
    });
    await h.limit(1);
    if (mode === "plan") await h.make.subscriptionTerm({ entityId: own.entityId, maxStores: 1 });
    const before = await h.state();
    await expect(h.tenant.restoreStore(own.ctx, { storeId: own.secondId })).rejects.toMatchObject({
      error: "STORE_LIMIT_REACHED",
      details: { storesUsed: 1, storeLimit: 1, limitReason: mode },
    });
    expect(await h.state()).toEqual(before);
  });

  it("同键重放原StoreCard，路径/上下文变化冲突，异键重复恢复拒绝", async () => {
    const own = await h.archived(),
      key = uuidv7();
    const result = await h.tenant.restoreStore(
      own.ctx,
      { storeId: own.secondId },
      {
        idem: restoreIdem(own.ctx, own.secondId, key),
      },
    );
    const before = await h.state();
    h.clock.advance(1);
    expect(
      await h.tenant.restoreStore(
        own.ctx,
        { storeId: own.secondId },
        {
          idem: restoreIdem(own.ctx, own.secondId, key),
        },
      ),
    ).toEqual(result);
    for (const pathChanged of [false, true]) {
      const ctx = pathChanged ? own.ctx : memberContext(own.userId, own.entityId, own.secondId);
      const storeId = pathChanged ? own.storeId : own.secondId;
      await expect(
        h.tenant.restoreStore(ctx, { storeId }, { idem: restoreIdem(ctx, storeId, key) }),
      ).rejects.toMatchObject({ error: "IDEMPOTENCY_KEY_REUSED" });
    }
    await expect(h.tenant.restoreStore(own.ctx, { storeId: own.secondId })).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    expect(await h.state()).toEqual(before);
  });

  it.each([
    "clerk",
    "disabled",
    "deleted",
    "foreign",
    "missing",
    "noStore",
    "portal",
    "system",
  ] as const)("%s 无权恢复且全部事实不变", async (mode) => {
    const own = await h.archived();
    const clerk = await h.clerk(own, [own.storeId]);
    const foreign = await h.owner();
    if (mode === "disabled" || mode === "deleted")
      await h.prisma.merchantUser.update({
        where: { id: own.userId },
        data: {
          status: mode,
          ...(mode === "deleted"
            ? {
                deletedAt: h.clock.now(),
                phoneEnc: null,
                phoneBidx: null,
                phoneMask: null,
                phoneLast4: null,
                displayName: null,
              }
            : {}),
        },
      });
    const ctx =
      mode === "clerk"
        ? clerk.ctx
        : mode === "foreign"
          ? foreign.ctx
          : mode === "noStore"
            ? memberContext(own.userId, own.entityId)
            : mode === "portal"
              ? createIdentityContext({
                  actor: { type: "merchant", id: own.userId, client: "portal" },
                  entityId: own.entityId,
                  storeId: own.storeId,
                })
              : mode === "system"
                ? createIdentityContext({
                    actor: { type: "system", job: "restore" },
                    entityId: own.entityId,
                    storeId: own.storeId,
                  })
                : own.ctx;
    const before = await h.state();
    const error =
      mode === "clerk"
        ? "ROLE_FORBIDDEN"
        : ["foreign", "missing"].includes(mode)
          ? "NOT_FOUND"
          : "NOT_A_MEMBER";
    await expect(
      h.tenant.restoreStore(ctx, { storeId: mode === "missing" ? uuidv7() : own.secondId }),
    ).rejects.toMatchObject({ error });
    expect(await h.state()).toEqual(before);
  });

  it.each(["active", "draft_deleted", "entity_closed", "entity_abandoned"] as const)(
    "%s 目标不恢复或枚举",
    async (reason) => {
      const own = await h.archived();
      if (reason === "active") await h.tenant.restoreStore(own.ctx, { storeId: own.secondId });
      else
        await h.prisma.store.update({
          where: { id: own.secondId },
          data: {
            archiveReason: reason,
            ...(reason === "entity_abandoned"
              ? { archiveActorType: "system", archiveActorId: null, archiveClient: null }
              : {}),
          },
        });
      const before = await h.state();
      await expect(h.tenant.restoreStore(own.ctx, { storeId: own.secondId })).rejects.toMatchObject(
        { error: reason === "draft_deleted" ? "NOT_FOUND" : "STATE_NOT_ALLOWED" },
      );
      expect(await h.state()).toEqual(before);
    },
  );

  it.each(["closed", "abandoned"] as const)("%s 主体不能复活", async (lifecycle) => {
    const own = await h.archived();
    await h.prisma.entity.update({
      where: { id: own.entityId },
      data: { lifecycle, closedAt: h.clock.now() },
    });
    const before = await h.state();
    await expect(h.tenant.restoreStore(own.ctx, { storeId: own.secondId })).rejects.toMatchObject({
      error: "NOT_A_MEMBER",
    });
    expect(await h.state()).toEqual(before);
  });

  it.each(["event", "outer", "quota_facts", "projection_facts"] as const)(
    "%s 原事务失败回滚全部事实与幂等",
    async (mode) => {
      const own = await h.archived(),
        before = await h.state(),
        failure = new Error(`restore ${mode}`);
      let tenant = h.tenant;
      if (mode === "event") {
        const original = h.events.emit.bind(h.events);
        vi.spyOn(h.events, "emit").mockImplementation(async (...args) => {
          const result = await original(...args);
          if (args[2].type === "store.restored") throw failure;
          return result;
        });
      } else if (mode === "outer") {
        const tx: TxRunner = {
          run: (fn, options) =>
            h.tx.run(async (t) => {
              await fn(t);
              throw failure;
            }, options),
        };
        tenant = createTenant({
          tx,
          clock: h.clock,
          flow: h.flow,
          events: h.events,
          assembly: h.assembly,
          archiveTimers: h.timers,
        });
      } else {
        const assembly = assembleForTest({
          entry: "api",
          withoutRealPorts: [merchantFactsPort],
          extra: [
            defineRegistration("lyxtest_restore_facts", {
              portImplementations: [
                implementMerchantFacts(mode === "quota_facts" ? "billing" : "profile", async () => {
                  throw failure;
                }),
              ],
            }),
          ],
        });
        tenant = createTenant({
          tx: h.tx,
          clock: h.clock,
          flow: h.flow,
          events: h.events,
          assembly,
          archiveTimers: h.timers,
        });
      }
      await expect(
        tenant.restoreStore(
          own.ctx,
          { storeId: own.secondId },
          { idem: restoreIdem(own.ctx, own.secondId) },
        ),
      ).rejects.toThrow(failure);
      expect(await h.state()).toEqual(before);
    },
  );

  it.each(["merchant", "system", "other_store"] as const)(
    "直接flow %s 不取得私有见证",
    async (mode) => {
      const own = await h.archived();
      const ctx =
        mode === "system"
          ? createIdentityContext({
              actor: { type: "system", job: "tenant.store.restore" },
              entityId: own.entityId,
              storeId: own.secondId,
            })
          : own.ctx;
      const target = mode === "other_store" ? own.storeId : own.secondId;
      const before = await h.state();
      try {
        await h.tx.run((tx) =>
          h.flow.transition(tx, ctx, {
            machine: "store",
            stateField: "lifecycle",
            id: target,
            entityId: own.entityId,
            storeId: target,
            event: "store.restore",
            set: {
              archived_at: null,
              archive_actor_type: null,
              archive_actor_id: null,
              archive_client: null,
              archive_reason: null,
            },
            emit: {
              type: "store.restored",
              payload: { v: 1, storeId: target, entityId: own.entityId },
            },
          }),
        );
        throw new Error("直接迁移不应成功");
      } catch (error) {
        expect(isAppError(error)).toBe(true);
        if (isAppError(error)) {
          expect(error.error).toBe("STATE_NOT_ALLOWED");
          if (mode !== "other_store") expect(error.details).toMatchObject({ reason: "guard" });
        }
      }
      expect(await h.state()).toEqual(before);
    },
  );
});
