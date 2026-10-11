import { createHash } from "node:crypto";
import { createIdentityContext, uuidv7 } from "@liyoxi/services";
import { createFactories, snapshotTables } from "@liyoxi/services/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
let api: TestApi;
beforeAll(async () => {
  api = await handle.start();
  await seedUserAgreements(handle, api);
}, 180_000);
const TABLES = [
  "entity",
  "store",
  "entity_member",
  "store_member",
  "invitation",
  "invitation_request",
  "store_profile",
  "store_profile_media",
  "store_service_item",
  "qualification_submission",
  "qualification_doc",
  "timer",
  "audit_log",
  "outbox_event",
  "status_transition",
  "idempotency_record",
];
type Members = {
  ownerDisplayName: string | null;
  clerkCount: number;
  pendingInvitationCount?: number;
  preview: { displayName: string | null; role: string }[];
};
async function get(headers: Record<string, string>) {
  const response = await api.request("/api/v1/m/store-profile", { headers });
  return {
    response,
    body: (await response.json()) as {
      error?: string;
      data?: { viewerRole: string; members: Members; [key: string]: unknown };
    },
  };
}
async function world() {
  const owner = await signInAsMerchant(api),
    clerk = await signInAsMerchant(api);
  const tenant = merchantServicesOf(api.runtime).tenant;
  const created = await tenant.createEntity(
    createIdentityContext({
      actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
    }),
  );
  const prisma = await handle.db.prisma(),
    make = createFactories({ db: prisma, clock: api.clock });
  const second = await make.store({ entityId: created.entityId });
  const member = await make.entityMember({
    entityId: created.entityId,
    merchantUserId: clerk.merchantUserId,
    invitedByMemberId: created.memberId,
    lastStoreId: created.storeId,
    displayName: null,
  });
  await make.storeMember({
    entityMemberId: member.id,
    storeId: created.storeId,
    addedByMemberId: created.memberId,
  });
  await prisma.entityMember.update({
    where: { id: created.memberId },
    data: { displayName: "成员老板名" },
  });
  await prisma.merchantUser.update({
    where: { id: owner.merchantUserId },
    data: { displayName: "不可回落账号名" },
  });
  async function invitation(expiresAt: Date, storeId = created.storeId) {
    const id = uuidv7();
    return prisma.invitation.create({
      data: {
        id,
        entityId: created.entityId,
        storeId,
        inviterMemberId: created.memberId,
        role: "clerk",
        status: "pending",
        clientRequestId: uuidv7(),
        tokenHash: createHash("sha256").update(id).digest(),
        tokenEnc: null,
        remarkName: "不可泄漏邀请备注",
        createdAt: new Date(api.clock.now().getTime() - 1_000),
        updatedAt: api.clock.now(),
        expiresAt,
      },
    });
  }
  return { owner, clerk, member, second, prisma, make, invitation, ...created };
}

