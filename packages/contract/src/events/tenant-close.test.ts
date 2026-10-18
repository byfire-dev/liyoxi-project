import { expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "./index.js";

const id = "018f0000-0000-7000-8000-000000000001";
const bodies = {
  "entity.closed": {
    v: 1,
    entityId: id,
    closedBy: "staff_close",
    fromState: "active",
    toState: "closed",
    transition: "entity.close",
  },
  "store.archived": {
    v: 1,
    storeId: id,
    entityId: id,
    archiveReason: "entity_closed",
    fromState: "active",
    toState: "archived",
    transition: "store.archive_by_entity",
  },
  "entity_member.removed": {
    v: 1,
    entityMemberId: id,
    entityId: id,
    merchantUserId: id,
    role: "owner",
    removeReason: "entity_closed",
    fromState: "active",
    toState: "removed",
    transition: "entity_member.cascade_remove",
  },
  "invitation.revoked": {
    v: 1,
    invitationId: id,
    entityId: id,
    storeId: id,
    fromState: "pending",
    toState: "revoked",
    transition: "invitation.revoke",
  },
} as const;

it.each(Object.keys(bodies) as (keyof typeof bodies)[])("%s 接受正式关闭载荷", (name) => {
  expect(EVENT_PAYLOAD_SCHEMAS[name].parse(bodies[name])).toEqual(bodies[name]);
});
it.each(Object.keys(bodies) as (keyof typeof bodies)[])(
  "%s 严格拒绝未知字段、坏ID和迁移键",
  (name) => {
    for (const patch of [
      { surprise: true },
      { v: 2 },
      { entityId: "bad" },
      { fromState: null },
      { toState: "active" },
      { transition: "other" },
    ])
      expect(EVENT_PAYLOAD_SCHEMAS[name].safeParse({ ...bodies[name], ...patch }).success).toBe(
        false,
      );
  },
);
it("来源、原因和移除前角色只能取正式枚举", () => {
  for (const [name, patch] of [
    ["entity.closed", { closedBy: "system" }],
    ["store.archived", { archiveReason: "unknown" }],
    ["entity_member.removed", { role: "staff" }],
    ["entity_member.removed", { removeReason: "unknown" }],
  ] as const)
    expect(EVENT_PAYLOAD_SCHEMAS[name].safeParse({ ...bodies[name], ...patch }).success).toBe(
      false,
    );
});
it("共享正式载荷保留老板注销、普通门店归档和店员移除来源", () => {
  expect(
    EVENT_PAYLOAD_SCHEMAS["entity.closed"].safeParse({
      ...bodies["entity.closed"],
      closedBy: "owner_deletion",
    }).success,
  ).toBe(true);
  expect(
    EVENT_PAYLOAD_SCHEMAS["store.archived"].safeParse({
      ...bodies["store.archived"],
      archiveReason: "by_owner",
      transition: "store.archive",
    }).success,
  ).toBe(true);
  expect(
    EVENT_PAYLOAD_SCHEMAS["entity_member.removed"].safeParse({
      ...bodies["entity_member.removed"],
      role: "clerk",
      removeReason: "by_owner",
      transition: "entity_member.remove",
    }).success,
  ).toBe(true);
});
