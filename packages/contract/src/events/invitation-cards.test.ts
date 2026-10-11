import { describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "./index.js";

const id = "018fabcd-0000-7000-8000-000000000001";
const refs = { v: 1, invitationId: id, entityId: id, storeId: id };
const bodies = {
  "invitation.created": {
    ...refs,
    expiresAt: "2026-10-18T00:00:00.000Z",
    fromState: null,
    toState: "pending",
    transition: "invitation.create",
  },
  "invitation.expired": {
    ...refs,
    fromState: "pending",
    toState: "expired",
    transition: "invitation.expire",
  },
  "invitation.revoked": {
    ...refs,
    fromState: "pending",
    toState: "revoked",
    transition: "invitation.revoke",
  },
};
const names = ["invitation.created", "invitation.expired", "invitation.revoked"] as const;

describe("邀请卡片事件的版本与迁移载荷", () => {
  it.each(names)("%s 保留精确迁移三键和全部必填字段", (name) => {
    const schema = EVENT_PAYLOAD_SCHEMAS[name];
    const body = bodies[name];
    expect(schema.parse(body)).toEqual(body);
    for (const key of Object.keys(body)) {
      const missing: Record<string, unknown> = { ...body };
      delete missing[key];
      expect(schema.safeParse(missing).success).toBe(false);
    }
    for (const patch of [
      { v: 2 },
      { v: "1" },
      { fromState: "accepted" },
      { toState: "unknown" },
      { transition: "create" },
      { transition: "invitation.accept" },
    ])
      expect(schema.safeParse({ ...body, ...patch }).success).toBe(false);
  });
  it.each(names)("%s 不传播令牌、手机号、姓名、请求号或请求正文", (name) => {
    for (const patch of [
      { token: "a".repeat(43) },
      { targetPhone: "13800138000" },
      { phone: "13800138000" },
      { remarkName: "不得传播" },
      { inviterName: "不得传播" },
      { clientRequestId: id },
      { body: {} },
    ])
      expect(EVENT_PAYLOAD_SCHEMAS[name].safeParse({ ...bodies[name], ...patch }).success).toBe(
        false,
      );
  });
  it.each(names)("%s 的三个归属 ID 均遵守原小写 v7 约束", (name) => {
    for (const bad of [
      id.toUpperCase(),
      id.replace("abcd", "aBcd"),
      "123e4567-e89b-42d3-a456-426614174000",
      "bad",
      null,
    ])
      for (const key of ["invitationId", "entityId", "storeId"])
        expect(EVENT_PAYLOAD_SCHEMAS[name].safeParse({ ...bodies[name], [key]: bad }).success).toBe(
          false,
        );
  });
  it("仅创建事件带到期时刻，过期与原撤销事件不能携带额外 expiresAt", () => {
    for (const expiresAt of [null, "bad", "2026-10-18T00:00:00Z"])
      expect(
        EVENT_PAYLOAD_SCHEMAS["invitation.created"].safeParse({
          ...bodies["invitation.created"],
          expiresAt,
        }).success,
      ).toBe(false);
    for (const name of ["invitation.expired", "invitation.revoked"] as const)
      expect(
        EVENT_PAYLOAD_SCHEMAS[name].safeParse({
          ...bodies[name],
          expiresAt: bodies["invitation.created"].expiresAt,
        }).success,
      ).toBe(false);
    expect(
      EVENT_PAYLOAD_SCHEMAS["invitation.created"].safeParse({
        ...bodies["invitation.created"],
        fromState: "pending",
      }).success,
    ).toBe(false);
    expect(
      EVENT_PAYLOAD_SCHEMAS["invitation.expired"].safeParse({
        ...bodies["invitation.expired"],
        fromState: null,
      }).success,
    ).toBe(false);
  });
});
