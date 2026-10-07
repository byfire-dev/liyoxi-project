import { describe, expect, it } from "vitest";
import { smsFailureSuspect } from "./sms-health.js";
import { SMS_FIELDS, SMS_TODO_ITEMS, SmsInitSchema } from "./sms-init.js";

describe("正式短信失效率与固定模板边界", () => {
  it("空无比率；非空100%触发；50%不触发；51%以上触发", () => {
    expect(smsFailureSuspect([])).toBe(false);
    expect(smsFailureSuspect([{ status: "failed" }])).toBe(true);
    expect(smsFailureSuspect([{ status: "failed" }, { status: "sent" }])).toBe(false);
    expect(
      smsFailureSuspect([{ status: "failed" }, { status: "sent" }, { status: "failed" }]),
    ).toBe(true);
  });
  it("连续5失败独立成立，即使十个样本总失败率正好50%", () => {
    expect(
      smsFailureSuspect([
        ...Array.from({ length: 5 }, () => ({ status: "failed" })),
        ...Array.from({ length: 5 }, () => ({ status: "sent" })),
      ]),
    ).toBe(true);
    expect(
      smsFailureSuspect([
        ...Array.from({ length: 4 }, () => ({ status: "failed" })),
        ...Array.from({ length: 6 }, () => ({ status: "sent" })),
      ]),
    ).toBe(false);
  });
  it("九个固定模板变量均有限；generic_todo示例来自≤12字固定枚举", () => {
    expect(Object.keys(SMS_FIELDS)).toHaveLength(9);
    expect(SMS_FIELDS["account_notice"]).toEqual([]);
    expect(SMS_FIELDS["verify_code"]?.map((field) => field.name)).toEqual(["code"]);
    expect(SMS_TODO_ITEMS.every((value) => [...value].length <= 12)).toBe(true);
    expect(SMS_TODO_ITEMS).toContain(SMS_FIELDS["generic_todo"]?.[0]?.test);
    expect(SmsInitSchema.safeParse({ templates: [] }).success).toBe(false);
  });
});
