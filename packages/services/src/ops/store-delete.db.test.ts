import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { countSubmittedQualificationHistory } from "../profile/index.js";
import { createTenant } from "../tenant/index.js";
import { snapshotTables, useSeededDatabase } from "../testing/index.js";
import { readStoreDraftFacts } from "./store-draft-facts.js";
import {
  deleteContext,
  deleteHarness,
  deleteIdem,
  deleteServices,
  SLOW,
  TABLES,
} from "./__fixtures__/store-delete.js";
import type { DeleteHarness } from "./__fixtures__/store-delete.js";

const db = useSeededDatabase("services");
let h: DeleteHarness;
beforeAll(async () => {
  h = deleteHarness(await db.prisma());
}, SLOW);
afterAll(() => h?.close());
afterEach(() => vi.restoreAllMocks());
const empty = {
  qualificationSubmissions: 0,
  orders: 0,
  ads: 0,
  channelAccounts: 0,
  serviceTickets: 0,
  originalAssets: 0,
};
function remove(w: Awaited<ReturnType<DeleteHarness["world"]>>, tenant = h.tenant, key = uuidv7()) {
  return tenant.deleteStore(
    w.ctx,
    { storeId: w.store.id },
    { idem: deleteIdem(w.ctx, w.store.id, key) },
  );
}

