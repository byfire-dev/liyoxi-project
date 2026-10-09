import { describe, expect, it } from "vitest";
import { flagBody, type Flag } from "./model";
const flag: Flag = {
  flagKey: "release.partner",
  valueType: "bool",
  defaultValue: false,
  rules: [],
  exposedTo: "client",
  description: null,
  options: null,
  updatedAt: "2026-10-08T00:00:00Z",
  updatedBy: null,
  lockVersion: 8,
};
describe("W207 完整有序开关规则", () => {
  it("保留规则顺序、四维条件及缺省分支和原版本", () => {
    const rules = [
      {
        when: {
          platform: ["weapp"],
          clientVersion: ">=1.2.0 <2.0.0",
          envVersion: ["trial"],
          entityIds: ["01990000-0000-7000-8000-000000000004"],
        },
        value: true,
      },
      { when: { envVersion: ["release"] }, value: false },
    ];
    expect(flagBody(flag, false, JSON.stringify(rules), "测试").body).toEqual({
      lockVersion: 8,
      defaultValue: false,
      rules,
      description: "测试",
    });
  });
  it("规则不能无条件、不能加入审核态条件，值遵守返回类型", () => {
    expect(flagBody(flag, false, '[{"when":{},"value":true}]', "").errors).not.toEqual({});
    expect(
      flagBody(flag, false, '[{"when":{"approvalState":"approved"},"value":true}]', "").errors,
    ).not.toEqual({});
    expect(flagBody(flag, "false", "[]", "").errors.defaultValue).toBeDefined();
    expect(
      flagBody(flag, false, '[{"when":{"envVersion":["trial"]},"value":"true"}]', "").errors
        .defaultValue,
    ).toBeDefined();
  });
  it("版本格式/规则数/主体白名单大小由正式契约拒绝", () => {
    expect(
      flagBody(flag, false, '[{"when":{"clientVersion":"^1.0.0"},"value":true}]', "").errors,
    ).not.toEqual({});
    expect(
      flagBody(
        flag,
        false,
        JSON.stringify(
          Array.from({ length: 21 }, () => ({ when: { platform: ["weapp"] }, value: true })),
        ),
        "",
      ).errors,
    ).not.toEqual({});
    expect(flagBody(flag, false, "invalid", "").errors.rules).toBe("请填写合法 JSON");
  });
});
