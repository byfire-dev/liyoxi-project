import { describe, expect, it } from "vitest";
import { runQualificationFieldChecks } from "../media/index.js";
import { entityTypeCheck } from "./recognition.js";

describe("W316识别事实的核验边界", () => {
  it("unknown/不可用不造类型矛盾；真实比对保留归一、北京时间到期与更正差异且不泄露值", () => {
    expect(entityTypeCheck(null, "enterprise")).toBeNull();
    expect(entityTypeCheck({ subjectType: "unknown" }, "enterprise")).toMatchObject({
      isMismatch: false,
    });
    expect(entityTypeCheck({ subjectType: "individual" }, "enterprise")).toMatchObject({
      isMismatch: true,
    });
    const fields = {
      name: "测试（分店）",
      uscc: "91310000FAKE000001",
      principal: "原识别人员",
      subjectType: "unknown",
      validTo: "2026-01-10",
    };
    const check = (now: string) =>
      runQualificationFieldChecks({
        recognition: { status: "ok", fields, warnings: ["WARN_COPY_CARD"] },
        fields: { ...fields, name: " 测试(分店) ", principal: "人工核对人员" },
        docType: "business_license",
        now: new Date(now),
        usccValid: true,
        entityName: "测试（分店）",
        licenseName: null,
        claimedType: "enterprise",
      });
    expect(check("2026-01-10T15:59:59.999Z")).toEqual(
      expect.arrayContaining([
        { code: "C1", field: "name", result: "pass" },
        { code: "C3", field: "validTo", result: "warn" },
        { code: "C4", field: "subjectType", result: "manual" },
        { code: "C6", field: "principal", result: "info" },
        { code: "C7", field: "ocr", result: "warn" },
      ]),
    );
    expect(check("2026-01-10T16:00:00Z")).toEqual(
      expect.arrayContaining([{ code: "C3", field: "validTo", result: "fail" }]),
    );
    expect(JSON.stringify(check("2026-01-10T16:00:00Z"))).not.toContain("人工核对人员");
  });
});
