import { describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "./index.js";

const id = "018fabcd-0000-7000-8000-000000000001";
const body = {
  v: 1,
  entityMemberId: id,
  entityId: id,
  merchantUserId: id,
  addedStoreIds: [id],
  removedStoreIds: [],
};
const schema = EVENT_PAYLOAD_SCHEMAS["entity_member.stores_changed"];
describe("member stores changed exact non-transition payload", () => {
  it("accepts invitation omitted/null/real ID and preserves the formal body", () => {
    for (const value of [body, { ...body, invitationId: null }, { ...body, invitationId: id }])
      expect(schema.parse(value)).toEqual(value);
    expect(schema.parse({ ...body, addedStoreIds: [], removedStoreIds: [id] })).toMatchObject({
      addedStoreIds: [],
      removedStoreIds: [id],
    });
  });
  it.each(Object.keys(body))("requires %s without repairing missing fields", (key) => {
    const value: Record<string, unknown> = { ...body };
    delete value[key];
    expect(schema.safeParse(value).success).toBe(false);
  });
  it("refuses PII, body text, renamed IDs and migration keys", () => {
    for (const patch of [
      { phone: "13800138000" },
      { displayName: "不得传播" },
      { memberId: id },
      { v: 2 },
      { fromState: "active" },
      { toState: "active" },
      { transition: "entity_member.update" },
    ])
      expect(schema.safeParse({ ...body, ...patch }).success).toBe(false);
  });
  it.each([id.toUpperCase(), id.replace("abcd", "aBcd"), "bad", null])(
    "refuses invalid reference %s in every ID location",
    (invalid) => {
      for (const key of ["entityMemberId", "entityId", "merchantUserId"])
        expect(schema.safeParse({ ...body, [key]: invalid }).success).toBe(false);
      for (const key of ["addedStoreIds", "removedStoreIds"])
        expect(schema.safeParse({ ...body, [key]: [invalid] }).success).toBe(false);
      if (invalid !== null)
        expect(schema.safeParse({ ...body, invitationId: invalid }).success).toBe(false);
    },
  );
});
