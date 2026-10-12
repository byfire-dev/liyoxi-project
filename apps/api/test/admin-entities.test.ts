import { beforeAll, describe, expect, it } from "vitest";
import { EntityCardSchema, EntityMemberListSchema, staffRoleDefault } from "@liyoxi/contract";
import { runSeed, uuidv7 } from "@liyoxi/services";
import { createFactories, signInAsStaff, snapshotTables } from "@liyoxi/services/testing";
import type { SignedInStaff } from "@liyoxi/services/testing";
import { HANDLERS } from "../src/routes/index.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";

const handle = useTestApi(),
  SLOW = 120_000;
let api: TestApi, prisma: Awaited<ReturnType<typeof handle.db.prisma>>;
let make: ReturnType<typeof createFactories>;
let admin: SignedInStaff, manager: SignedInStaff, cs: SignedInStaff;
let peer = 0;
beforeAll(async () => {
  api = await handle.start();
  prisma = await handle.db.prisma();
  await runSeed({ tx: api.runtime.tx, clock: api.clock });
  make = createFactories({ db: prisma, clock: api.clock });
  admin = await signInAsStaff(prisma, { roleKey: "super_admin" });
  manager = await signInAsStaff(prisma, { roleKey: "delivery_manager" });
  cs = await signInAsStaff(prisma, { roleKey: "cs", isLead: true });
}, SLOW);
const TABLES = [
  "entity",
  "store",
  "entity_member",
  "store_member",
  "invitation",
  "billing_account",
  "store_profile",
  "store_asset",
  "audit_log",
  "outbox_event",
  "status_transition",
  "timer",
  "idempotency_record",
];
function request(path: string, caller: SignedInStaff | null = admin) {
  return api.request(`/api/v1/admin/entities/${path}`, {
    headers: caller?.headers ?? {},
    peer: `198.19.47.${++peer}`,
  });
}
async function data(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { data: unknown }).data;
}
async function error(response: Response, status: number, symbol: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  expect(await response.json()).toMatchObject({ error: symbol });
}
async function world(phone?: string) {
  const w = await make.merchant({ verified: true });
  const second = await make.store({ entityId: w.entity.id });
  const user = await make.merchantUser(phone === undefined ? {} : { phone });
  const clerk = await make.entityMember({
    entityId: w.entity.id,
    merchantUserId: user.id,
    role: "clerk",
    displayName: "店员备注",
  });
  await make.storeMember({
    entityMemberId: clerk.id,
    entityId: w.entity.id,
    storeId: second.id,
    addedByMemberId: w.owner.id,
  });
  return { ...w, second, clerk, clerkUser: user };
}
async function invitation(w: Awaited<ReturnType<typeof world>>, delta: number) {
  const now = api.clock.now();
  return prisma.invitation.create({
    data: {
      id: uuidv7(),
      entityId: w.entity.id,
      storeId: w.second.id,
      role: "clerk",
      inviterMemberId: w.owner.id,
      tokenHash: Buffer.from(uuidv7().replaceAll("-", "").repeat(2), "hex"),
      tokenEnc: null,
      status: "pending",
      clientRequestId: uuidv7(),
      createdAt: new Date(now.getTime() - 60_000),
      updatedAt: now,
      expiresAt: new Date(now.getTime() + delta),
      remarkName: "候选店员",
    },
  });
}

