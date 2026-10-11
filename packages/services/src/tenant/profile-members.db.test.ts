import { beforeAll, describe, expect, it, vi } from "vitest";
import { createFactories, snapshotTables, useSeededDatabase } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { managementHarness, SLOW } from "./__fixtures__/member-management.js";
import type { ManagementHarness, Owner } from "./__fixtures__/member-management.js";

const db = useSeededDatabase("services", { max: 1 });
let h: ManagementHarness;
beforeAll(async () => {
  h = managementHarness(await db.prisma());
}, SLOW);
const TABLES = [
  "entity",
  "store",
  "entity_member",
  "store_member",
  "merchant_user",
  "invitation",
  "invitation_request",
  "timer",
  "audit_log",
  "status_transition",
  "outbox_event",
  "idempotency_record",
  "param_value",
  "store_profile",
];
function brief(owner: Owner, storeId = owner.storeId, now = h.clock.now()) {
  return h.tx.run((tx) =>
    h.tenant.readStoreMembersBrief(tx, {
      entityId: owner.entityId,
      storeId,
      now,
    }),
  );
}

describe("建档成员摘要：同事务单语句真实事实", { timeout: SLOW }, () => {
  it.each([null, "成员老板称呼"])(
    "老板只读成员称呼 %s，不回落账号且不占店员",
    async (displayName) => {
      const owner = await h.owner();
      await h.prisma.entityMember.update({ where: { id: owner.memberId }, data: { displayName } });
      await h.prisma.merchantUser.update({
        where: { id: owner.userId },
        data: { displayName: "不可回落账号名" },
      });
      const before = await snapshotTables(h.prisma, TABLES);
      expect(await brief(owner)).toEqual({
        ownerDisplayName: displayName,
        clerkCount: 0,
        pendingInvitationCount: 0,
        preview: [{ displayName, role: "owner" }],
      });
      expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
    },
  );

  it("老板优先，店员加入时间及ID稳定排序截三，不受门店加入时间影响", async () => {
    const owner = await h.owner();
    const clerks: Awaited<ReturnType<ManagementHarness["clerk"]>>[] = [];
    for (let i = 0; i < 4; i++) clerks.push(await h.clerk(owner));
    const tied = clerks.slice(0, 2).sort((a, b) => a.memberId.localeCompare(b.memberId));
    await h.prisma.entityMember.update({
      where: { id: owner.memberId },
      data: { displayName: "老板", createdAt: new Date(h.clock.now().getTime() + 9_000) },
    });
    for (const [i, clerk] of clerks.entries()) {
      await h.prisma.entityMember.update({
        where: { id: clerk.memberId },
        data: {
          displayName: `店员${i}`,
          createdAt: new Date(h.clock.now().getTime() + (i < 2 ? 0 : 1_000)),
        },
      });
      await h.prisma.storeMember.update({
        where: {
          entityMemberId_storeId: {
            entityMemberId: clerk.memberId,
            storeId: owner.storeId,
          },
        },
        data: { createdAt: new Date(h.clock.now().getTime() - i * 1_000) },
      });
    }
    const expected = {
      ownerDisplayName: "老板",
      clerkCount: 4,
      pendingInvitationCount: 0,
      preview: [
        { displayName: "老板", role: "owner" },
        ...tied.map((x) => ({
          displayName: `店员${clerks.indexOf(x)}`,
          role: "clerk",
        })),
      ],
    };
    for (let i = 0; i < 3; i++) expect(await brief(owner)).toEqual(expected);
    expect(await h.prisma.storeMember.count({ where: { entityMemberId: owner.memberId } })).toBe(0);
  });

  it("本店范围去重、异店及异主体隔离；合法移除历史关系不计", async () => {
    const owner = await h.owner(),
      foreign = await h.owner();
    const second = await h.make.store({ entityId: owner.entityId });
    const both = await h.clerk(owner, [owner.storeId, second.id]);
    await h.clerk(owner, [second.id]);
    await h.clerk(foreign);
    const removed = await h.clerk(owner);
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
      where: { id: both.memberId },
      data: { displayName: null },
    });
    expect(await brief(owner)).toMatchObject({ clerkCount: 1 });
    expect((await brief(owner))!.preview).toContainEqual({ displayName: null, role: "clerk" });
    expect(await brief(owner, second.id)).toMatchObject({ clerkCount: 2 });
    expect(await brief(foreign)).toMatchObject({ clerkCount: 1 });
    expect(await brief(owner, foreign.storeId)).toBeNull();
    expect(await h.prisma.storeMember.count({ where: { entityMemberId: removed.memberId } })).toBe(
      1,
    );
  });

  it.each([-1, 0, 1])("pending 到期边界 now%dms，读口不迁移状态", async (offset) => {
    const owner = await h.owner();
    const row = await h.invitation(owner, {
      expiresAt: new Date(h.clock.now().getTime() + offset),
    });
    const before = await snapshotTables(h.prisma, TABLES);
    expect(await brief(owner)).toMatchObject({ pendingInvitationCount: offset > 0 ? 1 : 0 });
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
    expect((await h.prisma.invitation.findUniqueOrThrow({ where: { id: row.id } })).status).toBe(
      "pending",
    );
  });

  it("shared/unshared 都占额，三个终态和其他范围不占额", async () => {
    const owner = await h.owner(),
      foreign = await h.owner();
    const second = await h.make.store({ entityId: owner.entityId });
    const accepted = await h.clerk(owner);
    await h.invitation(owner);
    await h.invitation(owner, { sharedAt: h.clock.now() });
    await h.invitation(owner, { status: "expired" });
    await h.invitation(owner, {
      status: "revoked",
      revokedAt: h.clock.now(),
      revokeActorType: "merchant",
      revokeActorId: owner.userId,
      revokeClient: "weapp",
      revokeReason: "by_owner",
    });
    await h.invitation(owner, {
      status: "accepted",
      acceptedAt: h.clock.now(),
      acceptedByUserId: accepted.userId,
      acceptedMemberId: accepted.memberId,
    });
    await h.invitation({ ...owner, storeId: second.id });
    await h.invitation(foreign);
    const before = await snapshotTables(h.prisma, TABLES);
    expect(await brief(owner)).toMatchObject({ pendingInvitationCount: 2, clerkCount: 1 });
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
  });

  it("合法by_owner归档仍读当前成员事实，不把历史关系当恢复", async () => {
    const owner = await h.owner();
    await h.prisma.entityMember.update({
      where: { id: owner.memberId },
      data: { displayName: null },
    });
    await h.prisma.store.update({
      where: { id: owner.storeId },
      data: {
        lifecycle: "archived",
        archivedAt: h.clock.now(),
        archiveReason: "by_owner",
        archiveActorType: "system",
      },
    });
    const before = await snapshotTables(h.prisma, TABLES);
    expect(await brief(owner)).toEqual({
      ownerDisplayName: null,
      clerkCount: 0,
      pendingInvitationCount: 0,
      preview: [{ displayName: null, role: "owner" }],
    });
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
  });

  it.each(["missing", "foreign", "draft_deleted", "entity_closed", "entity_abandoned", "closed"])(
    "%s 范围返回null，不泄露真实成员",
    async (mode) => {
      const owner = await h.owner();
      await h.clerk(owner);
      let storeId = owner.storeId;
      if (mode === "missing") storeId = uuidv7();
      if (mode === "foreign") storeId = (await h.owner()).storeId;
      if (mode === "draft_deleted" || mode === "entity_closed" || mode === "entity_abandoned")
        await h.prisma.store.update({
          where: { id: storeId },
          data: {
            lifecycle: "archived",
            archivedAt: h.clock.now(),
            archiveReason: mode,
            archiveActorType: "system",
          },
        });
      if (mode === "closed")
        await h.prisma.entity.update({
          where: { id: owner.entityId },
          data: {
            lifecycle: "closed",
            closedAt: h.clock.now(),
          },
        });
      expect(await brief(owner, storeId)).toBeNull();
    },
  );

  it("单一tagged SQL，无写语句或N+1，数据库异常原样传播", async () => {
    const owner = await h.owner();
    await h.tx.run(async (tx) => {
      const query = vi.spyOn(tx, "$queryRaw");
      await h.tenant.readStoreMembersBrief(tx, { ...owner, now: h.clock.now() });
      expect(query).toHaveBeenCalledTimes(1);
      const sql = query.mock.calls[0]![0];
      expect(Array.isArray(sql)).toBe(true);
      if (!Array.isArray(sql)) throw new Error("读口未使用 tagged SQL");
      expect(sql.join(" ")).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
      query.mockRestore();
    });
    const failure = new Error("真实读口失败不得默认零");
    await expect(
      h.tx.run(async (tx) => {
        vi.spyOn(tx, "$queryRaw").mockRejectedValueOnce(failure);
        return h.tenant.readStoreMembersBrief(tx, { ...owner, now: h.clock.now() });
      }),
    ).rejects.toBe(failure);
  });

  it("调用方未提交成员与邀请可见，外层回滚完整恢复，随后提交才改变摘要", async () => {
    const owner = await h.owner();
    const clerk = await h.clerk(owner);
    const invitation = await h.invitation(owner);
    const before = await snapshotTables(h.prisma, TABLES);
    const original = await brief(owner);
    const failure = new Error("调用方外层失败");
    await expect(
      h.tx.run(async (tx) => {
        const make = createFactories({ db: tx, clock: h.clock });
        const member = await make.entityMember({ entityId: owner.entityId, displayName: "未提交" });
        await make.storeMember({
          entityMemberId: member.id,
          storeId: owner.storeId,
          addedByMemberId: owner.memberId,
        });
        // 合法历史行在同一调用方事务内追加，不借第二连接读取未提交事实。
        await tx.invitation.create({
          data: {
            ...invitation,
            id: uuidv7(),
            clientRequestId: uuidv7(),
            tokenHash: Buffer.alloc(32, 7),
          },
        });
        await tx.storeMember.delete({
          where: {
            entityMemberId_storeId: { entityMemberId: clerk.memberId, storeId: owner.storeId },
          },
        });
        expect(
          await h.tenant.readStoreMembersBrief(tx, { ...owner, now: h.clock.now() }),
        ).toMatchObject({ clerkCount: 1, pendingInvitationCount: 2 });
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
    expect(await brief(owner)).toEqual(original);
    await h.tx.run((tx) =>
      tx.entityMember.update({ where: { id: clerk.memberId }, data: { displayName: "已提交" } }),
    );
    expect((await brief(owner))!.preview).toContainEqual({ displayName: "已提交", role: "clerk" });
  });
});
