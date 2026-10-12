import { describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "../events/index.js";
import { MessageDeepLinkSchema } from "../routes/m08-support-misc/messages.schemas.js";
import { NOTIFY_SCENES, isNotifySceneKey, notifySceneByKey } from "./index.js";

const entityId = "0199e000-0000-7000-8000-000000000001";
const termId = "0199e000-0000-7000-8000-000000000002";
const prevTermId = "0199e000-0000-7000-8000-000000000003";
const endedAt = "2026-10-01T16:00:00.000Z";
const rolled = { v: 1, entityId, termId, prevTermId };
const expired = { v: 1, entityId, termId, endedAt };

describe("权益变动的名额超限提醒契约", () => {
  it("专用商家场景唯一、名称固定，沿既有合法套餐深链", () => {
    expect(NOTIFY_SCENES.filter((row) => row.key === "m.quota_exceeded")).toEqual([
      { key: "m.quota_exceeded", audience: "merchant", name: "名额超限提醒" },
    ]);
    expect(isNotifySceneKey("m.quota_exceeded")).toBe(true);
    expect(notifySceneByKey("m.quota_exceeded")).toEqual({
      key: "m.quota_exceeded",
      audience: "merchant",
      name: "名额超限提醒",
    });
    expect(MessageDeepLinkSchema.parse({ route: "wallet.home", params: {} })).toEqual({
      route: "wallet.home",
      params: {},
    });
    expect(MessageDeepLinkSchema.safeParse({ route: "store.list", params: {} }).success).toBe(
      false,
    );
  });
  it.each([
    ["billing.subscription.rolled_over", rolled],
    ["billing.subscription.expired", expired],
  ] as const)("%s 保留原严格来源字段，不接受通知正文或假额度快照", (type, input) => {
    const schema = EVENT_PAYLOAD_SCHEMAS[type];
    expect(schema.parse(input)).toEqual(input);
    for (const extra of [{ storesOver: 2 }, { merchantUserId: entityId }, { body: "超额提醒" }])
      expect(schema.safeParse({ ...input, ...extra }).success).toBe(false);
    for (const patch of [{ v: 2 }, { entityId: "invalid" }, { termId: null }])
      expect(schema.safeParse({ ...input, ...patch }).success).toBe(false);
  });
  it("接续仍允许原nullable前期；到期必须保留真实止点", () => {
    expect(
      EVENT_PAYLOAD_SCHEMAS["billing.subscription.rolled_over"].parse({
        ...rolled,
        prevTermId: null,
      }),
    ).toEqual({ ...rolled, prevTermId: null });
    expect(
      EVENT_PAYLOAD_SCHEMAS["billing.subscription.expired"].safeParse({
        ...expired,
        endedAt: "2026-10-01",
      }).success,
    ).toBe(false);
    expect(
      EVENT_PAYLOAD_SCHEMAS["billing.subscription.expired"].safeParse({ v: 1, entityId, termId })
        .success,
    ).toBe(false);
  });
});