describe("后台主体两个真实GET", { timeout: SLOW }, () => {
  it("两条实际挂载，完整DTO和主体quota/归因/脱敏/店员统计；GET没有业务副作用", async () => {
    for (const operationId of ["admin.entity.get", "admin.entity.member.list"])
      expect(HANDLERS.some((h) => h.route.operationId === operationId)).toBe(true);
    const w = await world("13900112233");
    const pending = await invitation(w, 60_000);
    await invitation(w, 0);
    await invitation(w, -1);
    const before = await snapshotTables(prisma, TABLES);
    const card = EntityCardSchema.parse(await data(await request(w.entity.id)));
    expect(card).toMatchObject({
      entityId: w.entity.id,
      usccMask: w.entity.usccMask,
      legalRepNameMask: null,
      owner: {
        merchantUserId: w.user.id,
        displayName: w.owner.displayName,
        phoneMask: w.user.phoneMask,
      },
      subscription: { status: "none", plan: null, latestPaymentOrder: null },
      usage: {
        storesUsed: 2,
        seatsUsed: 2,
        pendingInvitationCount: 1,
        activeMemberCount: 2,
        limitReason: "inactive",
      },
      spendablePoints: 0,
      actions: ["update-quota", "close"],
    });
    expect(card.stores.map((s) => [s.storeId, s.clerkCount])).toEqual([
      [w.store.id, 0],
      [w.second.id, 1],
    ]);
    expect(card.pendingInvitations.map((i) => i.invitationId)).toEqual([pending.id]);
    const members = EntityMemberListSchema.parse(
      await data(await request(`${w.entity.id}/members`)),
    );
    expect(members.items.map((m) => m.memberId)).toEqual([w.owner.id, w.clerk.id]);
    expect(members.items[1]).toMatchObject({
      user: { displayName: "店员备注", phoneMask: "139****2233" },
      storeIds: [w.second.id],
      uploadedAssetCount: 0,
      adoptedAssetCount: 0,
    });
    expect(JSON.stringify(members)).not.toContain("13900112233");
    expect(await snapshotTables(prisma, TABLES)).toEqual(before);
  });

  it("真实own scope只负责一店仍返回正式兄弟概要，原兄弟详情404；跨主体/不存在同态", async () => {
    const w = await world(),
      foreign = await make.merchant();
    await prisma.store.update({
      where: { id: w.store.id },
      data: { deliveryManagerId: manager.staff.id },
    });
    const card = EntityCardSchema.parse(await data(await request(w.entity.id, manager)));
    expect(card.stores.map((s) => s.storeId)).toEqual([w.store.id, w.second.id]);
    expect(card.actions).toEqual([]);
    const detail = await api.request(`/api/v1/admin/stores/${w.second.id}`, {
      headers: manager.headers,
      peer: `198.19.48.${++peer}`,
    });
    await error(detail, 404, "NOT_FOUND");
    for (const id of [foreign.entity.id, uuidv7()]) {
      await error(await request(id, manager), 404, "NOT_FOUND");
      await error(await request(`${id}/members`, manager), 404, "NOT_FOUND");
    }
    const members = EntityMemberListSchema.parse(
      await data(await request(`${w.entity.id}/members?storeId=${w.second.id}`, manager)),
    );
    expect(members.items.map((m) => m.memberId)).toEqual([w.owner.id, w.clerk.id]);
  });

  it("成员store/role/includeRemoved严格筛选，owner范围隐含全店，移除不重建旧范围", async () => {
    const w = await world();
    await prisma.entityMember.update({
      where: { id: w.clerk.id },
      data: {
        status: "removed",
        removedAt: api.clock.now(),
        removeReason: "by_owner",
        removeActorType: "merchant",
        removeActorId: w.user.id,
        removeClient: "weapp",
      },
    });
    await prisma.storeMember.deleteMany({ where: { entityMemberId: w.clerk.id } });
    expect(
      EntityMemberListSchema.parse(await data(await request(`${w.entity.id}/members`))).items.map(
        (m) => m.memberId,
      ),
    ).toEqual([w.owner.id]);
    const removed = EntityMemberListSchema.parse(
      await data(await request(`${w.entity.id}/members?includeRemoved=true&role=clerk`)),
    );
    expect(removed.items).toHaveLength(1);
    expect(removed.items[0]).toMatchObject({
      memberId: w.clerk.id,
      status: "removed",
      storeIds: [],
      removeReason: "by_owner",
    });
    const ownerOnly = EntityMemberListSchema.parse(
      await data(await request(`${w.entity.id}/members?storeId=${w.store.id}&role=owner`)),
    );
    expect(ownerOnly.items.map((m) => m.memberId)).toEqual([w.owner.id]);
    const foreign = await make.merchant();
    await error(
      await request(`${w.entity.id}/members?storeId=${foreign.store.id}`),
      404,
      "NOT_FOUND",
    );
  });

  it.each(["page=1", "includeRemoved=1", "role=admin", "storeId=not-an-id", "scope=all"])(
    "非法query %s在HTTP拒绝，不默默忽略",
    async (query) => {
      const w = await world(),
        before = await snapshotTables(prisma, TABLES);
      await error(await request(`${w.entity.id}/members?${query}`), 400, "VALIDATION_FAILED");
      expect(await snapshotTables(prisma, TABLES)).toEqual(before);
    },
  );

  it("动作按真实权限及账号状态，读取无需再验证且禁用老板仍可供后台查看", async () => {
    const w = await world();
    await prisma.merchantUser.update({ where: { id: w.user.id }, data: { status: "disabled" } });
    const card = EntityCardSchema.parse(await data(await request(w.entity.id, cs)));
    expect(card.owner?.status).toBe("disabled");
    expect(card.actions).toEqual([]);
    const members = EntityMemberListSchema.parse(
      await data(await request(`${w.entity.id}/members`, cs)),
    );
    expect(members.items[0]?.actions).toEqual(["enable", "force-logout"]);
    expect(members.items[1]?.actions).toEqual(["disable", "force-logout"]);
  });

  it.each(["", "/members"])("匿名请求%s不获主体信息，非法ID400", async (suffix) => {
    const w = await world();
    await error(await request(`${w.entity.id}${suffix}`, null), 401, "AUTH_REQUIRED");
    await error(await request(`bad-id${suffix}`), 400, "VALIDATION_FAILED");
  });

  it("模块none真实员工403，不能以scope参数或permission布尔替代鉴权", async () => {
    const w = await world(),
      role = staffRoleDefault("content_ops")!;
    await prisma.staffRole.update({
      where: { key: "content_ops" },
      data: { moduleLevels: { ...role.moduleLevels, merchant: "n" } },
    });
    try {
      const content = await signInAsStaff(prisma, { roleKey: "content_ops" });
      for (const suffix of ["", "/members"])
        await error(await request(`${w.entity.id}${suffix}`, content), 403, "PERMISSION_DENIED");
    } finally {
      await prisma.staffRole.update({
        where: { key: "content_ops" },
        data: { moduleLevels: { ...role.moduleLevels } },
      });
    }
  });
});
