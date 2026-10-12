import { EntityCardSchema } from "@liyoxi/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownTaskScope } from "../authz/index.js";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { findI17Violations, findI28Violations } from "../tenant/index.js";
import { snapshotTables, useSeededDatabase } from "../testing/index.js";
import { closeCall, closeHarness, realReaders, SLOW } from "./__fixtures__/admin-entity-close.js";
import type { CloseHarness, CloseWorld } from "./__fixtures__/admin-entity-close.js";

const db = useSeededDatabase("services", { label: "adminclose", max: 1 });
let h: CloseHarness;
beforeAll(async () => {
  h = closeHarness(await db.prisma());
}, SLOW);
afterAll(() => {
  h?.close();
}, SLOW);
const audits = (w: CloseWorld) =>
  h.prisma.auditLog.findMany({
    where: { entityId: w.entityId },
    orderBy: { seq: "asc" },
  });
const MONEY = [
  "billing_account",
  "billing_order",
  "subscription_term",
  "grant_schedule",
  "point_hold",
  "point_hold_alloc",
  "point_lot",
  "point_ledger_entry",
  "ledger_operation",
  "payment_txn",
];

describe("后台主体关闭：required完整卡片、真实级联和当前授权", { timeout: SLOW }, () => {
  it("首次关闭返回同Tx完整卡片，保留历史并提交严格事件/审计/定时器/portal终态", async () => {
    const w = await h.extended(await h.world()),
      body = await h.input(w),
      now = h.clock.now();
    const active = await h.grant(w),
      expired = await h.grant(w, { expired: true });
    const revoked = await h.grant(w, { revoked: true });
    const foreign = await h.grant(await h.world());
    const original = await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } });
    body.reasonText = "  主体申请关闭经营服务😀😀  ";
    const money = await snapshotTables(h.prisma, MONEY);
    const card = await closeCall(h.tenant, w, body);
    expect(EntityCardSchema.parse(card)).toEqual(card);
    expect(card).toEqual(await h.tenant.adminEntityGet(w.staff, w.entityId));
    expect(card).toMatchObject({
      entityId: w.entityId,
      lifecycle: "closed",
      closedAt: now.toISOString(),
      owner: null,
      lockVersion: original.lockVersion + 1,
      actions: [],
      pendingInvitations: [],
      usage: { storesUsed: 0, seatsUsed: 0, activeMemberCount: 0, pendingInvitationCount: 0 },
    });
    expect(card.stores).toHaveLength(3);
    expect(card.stores.every((row) => row.lifecycle === "archived" && row.clerkCount === 0)).toBe(
      true,
    );
    expect(await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } })).toMatchObject({
      lifecycle: "closed",
      closedAt: now,
      lockVersion: original.lockVersion + 1,
      storeLimitOverride: original.storeLimitOverride,
      memberLimitOverride: original.memberLimitOverride,
    });
    const memberIds = [w.merchant.owner.id, w.clerk.id].sort(),
      storeIds = [w.merchant.store.id, w.store.id].sort();
    for (const id of memberIds)
      expect(await h.prisma.entityMember.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "removed",
        removedAt: now,
        removeReason: "entity_closed",
        lastStoreId: null,
        removeActorType: "staff",
        removeActorId: w.staff.staff.id,
        removeClient: "admin",
      });
    for (const id of storeIds)
      expect(await h.prisma.store.findUniqueOrThrow({ where: { id } })).toMatchObject({
        lifecycle: "archived",
        archivedAt: now,
        archiveReason: "entity_closed",
        archiveActorType: "staff",
        archiveActorId: w.staff.staff.id,
        archiveClient: "admin",
      });
    expect(await h.prisma.storeMember.count({ where: { entityId: w.entityId } })).toBe(0);
    expect(
      await h.prisma.invitation.findUniqueOrThrow({ where: { id: w.pending.id } }),
    ).toMatchObject({
      status: "revoked",
      revokedAt: now,
      tokenEnc: null,
      revokeReason: "entity_closed",
      revokeActorType: "staff",
      revokeActorId: w.staff.staff.id,
      revokeClient: "admin",
    });
    expect(await h.prisma.store.findUniqueOrThrow({ where: { id: w.oldStore.id } })).toEqual(
      w.oldStore,
    );
    expect(
      await h.prisma.entityMember.findUniqueOrThrow({ where: { id: w.oldMember.id } }),
    ).toEqual(w.oldMember);
    expect(await h.prisma.invitation.findUniqueOrThrow({ where: { id: w.oldInvite.id } })).toEqual(
      w.oldInvite,
    );
    expect(await h.prisma.timer.findUniqueOrThrow({ where: { id: w.timer.id } })).toMatchObject({
      status: "cancelled",
    });
    for (const row of [active, expired])
      expect(
        await h.prisma.portalSession.findUniqueOrThrow({ where: { id: row.id } }),
      ).toMatchObject({ revokedAt: now, revokeReason: "membership_changed" });
    for (const row of [revoked, foreign])
      expect(await h.prisma.portalSession.findUniqueOrThrow({ where: { id: row.id } })).toEqual(
        row,
      );
    const history = await h.prisma.statusTransition.findMany({
      where: { entityId: w.entityId },
      orderBy: { seq: "asc" },
    });
    expect(history.map((row) => [row.machine, row.fromState, row.toState, row.event])).toEqual([
      ["entity", "active", "closed", "entity.close"],
      ["invitation", "pending", "revoked", "invitation.revoke"],
      ...memberIds.map(() => [
        "entity_member",
        "active",
        "removed",
        "entity_member.cascade_remove",
      ]),
      ...storeIds.map(() => ["store", "active", "archived", "store.archive_by_entity"]),
    ]);
    expect(
      history.every((row) => row.actorType === "staff" && row.actorId === w.staff.staff.id),
    ).toBe(true);
    const events = await h.prisma.outboxEvent.findMany({
      where: { entityId: w.entityId },
      orderBy: { seq: "asc" },
    });
    expect(events.map((row) => row.eventType)).toEqual([
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
      closedBy: "staff_close",
      fromState: "active",
      toState: "closed",
      transition: "entity.close",
    });
    expect(
      events.every((row) => row.actorType === "staff" && row.actorId === w.staff.staff.id),
    ).toBe(true);
    const written = await audits(w);
    expect(written).toHaveLength(6);
    expect(written.find((row) => row.action === "tenant.entity.close")).toMatchObject({
      stream: "ops",
      category: "merchant_lifecycle",
      actorType: "staff",
      actorId: w.staff.staff.id,
      reasonCode: "staff_close",
      reasonText: body.reasonText.trim(),
      meta: { confirm: body.confirm },
    });
    expect(await snapshotTables(h.prisma, MONEY)).toEqual(money);
    expect(
      (await findI17Violations(h.prisma)).filter((row) => row.entityId === w.entityId),
    ).toEqual([]);
    expect(
      (await findI28Violations(h.prisma)).filter((row) => row.entityId === w.entityId),
    ).toEqual([]);
  });

  it.each([
    "subscription_active",
    "payment_open",
    "refund_open",
    "invoice_open",
    "open_order",
    "release_online",
  ] as const)("%s：真实阻断事实给精确数量且包括required占位在内零写", async (kind) => {
    const w = await h.world();
    await h.block(w, kind);
    const body = await h.input(w),
      before = await h.state();
    await expect(closeCall(h.tenant, w, body)).rejects.toMatchObject({
      error: "ENTITY_CLOSE_BLOCKED",
      details: { blockers: [{ kind, count: 1 }] },
    });
    expect(await h.state()).toEqual(before);
  });

  it.each([
    "scope",
    "missing",
    "closed",
    "abandoned",
    "confirm_store",
    "confirm_member",
    "owner_omitted",
    "actor",
  ] as const)("%s：精确守卫且全部记录零写", async (mode) => {
    let w = await h.world();
    const body = await h.input(w);
    if (mode === "scope") w = { ...w, staff: { ...w.staff, scope: ownTaskScope(w.staff.staff) } };
    if (mode === "missing") w = { ...w, entityId: uuidv7() };
    if (mode === "actor")
      w = {
        ...w,
        ctx: createIdentityContext({ actor: { type: "staff", id: uuidv7(), client: "admin" } }),
      };
    if (mode === "closed" || mode === "abandoned")
      await h.prisma.entity.update({
        where: { id: w.entityId },
        data: { lifecycle: mode, closedAt: h.clock.now() },
      });
    if (mode === "confirm_store") body.confirm.activeStoreCount++;
    if (mode === "confirm_member") body.confirm.activeMemberCount++;
    if (mode === "owner_omitted") body.confirm.activeMemberCount = 0;
    const before = await h.state();
    await expect(closeCall(h.tenant, w, body)).rejects.toMatchObject({
      error:
        mode === "scope" || mode === "missing"
          ? "NOT_FOUND"
          : mode === "closed" || mode === "abandoned"
            ? "STATE_NOT_ALLOWED"
            : mode === "actor"
              ? "PERMISSION_DENIED"
              : "CONFIRM_MISMATCH",
    });
    expect(await h.state()).toEqual(before);
  });

  it("同键回放原完整卡片；新键不能重复关闭，异正文键精确拒绝", async () => {
    const w = await h.world(),
      body = await h.input(w),
      key = uuidv7();
    const first = await closeCall(h.tenant, w, body, key);
    await h.prisma.entity.update({ where: { id: w.entityId }, data: { name: "关闭后的历史名称" } });
    const before = await h.state();
    expect((await h.tenant.adminEntityGet(w.staff, w.entityId)).name).not.toBe(first.name);
    expect(await closeCall(h.tenant, w, body, key)).toEqual(first);
    await expect(closeCall(h.tenant, w, body)).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    await expect(
      closeCall(h.tenant, w, { ...body, reasonText: "这是另一份合法关闭申请原因" }, key),
    ).rejects.toMatchObject({ error: "IDEMPOTENCY_KEY_REUSED" });
    expect(await h.state()).toEqual(before);
    expect((await audits(w)).filter((row) => row.action === "tenant.entity.close")).toHaveLength(1);
  });

  it.each([
    "permission",
    "scope",
    "stale",
    "no_stepup",
    "disabled",
    "role",
    "group",
    "lead",
  ] as const)("%s：已有成功键仍复查当前授权和issued scope，原卡片收据零改动", async (mode) => {
    let w = await h.world();
    const body = await h.input(w),
      key = uuidv7();
    await closeCall(h.tenant, w, body, key);
    if (mode === "permission") w = { ...w, staff: { ...w.staff, permissions: new Set() } };
    if (mode === "scope") w = { ...w, staff: { ...w.staff, scope: ownTaskScope(w.staff.staff) } };
    if (mode === "stale" || mode === "no_stepup")
      w = {
        ...w,
        staff: {
          ...w.staff,
          stepUpAt: mode === "no_stepup" ? null : new Date(h.clock.now().getTime() - 600_001),
        },
      };
    if (mode === "disabled")
      await h.prisma.staff.update({
        where: { id: w.staff.staff.id },
        data: { status: "disabled", disabledAt: h.clock.now(), disabledReason: "other" },
      });
    if (mode === "role")
      await h.prisma.staff.update({
        where: { id: w.staff.staff.id },
        data: { staffRoleKey: "finance" },
      });
    if (mode === "lead")
      await h.prisma.staff.update({
        where: { id: w.staff.staff.id },
        data: { isLead: !w.staff.staff.isLead },
      });
    if (mode === "group") {
      const group = await h.prisma.staffGroup.create({
        data: {
          id: uuidv7(),
          name: `关闭组${uuidv7()}`,
          staffRoleKey: "super_admin",
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      });
      await h.prisma.staff.update({
        where: { id: w.staff.staff.id },
        data: { staffGroupId: group.id },
      });
    }
    const before = await h.state();
    await expect(closeCall(h.tenant, w, body, key)).rejects.toMatchObject({
      error:
        mode === "stale" || mode === "no_stepup"
          ? "STEP_UP_REQUIRED"
          : mode === "scope"
            ? "NOT_FOUND"
            : "PERMISSION_DENIED",
    });
    expect(await h.state()).toEqual(before);
  });

  it.each(["all_bindings", "billing", "profiles", "assets", "orders", "account"] as const)(
    "%s：真实关闭后的卡片读取失败回滚整个级联、事件和收据",
    async (mode) => {
      const w = await h.extended(await h.world()),
        readers = { ...realReaders };
      await h.grant(w);
      if (["billing", "profiles", "assets", "orders"].includes(mode))
        Object.defineProperty(readers, mode, { value: undefined });
      if (mode === "account")
        await h.prisma.billingAccount.deleteMany({ where: { entityId: w.entityId } });
      const body = await h.input(w),
        before = await h.state();
      await expect(
        closeCall(h.service(h.tx, mode === "all_bindings" ? null : readers), w, body),
      ).rejects.toMatchObject({ error: "INTERNAL" });
      expect(await h.state()).toEqual(before);
    },
  );

  it("同键失败无成功收据，完整写闭包和卡片读后故障可原键重试", async () => {
    const w = await h.extended(await h.world()),
      body = await h.input(w),
      key = uuidv7();
    const before = await h.state(),
      failure = new Error("close卡片已读后故障");
    let reached = false;
    const runner: TxRunner = {
      run: (fn, options) =>
        h.tx.run(async (tx) => {
          const result = await fn(tx);
          if (options?.idem) {
            expect(await tx.entity.findUniqueOrThrow({ where: { id: w.entityId } })).toMatchObject({
              lifecycle: "closed",
            });
            expect(await tx.outboxEvent.count({ where: { entityId: w.entityId } })).toBe(6);
            expect(
              await tx.idempotencyRecord.count({ where: { scope: "admin.entity.close", key } }),
            ).toBe(1);
            expect(EntityCardSchema.parse(result)).toMatchObject({ lifecycle: "closed" });
            reached = true;
            throw failure;
          }
          return result;
        }, options),
    };
    await expect(closeCall(h.service(runner), w, body, key)).rejects.toBe(failure);
    expect(reached).toBe(true);
    expect(await h.state()).toEqual(before);
    expect(await closeCall(h.tenant, w, body, key)).toMatchObject({ lifecycle: "closed" });
    expect((await audits(w)).filter((row) => row.action === "tenant.entity.close")).toHaveLength(1);
  });

  it("readonly预检完全返回后越过StepUp期限，已有键仍拒绝且无写", async () => {
    const w = await h.world(),
      body = await h.input(w),
      key = uuidv7(),
      previous = h.clock.now();
    await closeCall(h.tenant, w, body, key);
    const before = await h.state();
    let returnedRead = false;
    const runner: TxRunner = {
      run: async (fn, options) => {
        const result = await h.tx.run(fn, options);
        if (!options?.idem) {
          returnedRead = true;
          h.clock.set(new Date(previous.getTime() + 600_001));
        }
        return result;
      },
    };
    try {
      await expect(closeCall(h.service(runner), w, body, key)).rejects.toMatchObject({
        error: "STEP_UP_REQUIRED",
      });
      expect(returnedRead).toBe(true);
      expect(await h.state()).toEqual(before);
    } finally {
      h.clock.set(previous);
    }
  });

  it.each(["success", "rollback"] as const)(
    "真实广告取消/审批/定时器/portal %s，账本始终不动",
    async (mode) => {
      let w = await h.world();
      const previous = h.clock.now();
      try {
        const ad = await h.adCancel(w);
        w = { ...w, staff: ad.staff };
        await h.grant(w);
        const body = await h.input(w),
          before = await h.state(),
          money = await snapshotTables(h.prisma, MONEY);
        const failure = new Error("真实cancel.withdrawn和卡片后故障");
        let reached = false;
        const runner: TxRunner = {
          run: (fn, options) =>
            h.tx.run(async (tx) => {
              const result = await fn(tx);
              if (options?.idem && mode === "rollback") {
                expect(
                  await tx.outboxEvent.count({
                    where: { aggregateId: ad.request.id, eventType: "cancel.withdrawn" },
                  }),
                ).toBe(1);
                reached = true;
                throw failure;
              }
              return result;
            }, options),
        };
        if (mode === "rollback") {
          await expect(closeCall(h.service(runner), w, body)).rejects.toBe(failure);
          expect(reached).toBe(true);
          expect(await h.state()).toEqual(before);
        } else {
          expect(await closeCall(h.tenant, w, body)).toMatchObject({
            lifecycle: "closed",
            owner: null,
          });
          expect(
            await h.prisma.cancelRequest.findUniqueOrThrow({ where: { id: ad.request.id } }),
          ).toMatchObject({
            status: "not_executed",
            closeReason: "withdrawn",
            closedAt: h.clock.now(),
          });
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
          expect(
            await h.prisma.outboxEvent.findFirstOrThrow({
              where: { aggregateId: ad.request.id, eventType: "cancel.withdrawn" },
            }),
          ).toMatchObject({ actorType: "system", actorId: null });
          expect(
            await h.prisma.portalSession.count({
              where: { entityId: w.entityId, revokedAt: null },
            }),
          ).toBe(0);
        }
        expect(await snapshotTables(h.prisma, MONEY)).toEqual(money);
      } finally {
        h.clock.set(previous);
      }
    },
  );
});
