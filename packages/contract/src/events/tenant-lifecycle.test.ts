import { describe, expect, it } from "vitest";
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
  "entity.abandoned": {
    v: 1,
    entityId: id,
    fromState: "active",
    toState: "abandoned",
    transition: "entity.abandon",
  },
  "store.archived": {
    v: 1,
    entityId: id,
    storeId: id,
    archiveReason: "by_owner",
    fromState: "active",
    toState: "archived",
    transition: "store.archive",
  },
  "store.draft_deleted": { v: 1, entityId: id, storeId: id },
  "store.restored": {
    v: 1,
    entityId: id,
    storeId: id,
    fromState: "archived",
    toState: "active",
    transition: "store.restore",
  },
  "store.qualification.withdrawn": { v: 1, storeId: id, submissionId: id },
  "store.qualification_change.withdrawn": { v: 1, storeId: id, submissionId: id },
} as const;
type Name = keyof typeof bodies;
const names = Object.keys(bodies) as Name[];

describe("五个生命周期输入与两类资质撤回正式载荷", () => {
  it.each(names)("%s 接受正式v1字段且原样返回", (name) => {
    expect(EVENT_PAYLOAD_SCHEMAS[name].parse(bodies[name])).toEqual(bodies[name]);
  });
  it.each(names)("%s 拒绝额外字段、PII、坏ID、错误版本及缺字段", (name) => {
    const schema = EVENT_PAYLOAD_SCHEMAS[name];
    for (const patch of [
      { extra: true },
      { phone: "13800138000" },
      { transcript: "不得随事件传播的识别正文" },
      { v: 2 },
    ])
      expect(schema.safeParse({ ...bodies[name], ...patch }).success).toBe(false);
    for (const key of Object.keys(bodies[name])) {
      const missing: Record<string, unknown> = { ...bodies[name] };
      delete missing[key];
      expect(schema.safeParse(missing).success).toBe(false);
      if (key.endsWith("Id")) {
        expect(schema.safeParse({ ...bodies[name], [key]: "bad" }).success).toBe(false);
        expect(schema.safeParse({ ...bodies[name], [key]: null }).success).toBe(false);
      }
    }
  });
  it.each(["entity.closed", "entity.abandoned", "store.archived", "store.restored"] as const)(
    "%s 迁移键不能省略或使用其他动作",
    (name) => {
      for (const patch of [
        { fromState: null },
        { toState: "other" },
        { transition: "store.other" },
      ])
        expect(EVENT_PAYLOAD_SCHEMAS[name].safeParse({ ...bodies[name], ...patch }).success).toBe(
          false,
        );
    },
  );
  it("draft_deleted没有迁移键，withdrawn不擅自增加entityId/kind或系统布尔字段", () => {
    expect(
      EVENT_PAYLOAD_SCHEMAS["store.draft_deleted"].safeParse({
        ...bodies["store.draft_deleted"],
        transition: "store.draft_delete",
      }).success,
    ).toBe(false);
    for (const name of [
      "store.qualification.withdrawn",
      "store.qualification_change.withdrawn",
    ] as const) {
      for (const patch of [{ entityId: id }, { kind: "change" }, { isSystem: true }]) {
        expect(EVENT_PAYLOAD_SCHEMAS[name].safeParse({ ...bodies[name], ...patch }).success).toBe(
          false,
        );
      }
    }
  });
});
