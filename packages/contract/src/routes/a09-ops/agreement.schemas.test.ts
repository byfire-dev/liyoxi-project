import { expect, it } from "vitest";
import { AdminAgreementConsentListQuerySchema } from "./agreement.schemas.js";

it.each(["NaN", "Infinity", "1e3", " ", "-1", "12345678901234567890", "9223372036854775808"])(
  "非法签署编号 %j 返回校验失败而不抛出转换异常",
  (consentNo) => {
    const result = AdminAgreementConsentListQuerySchema.safeParse({ consentNo });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.path).toEqual(["consentNo"]);
    }
  },
);

it.each(["0", "1", "0001", "9223372036854775807"])(
  "合法签署编号 %j 保留原始字符串和查询默认值",
  (consentNo) => {
    const result = AdminAgreementConsentListQuerySchema.parse({ consentNo });
    expect(result.consentNo).toBe(consentNo);
    expect(result.sort).toBe("-consentedAt");
  },
);

it("省略签署编号仍为合法查询", () => {
  expect(AdminAgreementConsentListQuerySchema.parse({}).consentNo).toBeUndefined();
});