describe("草稿门店删除：真实历史拥有者及完整事务", { timeout: SLOW }, () => {
  it.each(["orders", "ads", "channelAccounts", "serviceTickets", "originalAssets"] as const)(
    "%s 的终态/未处理原创仍是历史，失败不写任何级联或收据",
    async (kind) => {
      const w = await h.world();
      await h.business(w, kind);
      const before = await h.state();
      expect(
        await h.tx.run((tx) =>
          readStoreDraftFacts(tx, { entityId: w.entity.id, storeId: w.store.id }),
        ),
      ).toEqual({ ...empty, [kind]: 1 });
      await expect(remove(w)).rejects.toMatchObject({
        error: "STORE_NOT_DRAFT",
        details: { reasons: ["has_business_data"] },
      });
      expect(await h.state()).toEqual(before);
    },
  );

  it.each(["initial", "new_store", "change"] as const)(
    "%s 历史 submittedAt 在真实系统撤回后仍计数，未提交草稿不计",
    async (kind) => {
      const w = await h.base.owner(kind),
        draft = await h.draft(w, kind);
      const input = { entityId: w.entity.id, storeId: w.store.id };
      expect(await h.tx.run((tx) => countSubmittedQualificationHistory(tx, input))).toBe(0);
      await h.submitted(draft);
      expect(await h.tx.run((tx) => countSubmittedQualificationHistory(tx, input))).toBe(1);
      await h.terminate(w);
      await h.invoke(await h.event(w, "entity.closed"));
      expect(
        await h.prisma.qualificationSubmission.findUniqueOrThrow({ where: { id: draft.round.id } }),
      ).toMatchObject({ outcome: "withdrawn" });
      expect(await h.tx.run((tx) => countSubmittedQualificationHistory(tx, input))).toBe(1);
      expect(
        await h.tx.run((tx) =>
          countSubmittedQualificationHistory(tx, { ...input, entityId: uuidv7() }),
        ),
      ).toBe(0);
    },
  );

  it("真实 initial 提交批准后的首店不可删除；两类原因固定次序且每类只出现一次", async () => {
    const { owner, profile, ready } = await h.readyInitial();
    await profile.approve(h.system, ready.submissionId, { confirm: { roundNo: 1 } });
    await h.make.store({ entityId: owner.entity.id });
    const ctx = deleteContext(owner.user.id, owner.entity.id, owner.store.id);
    const own = await h.world();
    const scope = { ...own, user: owner.user, entity: owner.entity, store: owner.store };
    await h.business(scope, "orders");
    await h.business(scope, "serviceTickets");
    const before = await h.state();
    await expect(
      h.tenant.deleteStore(
        ctx,
        { storeId: owner.store.id },
        { idem: deleteIdem(ctx, owner.store.id) },
      ),
    ).rejects.toMatchObject({
      error: "STORE_NOT_DRAFT",
      details: { reasons: ["qualification_submitted", "has_business_data"] },
    });
    expect(await h.state()).toEqual(before);
  });

  it.each(["orders", "ads", "channelAccounts"] as const)(
    "%s 的原在办阻断优先于草稿历史拒绝",
    async (kind) => {
      const w = await h.world();
      await h.business(w, kind, false);
      const before = await h.state();
      await expect(remove(w)).rejects.toMatchObject({ error: "STORE_HAS_OPEN_WORK" });
      expect(await h.state()).toEqual(before);
    },
  );

  it.each(["qualification_in_review", "open_delivery_ticket", "unverified_primary_store"] as const)(
    "%s 的其余真实原阻断不被删除历史判定掩盖",
    async (kind) => {
      const w = await h.world();
      let ctx = w.ctx,
        storeId = w.store.id;
      if (kind === "qualification_in_review") await h.submitted(await h.draft(w, "new_store"));
      if (kind === "open_delivery_ticket") {
        const order = await h.make.dramaOrder({
          entityId: w.entity.id,
          storeId,
          status: "producing",
        });
        const item = await h.make.orderItem({ dramaOrderId: order.id, phase: "producing" });
        await h.make.deliveryTicket({ orderItemId: item.id, step: "assigning" });
      }
      if (kind === "unverified_primary_store") {
        const own = await h.make.merchant({ verified: false });
        await h.make.store({ entityId: own.entity.id });
        ctx = deleteContext(own.user.id, own.entity.id, own.store.id);
        storeId = own.store.id;
      }
      const before = await h.state();
      await expect(
        h.tenant.deleteStore(ctx, { storeId }, { idem: deleteIdem(ctx, storeId) }),
      ).rejects.toMatchObject({
        error: "STORE_HAS_OPEN_WORK",
        details: { blockers: expect.arrayContaining([{ kind, count: 1 }]) },
      });
      expect(await h.state()).toEqual(before);
    },
  );

  it("六个真实历史读取均限定主体/门店，复制及已删除原创不挡删除", async () => {
    const w = await h.world(),
      foreign = await h.world();
    for (const kind of [
      "orders",
      "ads",
      "channelAccounts",
      "serviceTickets",
      "originalAssets",
    ] as const)
      await h.business(foreign, kind);
    const original = await h.asset({ ...w, store: w.primary });
    const copied = await h.asset(w, { sourceStoreAssetId: original.id });
    const deleted = await h.asset(w, { deletedAt: h.clock.now() });
    const before = await h.prisma.storeAsset.findMany({
      where: { id: { in: [original.id, copied.id, deleted.id] } },
      orderBy: { id: "asc" },
    });
    expect(
      await h.tx.run((tx) =>
        readStoreDraftFacts(tx, { entityId: w.entity.id, storeId: w.store.id }),
      ),
    ).toEqual(empty);
    expect(
      await h.tx.run((tx) =>
        readStoreDraftFacts(tx, { entityId: foreign.entity.id, storeId: w.store.id }),
      ),
    ).toEqual(empty);
    const result = await remove(w);
    expect(result).toEqual({ storeId: w.store.id, deletedAt: h.clock.now().toISOString() });
    expect(
      await h.prisma.storeAsset.findMany({
        where: { id: { in: before.map((a) => a.id) } },
        orderBy: { id: "asc" },
      }),
    ).toEqual(before);
  });

  it("完整级联只移除失去最后有效店的店员，两个事件及 receipt 同事务唯一", async () => {
    const w = await h.world(),
      removed = await h.clerk(w),
      survivor = await h.clerk(w, [w.store.id, w.primary.id]);
    const card = await h.card(w),
      foreign = await h.world();
    const other = await h.card(foreign),
      otherBefore = await h.prisma.invitation.findUniqueOrThrow({
        where: { id: other.invitationId },
      });
    await h.prisma.entityMember.update({
      where: { id: w.member.id },
      data: { lastStoreId: w.store.id },
    });
    const key = uuidv7(),
      result = await remove(w, h.tenant, key);
    expect(await h.prisma.store.findUniqueOrThrow({ where: { id: w.store.id } })).toMatchObject({
      lifecycle: "archived",
      archiveReason: "draft_deleted",
      archiveActorType: "merchant",
      archiveActorId: w.user.id,
      archiveClient: "weapp",
      archivedAt: h.clock.now(),
    });
    expect(
      await h.prisma.invitation.findUniqueOrThrow({ where: { id: card.invitationId } }),
    ).toMatchObject({ status: "revoked", tokenEnc: null, revokeReason: "store_archived" });
    expect(
      await h.prisma.timer.findFirstOrThrow({
        where: { subjectId: card.invitationId, kind: "invitation.expire" },
      }),
    ).toMatchObject({ status: "cancelled" });
    expect(
      await h.prisma.entityMember.findUniqueOrThrow({ where: { id: removed.member.id } }),
    ).toMatchObject({
      status: "removed",
      removeReason: "store_archived",
      removeActorType: "system",
      lastStoreId: null,
    });
    expect(
      await h.prisma.entityMember.findUniqueOrThrow({ where: { id: survivor.member.id } }),
    ).toMatchObject({ status: "active", lastStoreId: null });
    expect(
      await h.prisma.entityMember.findUniqueOrThrow({ where: { id: w.member.id } }),
    ).toMatchObject({ status: "active", role: "owner", lastStoreId: null });
    expect(await h.prisma.storeMember.findMany({ where: { storeId: w.store.id } })).toEqual([]);
    expect(
      await h.prisma.storeMember.findMany({ where: { entityMemberId: survivor.member.id } }),
    ).toMatchObject([{ storeId: w.primary.id }]);
    expect(
      await h.prisma.invitation.findUniqueOrThrow({ where: { id: other.invitationId } }),
    ).toEqual(otherBefore);
    const events = await h.prisma.outboxEvent.findMany({
      where: {
        entityId: w.entity.id,
        eventType: { in: ["store.archived", "store.draft_deleted"] },
      },
      orderBy: { seq: "asc" },
    });
    expect(events.map((e) => [e.eventType, e.payload])).toEqual([
      [
        "store.archived",
        {
          v: 1,
          entityId: w.entity.id,
          storeId: w.store.id,
          archiveReason: "draft_deleted",
          fromState: "active",
          toState: "archived",
          transition: "store.draft_delete",
        },
      ],
      ["store.draft_deleted", { v: 1, entityId: w.entity.id, storeId: w.store.id }],
    ]);
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: w.store.id, event: "store.draft_delete" },
      }),
    ).toBe(1);
    expect(
      await h.prisma.auditLog.count({
        where: { entityId: w.entity.id, action: "tenant.store.draft_delete" },
      }),
    ).toBe(1);
    const before = await h.state();
    expect(await remove(w, h.tenant, key)).toEqual(result);
    expect(await h.state()).toEqual(before);
    await expect(remove(w)).rejects.toMatchObject({ error: "NOT_FOUND" });
    await expect(h.tenant.restoreStore(w.ctx, { storeId: w.store.id })).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    await expect(h.tenant.archiveStore(w.ctx, { storeId: w.store.id })).rejects.toMatchObject({
      error: "NOT_FOUND",
    });
    expect(await h.state()).toEqual(before);
  });

  it.each(["missing", "undefined", "extra", "negative", "fraction", "throws"] as const)(
    "%s 历史装配保守关闭且不写收据",
    async (mode) => {
      const w = await h.world();
      const read = async () => {
        if (mode === "throws") throw new Error("真实拥有者读取失败");
        return mode === "undefined"
          ? undefined
          : mode === "extra"
            ? { ...empty, unknown: 0 }
            : { ...empty, orders: mode === "negative" ? -1 : mode === "fraction" ? 0.5 : 0 };
      };
      // 明确模拟外部装配的未知运行值，不改变生产接口或给未知值默认零。
      const tenant = createTenant({
        ...h.deps,
        readStoreDraftFacts:
          mode === "missing"
            ? undefined
            : (read as unknown as NonNullable<typeof h.deps.readStoreDraftFacts>),
      });
      const before = await h.state();
      if (mode === "throws") await expect(remove(w, tenant)).rejects.toThrow("真实拥有者读取失败");
      else await expect(remove(w, tenant)).rejects.toMatchObject({ error: "INTERNAL" });
      expect(await h.state()).toEqual(before);
    },
  );

  it.each(["second_event", "outer_rollback"] as const)(
    "%s 回滚完整级联、timer和 required 幂等收据",
    async (mode) => {
      const w = await h.world();
      await h.clerk(w);
      await h.card(w);
      const failure = new Error("删除完整事务故障"),
        before = await h.state();
      const runner: TxRunner = {
        run: (fn, options) =>
          h.tx.run(async (tx) => {
            const result = await fn(tx);
            if (mode === "outer_rollback") throw failure;
            return result;
          }, options),
      };
      const side = deleteServices(h.prisma, h.base, runner);
      const real = side.events.emit;
      vi.spyOn(side.events, "emit").mockImplementation(async (tx, ctx, input) => {
        const result = await real(tx, ctx, input);
        if (mode === "second_event" && input.type === "store.draft_deleted") throw failure;
        return result;
      });
      try {
        await expect(remove(w, side.tenant)).rejects.toBe(failure);
        expect(await h.state()).toEqual(before);
      } finally {
        side.close();
      }
    },
  );

  it("无本实例/事务/目标 operation 见证的直调 guard 必须拒绝而非伪造迁移", async () => {
    const w = await h.world(),
      before = await h.state();
    await expect(
      h.tx.run((tx) =>
        h.flow.transition(tx, w.ctx, {
          machine: "store",
          stateField: "lifecycle",
          id: w.store.id,
          entityId: w.entity.id,
          storeId: w.store.id,
          event: "store.draft_delete",
          ref: "02:609",
          reasonCode: "draft_deleted",
          set: {
            archived_at: h.clock.now(),
            archive_actor_type: "merchant",
            archive_actor_id: w.user.id,
            archive_client: "weapp",
            archive_reason: "draft_deleted",
          },
          emit: {
            type: "store.archived",
            payload: {
              v: 1,
              entityId: w.entity.id,
              storeId: w.store.id,
              archiveReason: "draft_deleted",
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ error: "STATE_NOT_ALLOWED", details: { reason: "guard" } });
    expect(await h.state()).toEqual(before);
  });

  it("跨主体、最后一家和店员权限保留原拒绝语义", async () => {
    const w = await h.world(),
      foreign = await h.world(),
      clerk = await h.clerk(w, [w.primary.id]);
    const before = await snapshotTables(h.prisma, TABLES);
    await expect(
      h.tenant.deleteStore(
        w.ctx,
        { storeId: foreign.store.id },
        { idem: deleteIdem(w.ctx, foreign.store.id) },
      ),
    ).rejects.toMatchObject({ error: "NOT_FOUND" });
    const ctx = deleteContext(clerk.user.id, w.entity.id, w.primary.id);
    await expect(
      h.tenant.deleteStore(ctx, { storeId: w.store.id }, { idem: deleteIdem(ctx, w.store.id) }),
    ).rejects.toMatchObject({ error: "ROLE_FORBIDDEN" });
    expect(await h.state()).toEqual(before);
    await remove(w);
    await expect(
      h.tenant.deleteStore(
        w.ctx,
        { storeId: w.primary.id },
        { idem: deleteIdem(w.ctx, w.primary.id) },
      ),
    ).rejects.toMatchObject({ error: "LAST_ACTIVE_STORE" });
    const system = createIdentityContext({
      actor: { type: "system", job: "lyxtest.delete" },
      entityId: w.entity.id,
      storeId: w.primary.id,
    });
    await expect(
      h.tenant.deleteStore(
        system,
        { storeId: w.primary.id },
        { idem: deleteIdem(system, w.primary.id) },
      ),
    ).rejects.toMatchObject({ error: "NOT_A_MEMBER" });
  });
});
