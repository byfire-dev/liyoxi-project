import { describe, expect, it } from "vitest";
import { adminEntityClose, EntityCloseBodySchema, EntityIdParamsSchema } from "./index.js";

const base = {
  reasonText: "主体已停止经营申请关闭",
  confirm: { activeStoreCount: 1, activeMemberCount: 1 },
};
describe("后台主体关闭契约", () => {
  it.each(["字".repeat(10), "字".repeat(200), "🍜".repeat(10), "🍜".repeat(200)])(
    "原因按Unicode码点接受10与200边界 %#",
    (reasonText) => {
      expect(EntityCloseBodySchema.parse({ ...base, reasonText }).reasonText).toBe(reasonText);
    },
  );
  it("两端空白与原核心使用同一归一化，不能凑足十字", () => {
    expect(EntityCloseBodySchema.parse({ ...base, reasonText: `  ${base.reasonText}  ` })).toEqual(
      base,
    );
    expect(
      EntityCloseBodySchema.safeParse({ ...base, reasonText: ` ${"字".repeat(9)} ` }).success,
    ).toBe(false);
  });
  it.each(["", "字".repeat(9), "字".repeat(201), "🍜".repeat(9), "🍜".repeat(201), null, 10])(
    "原因长度与类型严格拒绝 %#",
    (reasonText) => {
      expect(EntityCloseBodySchema.safeParse({ ...base, reasonText }).success).toBe(false);
    },
  );
  it.each(["activeStoreCount", "activeMemberCount"] as const)("%s非负int4且不强转", (key) => {
    for (const value of [0, 2_147_483_647])
      expect(
        EntityCloseBodySchema.parse({ ...base, confirm: { ...base.confirm, [key]: value } })
          .confirm[key],
      ).toBe(value);
    for (const value of [-1, 0.5, 2_147_483_648, "1", true, null, undefined])
      expect(
        EntityCloseBodySchema.safeParse({ ...base, confirm: { ...base.confirm, [key]: value } })
          .success,
      ).toBe(false);
  });
  it.each([
    undefined,
    null,
    {},
    { activeStoreCount: 1 },
    { activeMemberCount: 1 },
    { ...base.confirm, seatsUsed: 0 },
    { ...base.confirm, confirmed: true },
  ])("双回显必填且不接收未知确认字段 %#", (confirm) => {
    expect(EntityCloseBodySchema.safeParse({ ...base, confirm }).success).toBe(false);
  });
  it.each(["lockVersion", "entityId", "permission", "isSuperAdmin", "confirmed"])(
    "顶层未知键%s拒绝且不引入乐观锁",
    (key) => {
      expect(EntityCloseBodySchema.safeParse({ ...base, [key]: 1 }).success).toBe(false);
    },
  );
  it("既有POST只补typed结构，保持员工权限、required与完整卡片响应", () => {
    expect(adminEntityClose).toMatchObject({
      method: "post",
      path: "/api/v1/admin/entities/{entityId}/close",
      operationId: "admin.entity.close",
      "x-auth": "staff",
      "x-permission": "merchant.entity.close",
      "x-idempotent": "required",
    });
    expect(adminEntityClose.request?.params).toBe(EntityIdParamsSchema);
    expect(adminEntityClose.request?.body?.required).toBe(true);
    expect(adminEntityClose.request?.body?.content["application/json"].schema).toBe(
      EntityCloseBodySchema,
    );
    expect(adminEntityClose.responses[200].content["application/json"].schema).toBeDefined();
    expect(Object.keys(adminEntityClose.responses)).toEqual([
      "200",
      "400",
      "401",
      "403",
      "404",
      "409",
    ]);
    expect("x-three-phase" in adminEntityClose).toBe(false);
  });
});
