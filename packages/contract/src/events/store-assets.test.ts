import { expect, it } from "vitest";
import { eventPayloadSchema } from "./index.js";
import { payloads } from "./media.js";

const id = "01900000-0000-7000-8000-000000000001";
const cases = [
  ["asset.processed", { v: 1, storeAssetId: id, entityId: id, storeId: id }],
  ["asset.review_needed", { v: 1, storeAssetId: id, storeId: id, dueAt: "2026-10-12T04:00:00Z" }],
  [
    "asset.reviewed",
    {
      v: 1,
      storeAssetId: id,
      storeId: id,
      usability: "need_portrait_auth",
      uploadActorType: "merchant",
      uploaderUserId: id,
    },
  ],
  [
    "asset.demand_created",
    { v: 1, storeAssetDemandId: id, storeId: id, notifyScope: "owner_only", dueDate: "2026-10-12" },
  ],
  [
    "asset.feedback_submitted",
    { v: 1, storeAssetId: id, entityId: id, storeId: id, actorRole: "clerk" },
  ],
  ["asset.sla_breached", { v: 1, storeAssetId: id, storeId: id, dueAt: "2026-10-12T04:00:00Z" }],
] as const;

it.each(cases)(
  "既有 %s 事件公开严格schema绑定，保留实际载荷且拒绝URL/正文/版本漂移",
  (name, value) => {
    const schema = payloads[name];
    expect(eventPayloadSchema(name)).toBe(schema);
    expect(schema.parse(value)).toEqual(value);
    for (const invalid of [
      { ...value, v: 2 },
      { ...value, storeId: "bad-id" },
      { ...value, url: "https://invalid.example/private" },
      { ...value, textBody: "禁止正文" },
    ]) {
      expect(schema.safeParse(invalid).success).toBe(false);
    }
  },
);

it("素材事件只接受正式通知对象、可用性、角色及日期", () => {
  expect(
    payloads["asset.demand_created"].safeParse({ ...cases[3][1], notifyScope: "owner" }).success,
  ).toBe(false);
  expect(
    payloads["asset.reviewed"].safeParse({ ...cases[2][1], usability: "approved" }).success,
  ).toBe(false);
  expect(
    payloads["asset.feedback_submitted"].safeParse({ ...cases[4][1], actorRole: "staff" }).success,
  ).toBe(false);
  expect(
    payloads["asset.sla_breached"].safeParse({ ...cases[5][1], dueAt: "2026-10-12" }).success,
  ).toBe(false);
});
