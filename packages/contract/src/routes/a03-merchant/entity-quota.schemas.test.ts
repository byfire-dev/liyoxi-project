import { describe, expect, it } from "vitest";
import {
  EntityQuotaUpdateBodySchema,
  EntityIdParamsSchema,
  EntityCardSchema,
  adminEntityQuotaUpdate,
} from "./index.js";

const base = {
  lockVersion: 0,
  confirm: { storeLimitOverride: null, memberLimitOverride: null },
  reasonText: "合同约定额度调整",
};
describe("主体额度写契约", () => {
  it.each([
    { storeLimitOverride: 1 },
    { storeLimitOverride: 2_147_483_647 },
    { memberLimitOverride: 0 },
    { memberLimitOverride: 2_147_483_647 },
    { storeLimitOverride: null },
    { memberLimitOverride: null },
    { storeLimitOverride: 3, memberLimitOverride: 5 },
    { storeLimitOverride: null, memberLimitOverride: null },
  ])("合法覆盖保留字段存在性 %#", (values) => {
    const parsed = EntityQuotaUpdateBodySchema.parse({ ...base, ...values });
    expect(parsed).toEqual({ ...base, ...values });
    expect(Object.hasOwn(parsed, "storeLimitOverride")).toBe(
      Object.hasOwn(values, "storeLimitOverride"),
    );
    expect(Object.hasOwn(parsed, "memberLimitOverride")).toBe(
      Object.hasOwn(values, "memberLimitOverride"),
    );
  });

  it.each([
    {},
    { storeLimitOverride: 0 },
    { storeLimitOverride: -1 },
    { storeLimitOverride: 1.5 },
    { storeLimitOverride: 2_147_483_648 },
    { storeLimitOverride: "2" },
    { storeLimitOverride: false },
    { memberLimitOverride: -1 },
    { memberLimitOverride: 0.5 },
    { memberLimitOverride: 2_147_483_648 },
    { memberLimitOverride: "0" },
    { memberLimitOverride: true },
    { storeLimitOverride: undefined },
  ])("非法覆盖拒绝不强制转换 %#", (values) => {
    expect(EntityQuotaUpdateBodySchema.safeParse({ ...base, ...values }).success).toBe(false);
  });

  it.each([-1, 0.1, 2_147_483_648, "0", null, undefined])("非法版本 %s", (lockVersion) => {
    expect(
      EntityQuotaUpdateBodySchema.safeParse({ ...base, storeLimitOverride: 1, lockVersion })
        .success,
    ).toBe(false);
  });
  it.each([
    undefined,
    null,
    {},
    { storeLimitOverride: null },
    { memberLimitOverride: null },
    { storeLimitOverride: 0, memberLimitOverride: null },
    { storeLimitOverride: null, memberLimitOverride: -1 },
    { storeLimitOverride: null, memberLimitOverride: null, usage: 0 },
  ])("双回显必填且严格 %#", (confirm) => {
    expect(
      EntityQuotaUpdateBodySchema.safeParse({ ...base, storeLimitOverride: 1, confirm }).success,
    ).toBe(false);
  });
  it.each(["", "字".repeat(201), "🍜".repeat(201), null, 1])("原因边界拒绝 %#", (reasonText) => {
    expect(
      EntityQuotaUpdateBodySchema.safeParse({ ...base, memberLimitOverride: 0, reasonText })
        .success,
    ).toBe(false);
  });
  it.each(["字", "字".repeat(200), "🍜".repeat(200)])("原因按Unicode码点通过 %#", (reasonText) => {
    expect(
      EntityQuotaUpdateBodySchema.parse({ ...base, memberLimitOverride: 0, reasonText }).reasonText,
    ).toBe(reasonText);
  });
  it.each(["usage", "isSuperAdmin", "entityId", "confirmed", "isOverLimit"])(
    "未知键%s拒绝",
    (key) => {
      expect(
        EntityQuotaUpdateBodySchema.safeParse({ ...base, storeLimitOverride: 1, [key]: true })
          .success,
      ).toBe(false);
    },
  );
  it("仅既有PATCH换为typed，不增加权限、三段标记或HTTP名字", () => {
    expect(adminEntityQuotaUpdate).toMatchObject({
      method: "patch",
      path: "/api/v1/admin/entities/{entityId}/quota",
      operationId: "admin.entity.quota.update",
      "x-auth": "staff",
      "x-permission": "merchant.quota.override",
      "x-idempotent": "required",
    });
    expect(adminEntityQuotaUpdate.request?.params).toBe(EntityIdParamsSchema);
    expect(adminEntityQuotaUpdate.request?.body?.content["application/json"].schema).toBe(
      EntityQuotaUpdateBodySchema,
    );
    expect(adminEntityQuotaUpdate.responses[200].content["application/json"].schema).toBeDefined();
    expect(EntityCardSchema.shape.lockVersion.safeParse(1).success).toBe(true);
    expect("x-three-phase" in adminEntityQuotaUpdate).toBe(false);
  });
});
