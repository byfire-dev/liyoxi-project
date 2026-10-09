import { describe, expect, it } from "vitest";
import { pendingEnrollmentLive, securityMenuItems } from "./security-menu";

describe("本人安全菜单与待确认密钥边界", () => {
  it("只按真实self权限开放重绑，普通安全与退出入口保持", () => {
    expect(securityMenuItems([], false).map((row) => row.key)).toEqual([
      "password",
      "wecom",
      "logout",
    ]);
    expect(securityMenuItems(["sys.staff.secure_ops"], false).map((row) => row.key)).toEqual([
      "password",
      "wecom",
      "logout",
    ]);
    expect(securityMenuItems(["self.mfa.reset"], false).map((row) => row.key)).toEqual([
      "password",
      "totp",
      "wecom",
      "logout",
    ]);
    expect(securityMenuItems(["self.mfa.reset"], true).every((row) => row.disabled)).toBe(true);
  });
  it("待确认密钥在准确到期边界、缺失及坏日期均不能提交", () => {
    const enrollment = {
      secret: "memory-only",
      otpauthUri: "otpauth://memory-only",
      pendingExpiresAt: "2026-10-09T09:00:00.000Z",
    };
    const expiry = Date.parse(enrollment.pendingExpiresAt);
    expect(pendingEnrollmentLive(enrollment, expiry - 1)).toBe(true);
    expect(pendingEnrollmentLive(enrollment, expiry)).toBe(false);
    expect(pendingEnrollmentLive(undefined, expiry - 1)).toBe(false);
    expect(pendingEnrollmentLive({ ...enrollment, pendingExpiresAt: "invalid" }, 0)).toBe(false);
  });
});
