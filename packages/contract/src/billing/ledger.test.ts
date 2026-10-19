import { describe, expect, it } from "vitest";

import { LEDGER_TITLE_CODES, parseLedgerTitleArgs } from "./ledger.js";

describe("账本操作的展示文案码（W1-10；m07 第 4.5 节）", () => {
  it("登记了 M1 十四个文案码与 M4 升级补发码", () => {
    expect([...LEDGER_TITLE_CODES].sort()).toEqual(
      [
        "ad_hold",
        "ad_revision_charge",
        "addon_resume",
        "addon_suspend",
        "adjust",
        "capture",
        "grant_monthly",
        "grant_open",
        "grant_term",
        "grant_upgrade",
        "order_hold",
        "refund",
        "release",
        "term_expire",
        "topup",
        "unexpire",
      ].sort(),
    );
  });

  it("调整说明保留正式200字边界，复活只接受1至90天", () => {
    expect(
      parseLedgerTitleArgs("adjust", { reasonCode: "other", note: "补".repeat(200) }).note,
    ).toHaveLength(200);
    expect(() =>
      parseLedgerTitleArgs("adjust", { reasonCode: "other", note: "补".repeat(201) }),
    ).toThrow();
    expect(parseLedgerTitleArgs("unexpire", { days: 90 })).toEqual({ days: 90 });
    expect(() => parseLedgerTitleArgs("unexpire", { days: 0 })).toThrow();
    expect(() => parseLedgerTitleArgs("unexpire", { days: 91 })).toThrow();
  });

  it("参数按码校验：合格的原样返回；多一个键、码不在登记里都抛错", () => {
    const args = { planName: "专业版", termStartDate: "2026-09-13", termEndDate: "2026-10-12" };
    expect(parseLedgerTitleArgs("grant_term", args)).toEqual(args);
    expect(() => parseLedgerTitleArgs("grant_term", { ...args, memo: "x" })).toThrow();
    expect(() =>
      parseLedgerTitleArgs("grant_monthly", { planName: "专业版", monthNo: 0 }),
    ).toThrow();
    expect(() => parseLedgerTitleArgs("toString" as "topup", {})).toThrow(TypeError);
    expect(
      parseLedgerTitleArgs("topup", {
        billingOrderNo: "FK2026010500001",
        payFen: 100_000,
        channel: "wechat_jsapi",
      }).payFen,
    ).toBe(100_000);
  });
});
