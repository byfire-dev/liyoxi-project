import { describe, expect, it } from "vitest";
import {
  MemberItemForClerkSchema,
  MemberItemSchema,
  MemberListSchema,
  MemberUpdateBodySchema,
} from "./tenant.schemas.js";
import { mMemberList, mMemberUpdate } from "./members.js";

const id = "018fabcd-0000-7000-8000-000000000001";
const brief = {
  memberId: id,
  role: "clerk",
  displayName: null,
  joinedAt: "2026-10-11T00:00:00.000Z",
  isSelf: false,
};
const full = {
  ...brief,
  phoneMask: "138****1234",
  storeScope: "listed",
  stores: [{ storeId: id, name: null, lifecycle: "active", qualificationStatus: "unsubmitted" }],
  uploadCount: 2,
  adoptedCount: 1,
  actions: ["update", "remove"],
};
const seats = {
  seatsUsed: 1,
  memberLimit: null,
  pendingInvitationCount: 0,
  includesUnsharedDraft: false,
  seatsOver: 0,
  limitReason: "inactive",
  planName: null,
};

describe("formal member DTOs and role projection", () => {
  it("strict clerk DTO has exactly five fields and owner-only values cannot pass its branch", () => {
    expect(MemberItemForClerkSchema.parse(brief)).toEqual(brief);
    const list = { viewerRole: "clerk", items: [brief] };
    expect(MemberListSchema.parse(list)).toEqual(list);
    expect(Object.keys(MemberItemForClerkSchema.parse(brief)).sort()).toEqual([
      "displayName",
      "isSelf",
      "joinedAt",
      "memberId",
      "role",
    ]);
    for (const patch of [{ phoneMask: null }, { stores: [] }, { uploadCount: 0 }, { actions: [] }])
      expect(MemberItemForClerkSchema.safeParse({ ...brief, ...patch }).success).toBe(false);
    for (const patch of [{ seats }, { pendingInvitations: [] }])
      expect(MemberListSchema.safeParse({ ...list, ...patch }).success).toBe(false);
    expect(MemberListSchema.safeParse({ ...list, items: [full] }).success).toBe(false);
  });
  it("owner DTO retains the complete member, invitation and actual seat fields", () => {
    const invitation = {
      invitationId: id,
      role: "clerk",
      remarkName: null,
      isPhoneRestricted: false,
      isShared: false,
      createdAt: brief.joinedAt,
      expiresAt: "2026-10-18T00:00:00.000Z",
      actions: ["revoke"],
    };
    const value = { viewerRole: "owner", items: [full], pendingInvitations: [invitation], seats };
    expect(MemberItemSchema.parse(full)).toEqual(full);
    expect(MemberListSchema.parse(value)).toEqual(value);
    for (const key of Object.keys(full)) {
      const missing: Record<string, unknown> = { ...full };
      delete missing[key];
      expect(MemberItemSchema.safeParse(missing).success).toBe(false);
    }
    expect(MemberListSchema.safeParse({ ...value, pendingInvitations: undefined }).success).toBe(
      false,
    );
    expect(MemberListSchema.safeParse({ ...value, seats: undefined }).success).toBe(false);
    expect(MemberItemSchema.safeParse({ ...full, mobile: "secret" }).success).toBe(false);
    expect(MemberItemSchema.safeParse({ ...full, uploadCount: -1 }).success).toBe(false);
    expect(MemberItemSchema.safeParse({ ...full, adoptedCount: 0.5 }).success).toBe(false);
  });
  it("response role/lifecycle remain open while actions, scopes and instant shape stay exact", () => {
    expect(
      MemberItemSchema.safeParse({
        ...full,
        role: "future_role",
        stores: [{ ...full.stores[0], lifecycle: "future_state" }],
      }).success,
    ).toBe(true);
    for (const patch of [
      { storeScope: "all_stores" },
      { actions: ["promote"] },
      { joinedAt: "2026-10-11T00:00:00Z" },
    ])
      expect(MemberItemSchema.safeParse({ ...full, ...patch }).success).toBe(false);
  });
  it.each([
    id.toUpperCase(),
    id.replace("abcd", "aBcd"),
    "018fabcd-0000-4000-8000-000000000001",
    "bad",
  ])("rejects noncanonical ID %s at both input and DTO boundaries", (bad) => {
    expect(MemberUpdateBodySchema.safeParse({ storeIds: [bad] }).success).toBe(false);
    expect(MemberItemForClerkSchema.safeParse({ ...brief, memberId: bad }).success).toBe(false);
  });
  it("full replacement requires distinct nonempty canonical storeIds and rejects invented lockVersion", () => {
    expect(MemberUpdateBodySchema.parse({ storeIds: [id] })).toEqual({ storeIds: [id] });
    for (const value of [
      {},
      { storeIds: [] },
      { storeIds: [id, id] },
      { storeIds: [id], lockVersion: 0 },
      { storeIds: null },
    ])
      expect(MemberUpdateBodySchema.safeParse(value).success).toBe(false);
    expect(MemberUpdateBodySchema.safeParse({ storeIds: [] }).error?.issues[0]?.message).toBe(
      "请至少保留一家门店；如不再合作，请移除成员",
    );
  });
  it("existing route IDs preserve member auth, trimmed/none visibility and required mutation idem", () => {
    expect(mMemberList).toMatchObject({
      method: "get",
      path: "/m/members",
      operationId: "m.member.list",
      "x-auth": "member",
      "x-capability": "member.list",
      "x-clerk-view": "trimmed",
    });
    expect(mMemberUpdate).toMatchObject({
      method: "patch",
      path: "/m/members/{memberId}",
      operationId: "m.member.update",
      "x-auth": "member",
      "x-capability": "member.manage",
      "x-clerk-view": "none",
      "x-idempotent": "required",
    });
  });
});
