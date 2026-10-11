import { describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "./index.js";

const id = "018fabcd-0000-7000-8000-000000000001";
const bodies = {
  "invitation.accepted": {
    v: 1,
    invitationId: id,
    entityId: id,
    storeId: id,
    acceptedByUserId: id,
    fromState: "pending",
    toState: "accepted",
    transition: "invitation.accept",
  },
  "entity_member.joined": {
    v: 1,
    entityMemberId: id,
    entityId: id,
    merchantUserId: id,
    invitationId: id,
    storeIds: [id],
    fromState: null,
    toState: "active",
    transition: "entity_member.join",
  },
};
describe("接受与加入事件的精确迁移事实", () => {
  it.each(["invitation.accepted", "entity_member.joined"] as const)(
    "%s 必填、版本、归属与迁移键严格",
    (name) => {
      const schema = EVENT_PAYLOAD_SCHEMAS[name],
        body = bodies[name];
      expect(schema.parse(body)).toEqual(body);
      for (const key of Object.keys(body)) {
        const missing: Record<string, unknown> = { ...body };
        delete missing[key];
        expect(schema.safeParse(missing).success).toBe(false);
      }
      for (const patch of [
        { v: 2 },
        { v: "1" },
        { entityId: id.toUpperCase() },
        { invitationId: "bad" },
        { fromState: "accepted" },
        { transition: "accept" },
        { token: "a".repeat(43) },
        { displayName: "不得广播" },
        { phone: "13800138000" },
      ])
        expect(schema.safeParse({ ...body, ...patch }).success).toBe(false);
    },
  );
  it("加入明确新建迁移与非空门店集合；接受不是创建迁移", () => {
    for (const patch of [
      { storeIds: [] },
      { storeIds: ["bad"] },
      { toState: "removed" },
      { fromState: "pending" },
    ])
      expect(
        EVENT_PAYLOAD_SCHEMAS["entity_member.joined"].safeParse({
          ...bodies["entity_member.joined"],
          ...patch,
        }).success,
      ).toBe(false);
    expect(
      EVENT_PAYLOAD_SCHEMAS["invitation.accepted"].safeParse({
        ...bodies["invitation.accepted"],
        fromState: null,
      }).success,
    ).toBe(false);
  });
});