describe("建档首页成员摘要真实HTTP", { timeout: 120_000 }, () => {
  it("老板真实四项、当前门店隔离与GET零业务写入", async () => {
    const w = await world();
    await w.invitation(new Date(api.clock.now().getTime() + 1_000));
    await w.invitation(new Date(api.clock.now().getTime() + 1_000), w.second.id);
    const before = await snapshotTables(w.prisma, TABLES);
    const result = await get(w.owner.withStore(w.storeId));
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(result.body.data!.members).toEqual({
      ownerDisplayName: "成员老板名",
      clerkCount: 1,
      pendingInvitationCount: 1,
      preview: [
        { displayName: "成员老板名", role: "owner" },
        { displayName: null, role: "clerk" },
      ],
    });
    expect(Object.keys(result.body.data!.members).sort()).toEqual([
      "clerkCount",
      "ownerDisplayName",
      "pendingInvitationCount",
      "preview",
    ]);
    expect((await get(w.owner.withStore(w.second.id))).body.data!.members).toEqual({
      ownerDisplayName: "成员老板名",
      clerkCount: 0,
      pendingInvitationCount: 1,
      preview: [{ displayName: "成员老板名", role: "owner" }],
    });
    expect(await snapshotTables(w.prisma, TABLES)).toEqual(before);
    expect(await w.prisma.storeProfile.count({ where: { entityId: w.entityId } })).toBe(0);
  });

  it.each([null, "备注老板"])(
    "老板成员名%s不回落账号；店员只三键/预览只两键",
    async (displayName) => {
      const w = await world();
      await w.prisma.entityMember.update({ where: { id: w.memberId }, data: { displayName } });
      const invitation = await w.invitation(new Date(api.clock.now().getTime() + 1_000));
      const before = await snapshotTables(w.prisma, TABLES);
      const result = await get(w.clerk.withStore(w.storeId));
      expect(result.response.status, JSON.stringify(result.body)).toBe(200);
      expect(result.response.headers.get("Cache-Control")).toBe("no-store");
      expect(result.body.data!.viewerRole).toBe("clerk");
      expect(result.body.data!.members).toEqual({
        ownerDisplayName: displayName,
        clerkCount: 1,
        preview: [
          { displayName, role: "owner" },
          { displayName: null, role: "clerk" },
        ],
      });
      expect(Object.keys(result.body.data!.members).sort()).toEqual([
        "clerkCount",
        "ownerDisplayName",
        "preview",
      ]);
      for (const item of result.body.data!.members.preview)
        expect(Object.keys(item).sort()).toEqual(["displayName", "role"]);
      for (const key of ["entityName", "ads", "members.pendingInvitationCount"])
        expect(result.body.data).not.toHaveProperty(key);
      const json = JSON.stringify(result.body.data!.members);
      for (const privateValue of [
        w.owner.phone,
        w.clerk.phone,
        invitation.id,
        w.member.id,
        w.owner.merchantUserId,
        w.clerk.merchantUserId,
        "不可泄漏邀请备注",
        "不可回落账号名",
      ])
        expect(json).not.toContain(privateValue);
      expect(await snapshotTables(w.prisma, TABLES)).toEqual(before);
    },
  );

  it("真实公开archive后老板仍可读档案，摘要反映级联且GET零副作用", async () => {
    const w = await world();
    const invitation = await w.invitation(new Date(api.clock.now().getTime() + 1_000));
    const archived = await api.request(`/api/v1/m/stores/${w.storeId}/archive`, {
      method: "POST",
      headers: { ...w.owner.withStore(w.second.id), "Idempotency-Key": uuidv7() },
    });
    expect(archived.status, await archived.clone().text()).toBe(200);
    expect(await w.prisma.store.findUniqueOrThrow({ where: { id: w.storeId } })).toMatchObject({
      lifecycle: "archived",
      archiveReason: "by_owner",
    });
    expect(
      (await w.prisma.entityMember.findUniqueOrThrow({ where: { id: w.member.id } })).status,
    ).toBe("removed");
    expect(await w.prisma.storeMember.count({ where: { storeId: w.storeId } })).toBe(0);
    expect(
      (await w.prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status,
    ).toBe("revoked");
    const before = await snapshotTables(w.prisma, TABLES);
    const result = await get(w.owner.withStore(w.storeId));
    expect(result.response.status, JSON.stringify(result.body)).toBe(200);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect(result.body.data!.viewerRole).toBe("owner");
    expect(result.body.data!.members).toEqual({
      ownerDisplayName: "成员老板名",
      clerkCount: 0,
      pendingInvitationCount: 0,
      preview: [{ displayName: "成员老板名", role: "owner" }],
    });
    expect(await snapshotTables(w.prisma, TABLES)).toEqual(before);
  });

  it.each([-1, 0, 1])("真实pending邀请到期%dms只影响占额，不修复状态", async (offset) => {
    const w = await world();
    const invitation = await w.invitation(new Date(api.clock.now().getTime() + offset));
    const before = await snapshotTables(w.prisma, TABLES);
    const result = await get(w.owner.withStore(w.storeId));
    expect(result.response.status).toBe(200);
    expect(result.body.data!.members.pendingInvitationCount).toBe(offset > 0 ? 1 : 0);
    expect(
      (await w.prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status,
    ).toBe("pending");
    expect(await snapshotTables(w.prisma, TABLES)).toEqual(before);
  });

  it.each(["remove", "range"] as const)(
    "真实%s写入后老板数立即更新，店员下一GET沿原中间件失权",
    async (mode) => {
      const w = await world();
      const result = await api.request(
        `/api/v1/m/members/${w.member.id}${mode === "remove" ? "/remove" : ""}`,
        {
          method: mode === "remove" ? "POST" : "PATCH",
          headers: { ...w.owner.withStore(w.storeId), "Idempotency-Key": uuidv7() },
          ...(mode === "range" ? { json: { storeIds: [w.second.id] } } : {}),
        },
      );
      expect(result.status, await result.clone().text()).toBe(200);
      const before = await snapshotTables(w.prisma, TABLES);
      const denied = await get(w.clerk.withStore(w.storeId));
      expect(denied.response.status).toBe(403);
      expect(denied.body.error).toBe("NOT_A_MEMBER");
      expect((await get(w.owner.withStore(w.storeId))).body.data!.members).toMatchObject({
        clerkCount: 0,
        preview: [{ displayName: "成员老板名", role: "owner" }],
      });
      if (mode === "range")
        expect((await get(w.clerk.withStore(w.second.id))).body.data!.members.clerkCount).toBe(1);
      expect(await snapshotTables(w.prisma, TABLES)).toEqual(before);
    },
  );

  it.each(["guest", "unbound", "foreign", "no_store", "removed", "archived_clerk"] as const)(
    "%s保留原权限边界，拒绝请求业务零写",
    async (mode) => {
      const w = await world();
      const outsider = mode === "unbound" ? await signInAsMerchant(api) : null;
      const foreign = mode === "foreign" ? await w.make.store() : null;
      if (mode === "removed")
        await merchantServicesOf(api.runtime).tenant.removeMember(
          createIdentityContext({
            actor: { type: "merchant", id: w.owner.merchantUserId, client: "weapp" },
            entityId: w.entityId,
            storeId: w.storeId,
          }),
          { memberId: w.member.id },
        );
      if (mode === "archived_clerk") {
        const result = await api.request(`/api/v1/m/stores/${w.storeId}/archive`, {
          method: "POST",
          headers: { ...w.owner.withStore(w.second.id), "Idempotency-Key": uuidv7() },
        });
        expect(result.status, await result.clone().text()).toBe(200);
      }
      const headers =
        mode === "guest"
          ? {}
          : mode === "no_store"
            ? w.owner.headers
            : mode === "unbound"
              ? outsider!.withStore(w.storeId)
              : mode === "foreign"
                ? w.owner.withStore(foreign!.id)
                : w.clerk.withStore(w.storeId);
      const before = await snapshotTables(w.prisma, TABLES);
      const result = await get(headers);
      expect(result.response.status).toBe(mode === "guest" ? 401 : 403);
      expect(result.body.error).toBe(mode === "guest" ? "AUTH_REQUIRED" : "NOT_A_MEMBER");
      expect(await snapshotTables(w.prisma, TABLES)).toEqual(before);
    },
  );
});
