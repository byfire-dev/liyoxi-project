import { describe, expect, it } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS } from "./index.js";

const id = "018fabcd-0000-7000-8000-000000000001";
const schema = EVENT_PAYLOAD_SCHEMAS["store.created"];
const body = {
  v: 1,
  storeId: id,
  entityId: id,
  isFirstStore: false,
  fromState: null,
  toState: "active",
  transition: "store.create",
};

describe("store.created 首店与分店共用正式事件", () => {
  it.each([true, false])("isFirstStore=%s 严格保留正式迁移事实", (isFirstStore) => {
    expect(schema.parse({ ...body, isFirstStore })).toEqual({ ...body, isFirstStore });
  });
  it("每一字段必需，不容许由消费者猜测首店或主体", () => {
    for (const key of Object.keys(body)) {
      const missing: Record<string, unknown> = { ...body };
      delete missing[key];
      expect(schema.safeParse(missing).success).toBe(false);
    }
  });
  it.each([
    { v: 2 },
    { storeId: "bad" },
    { entityId: id.toUpperCase() },
    { isFirstStore: 0 },
    { toState: "other" },
    { transition: "store.restore" },
    { ownerPhone: "13800138000" },
    { name: "不传播店名" },
    { copyOptions: ["brand_assets"] },
    { principal: { sessionId: id } },
  ])("拒绝错误载荷与私有信息 %j", (patch) => {
    expect(schema.safeParse({ ...body, ...patch }).success).toBe(false);
  });
});
