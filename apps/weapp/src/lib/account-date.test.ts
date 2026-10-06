import { describe, expect, it } from "vitest";

import { agreementEffectiveDate } from "./account-date";

describe("协议生效日沿应用时区", () => {
  it.each([
    ["2026-10-05T15:59:59Z", "2026-10-05"],
    ["2026-10-05T16:00:00Z", "2026-10-06"],
    ["2026-10-06T00:00:00+08:00", "2026-10-06"],
    ["2026-12-31T16:00:00Z", "2027-01-01"],
    ["2026-10-06", "2026-10-06"],
  ])("%s 显示 %s", (value, expected) => {
    expect(agreementEffectiveDate(value)).toBe(expected);
  });
});
