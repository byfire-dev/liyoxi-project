import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { createTenant } from "./index.js";
import type { TenantAdminReadDeps } from "./index.js";
import type { StaffContext } from "../authz/index.js";
import { managementHarness, SLOW } from "./__fixtures__/member-management.js";
import type { ManagementHarness } from "./__fixtures__/member-management.js";
import { sampleStaffContext, snapshotTables, useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";

const db = useSeededDatabase("services", { max: 1 });
let h: ManagementHarness;
beforeAll(async () => {
  h = managementHarness(await db.prisma());
}, SLOW);
afterEach(() => vi.restoreAllMocks());
const TABLES = [
  "entity",
  "store",
  "entity_member",
  "store_member",
  "invitation",
  "billing_account",
  "audit_log",
  "outbox_event",
  "status_transition",
  "timer",
  "idempotency_record",
];
async function staff(
  role: "super_admin" | "delivery_manager" | "cs" = "super_admin",
  isLead = false,
) {
  const row = await h.make.staff({ staffRoleKey: role, isLead });
  return sampleStaffContext(h.prisma, row.id);
}
function readers(): TenantAdminReadDeps {
  return {
    billing: vi.fn(async () => ({
      subscription: {
        status: "none",
        plan: null,
        months: null,
        startDate: null,
        endDate: null,
        hasScheduledTerm: false,
        isRefundPending: false,
        latestPaymentOrder: null,
      },
      spendablePoints: 17,
    })),
    profiles: vi.fn(
      async (_tx, input) =>
        new Map(
          input.storeIds.map((id) => [
            id,
            {
              lastDecidedAt: null,
              reviewDueAt: null,
              openQualificationSubmissionId: null,
              address: { city: null, district: null, detail: null },
              copiedFromStoreId: null,
            },
          ]),
        ),
    ),
    assets: vi.fn(async (_tx, input) => ({
      stores: new Map(
        input.storeIds.map((id) => [
          id,
          { assetCount: 0, reviewedAssetCount: 0, copiedAssetCount: 0 },
        ]),
      ),
      members: new Map(
        input.merchantUserIds.map((id) => [id, { uploadedAssetCount: 0, adoptedAssetCount: 0 }]),
      ),
    })),
    orders: vi.fn(async () => ({ live: 2, to_launch: 3 })),
  };
}
const tenant = (adminRead?: TenantAdminReadDeps) =>
  createTenant({
    tx: h.tx,
    clock: h.clock,
    assembly: h.assembly,
    events: h.events,
    flow: h.flow,
    ...(adminRead ? { adminRead } : {}),
  });
const list = (entityId: string, admin: Awaited<ReturnType<typeof staff>>, query = {}) =>
  tenant(readers()).adminEntityMemberList(admin, entityId, { includeRemoved: false, ...query });

describe("后台主体查询：真实范围及同事务窄事实", { timeout: SLOW }, () => {
  it("完整主体卡按原额度计算，单次时钟、批量事实与逐店订单；GET全表零写", async () => {
    const owner = await h.owner(),
      admin = await staff();
    const second = await h.make.store({ entityId: owner.entityId, name: "分店" });
    await h.clerk(owner, [owner.storeId, second.id]);
    await h.invitation(owner);
    await h.invitation(owner, { expiresAt: h.clock.now() });
    await h.prisma.entity.update({
      where: { id: owner.entityId },
      data: { storeLimitOverride: 1, memberLimitOverride: 1 },
    });
    const facts = readers();
    const before = await snapshotTables(h.prisma, TABLES);
    const clock = vi.spyOn(h.clock, "now");
    const card = await tenant(facts).adminEntityGet(admin, owner.entityId);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(card).toMatchObject({
      entityId: owner.entityId,
      owner: { merchantUserId: owner.userId },
      spendablePoints: 17,
      usage: {
        storesUsed: 2,
        storeLimit: 1,
        seatsUsed: 2,
        memberLimit: 1,
        storesOver: 1,
        seatsOver: 1,
        pendingInvitationCount: 1,
        activeMemberCount: 2,
        isOverLimit: true,
        limitReason: "inactive",
      },
      actions: ["update-quota", "close"],
    });
    expect(card.stores.map((s) => s.storeId)).toEqual([owner.storeId, second.id]);
    expect(card.stores.map((s) => [s.liveDramaCount, s.producingDramaCount, s.clerkCount])).toEqual(
      [
        [2, 3, 1],
        [2, 3, 1],
      ],
    );
    expect(card.pendingInvitations).toHaveLength(1);
    expect(facts.profiles).toHaveBeenCalledTimes(1);
    expect(facts.assets).toHaveBeenCalledTimes(1);
    expect(facts.orders).toHaveBeenCalledTimes(2);
    expect(vi.mocked(facts.profiles).mock.calls[0]?.[1].storeIds).toEqual([
      owner.storeId,
      second.id,
    ]);
    expect(vi.mocked(facts.billing).mock.calls[0]?.[0]).toBe(
      vi.mocked(facts.profiles).mock.calls[0]?.[0],
    );
    expect(vi.mocked(facts.billing).mock.calls[0]?.[0]).toBe(
      vi.mocked(facts.orders).mock.calls[1]?.[0],
    );
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
  });

  it("真实issued own范围因一店可见而允许主体全店概要；外主体和缺失均404且不调事实", async () => {
    const owner = await h.owner(),
      foreign = await h.owner(),
      admin = await staff("delivery_manager");
    const second = await h.make.store({ entityId: owner.entityId });
    await h.prisma.store.update({
      where: { id: owner.storeId },
      data: { deliveryManagerId: admin.staff.id },
    });
    const facts = readers(),
      service = tenant(facts);
    const card = await service.adminEntityGet(admin, owner.entityId);
    expect(card.stores.map((s) => s.storeId)).toContain(second.id);
    expect(card.stores[0]?.deliveryManager?.staffId).toBe(admin.staff.id);
    expect(card.actions).toEqual([]);
    vi.mocked(facts.billing).mockClear();
    for (const id of [foreign.entityId, uuidv7()]) {
      await expect(service.adminEntityGet(admin, id)).rejects.toMatchObject({ error: "NOT_FOUND" });
      await expect(
        service.adminEntityMemberList(admin, id, { includeRemoved: true }),
      ).rejects.toMatchObject({ error: "NOT_FOUND" });
    }
    expect(facts.billing).not.toHaveBeenCalled();
  });

  it("店员、角色和removed筛选按真实关系，老板始终在store筛选但服从role；排序不按门店加入时间", async () => {
    const owner = await h.owner(),
      admin = await staff();
    const second = await h.make.store({ entityId: owner.entityId });
    const first = await h.clerk(owner, [second.id]),
      other = await h.clerk(owner),
      removed = await h.clerk(owner, [second.id]);
    await h.prisma.entityMember.update({
      where: { id: removed.memberId },
      data: {
        status: "removed",
        removedAt: h.clock.now(),
        removeReason: "by_owner",
        removeActorType: "merchant",
        removeActorId: owner.userId,
        removeClient: "weapp",
      },
    });
    await h.prisma.entityMember.update({
      where: { id: owner.memberId },
      data: { createdAt: new Date(h.clock.now().getTime() + 10_000) },
    });
    const all = await list(owner.entityId, admin);
    expect(all.items.map((m) => m.memberId)).toEqual(
      [owner.memberId, first.memberId, other.memberId].sort((a, b) =>
        a === owner.memberId ? -1 : b === owner.memberId ? 1 : a.localeCompare(b),
      ),
    );
    expect(
      (await list(owner.entityId, admin, { storeId: second.id })).items.map((m) => m.memberId),
    ).toEqual([owner.memberId, first.memberId]);
    expect(
      (
        await list(owner.entityId, admin, {
          storeId: second.id,
          role: "clerk",
          includeRemoved: true,
        })
      ).items.map((m) => m.memberId),
    ).toEqual([first.memberId, removed.memberId]);
    const historical = (await list(owner.entityId, admin, { includeRemoved: true })).items.find(
      (m) => m.memberId === removed.memberId,
    );
    expect(historical).toMatchObject({
      status: "removed",
      storeIds: [second.id],
      removeReason: "by_owner",
      removedAt: h.clock.now().toISOString(),
    });
    expect(all.items[0]?.storeIds).toEqual([]);
  });

  it("跨主体或缺失store过滤整批404；同主体不可打开详情的兄弟店过滤合法", async () => {
    const owner = await h.owner(),
      foreign = await h.owner(),
      admin = await staff("delivery_manager");
    await h.prisma.store.update({
      where: { id: owner.storeId },
      data: { deliveryManagerId: admin.staff.id },
    });
    const second = await h.make.store({ entityId: owner.entityId });
    expect(
      (await list(owner.entityId, admin, { storeId: second.id })).items.map((m) => m.memberId),
    ).toEqual([owner.memberId]);
    for (const storeId of [foreign.storeId, uuidv7()])
      await expect(list(owner.entityId, admin, { storeId })).rejects.toMatchObject({
        error: "NOT_FOUND",
      });
  });

  it("真实主管group范围含组员负责的门店，伪造scope不能获得主体或成员", async () => {
    const owner = await h.owner();
    const group = await h.prisma.staffGroup.create({
      data: {
        id: uuidv7(),
        name: `后台组${uuidv7()}`,
        staffRoleKey: "delivery_manager",
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
    const lead = await h.make.staff({
      staffRoleKey: "delivery_manager",
      isLead: true,
      staffGroupId: group.id,
    });
    const colleague = await h.make.staff({
      staffRoleKey: "delivery_manager",
      staffGroupId: group.id,
    });
    await h.prisma.store.update({
      where: { id: owner.storeId },
      data: { deliveryManagerId: colleague.id },
    });
    const admin = await sampleStaffContext(h.prisma, lead.id);
    expect((await tenant(readers()).adminEntityGet(admin, owner.entityId)).entityId).toBe(
      owner.entityId,
    );
    expect((await list(owner.entityId, admin)).items[0]?.memberId).toBe(owner.memberId);
    // @ts-expect-error 结构相同也不是authz签发的opaque范围。
    const forged: StaffContext = { ...admin, scope: { kind: "all" } };
    await expect(tenant(readers()).adminEntityGet(forged, owner.entityId)).rejects.toThrow(
      TypeError,
    );
    await expect(list(owner.entityId, forged)).rejects.toThrow(TypeError);
  });

  it.each(["active", "disabled", "deleted"] as const)(
    "账号%s决定实际动作而非成员状态，称呼优先成员且只出脱敏串",
    async (status) => {
      const owner = await h.owner(),
        clerk = await h.clerk(owner),
        admin = await staff("cs", true);
      await h.prisma.entityMember.update({
        where: { id: clerk.memberId },
        data: { displayName: "成员称呼" },
      });
      const now = h.clock.now();
      await h.prisma.merchantUser.update({
        where: { id: clerk.userId },
        data: {
          status,
          displayName: "账号称呼",
          ...(status === "deleted"
            ? {
                deletedAt: now,
                displayName: null,
                phoneEnc: null,
                phoneBidx: null,
                phoneMask: null,
                phoneLast4: null,
              }
            : {}),
        },
      });
      const row = (await list(owner.entityId, admin)).items.find(
        (m) => m.memberId === clerk.memberId,
      )!;
      expect(row.user).toMatchObject({
        merchantUserId: clerk.userId,
        displayName: "成员称呼",
        status,
      });
      expect(row.actions).toEqual(
        status === "deleted" ? [] : [status === "active" ? "disable" : "enable", "force-logout"],
      );
      expect(Object.keys(row.user).sort()).toEqual([
        "displayName",
        "merchantUserId",
        "phoneMask",
        "status",
      ]);
    },
  );

  it("归档历史门店仍在概要，已关闭主体老板为空且不能执行主体动作", async () => {
    const owner = await h.owner(),
      admin = await staff();
    const second = await h.make.store({
      entityId: owner.entityId,
      lifecycle: "archived",
      archiveReason: "by_owner",
      archivedAt: h.clock.now(),
      archiveActorType: "merchant",
      archiveActorId: owner.userId,
      archiveClient: "weapp",
    });
    expect(
      (await tenant(readers()).adminEntityGet(admin, owner.entityId)).stores.map((s) => s.storeId),
    ).toContain(second.id);
    // 合法既有终态历史，不宣称本测试调用了尚未接线的后台关闭HTTP。
    await h.prisma.entity.update({
      where: { id: owner.entityId },
      data: { lifecycle: "closed", closedAt: h.clock.now() },
    });
    expect(await tenant(readers()).adminEntityGet(admin, owner.entityId)).toMatchObject({
      lifecycle: "closed",
      owner: null,
      actions: [],
    });
  });

  it("缺后台装配明确INTERNAL，旧tenant入口不受影响", async () => {
    const owner = await h.owner(),
      admin = await staff();
    await expect(tenant().adminEntityGet(admin, owner.entityId)).rejects.toMatchObject({
      error: "INTERNAL",
    });
    await expect(
      tenant().adminEntityMemberList(admin, owner.entityId, { includeRemoved: false }),
    ).rejects.toMatchObject({ error: "INTERNAL" });
    expect((await tenant().listStores({ merchantUserId: owner.userId })).viewerRole).toBe("owner");
  });

  it.each(["profiles", "stores", "members"] as const)(
    "缺%s返回Map覆盖拒绝而不是补零",
    async (kind) => {
      const owner = await h.owner(),
        admin = await staff(),
        original = readers();
      const facts: TenantAdminReadDeps =
        kind === "profiles"
          ? { ...original, profiles: async () => new Map() }
          : {
              ...original,
              assets: async (tx, input) => ({
                ...(await original.assets(tx, input)),
                [kind]: new Map(),
              }),
            };
      const service = tenant(facts);
      if (kind === "members")
        await expect(
          service.adminEntityMemberList(admin, owner.entityId, { includeRemoved: false }),
        ).rejects.toMatchObject({ error: "INTERNAL" });
      else
        await expect(service.adminEntityGet(admin, owner.entityId)).rejects.toMatchObject({
          error: "INTERNAL",
        });
    },
  );
});
