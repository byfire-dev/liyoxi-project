import { describe, expect, it } from "vitest";
import type { AccessSnapshot } from "../../../lib/permissions";
import { writeTableSearch } from "../../../lib/table-search";
import {
  financeScope,
  moneyText,
  paymentFilters,
  paymentSearch,
  paymentTableSearch,
} from "./model";

describe("W418收款只读输入", () => {
  it("可分享的真实收款日期/渠道/入账筛选与分页分离，坏值不能成为隐形筛选", () => {
    const search = paymentSearch({
      page: "3",
      pageSize: "50",
      q: "  商家或交易号  ",
      successFrom: "2030-10-01",
      successTo: "2030-10-18",
      orderType: "plan_upgrade",
      channel: "bank_transfer",
      reconState: "diff",
      isApplied: "false",
      entityId: "不是收款流水筛选",
      sort: "amountFen",
    });
    expect(paymentFilters(search)).toEqual({
      q: "商家或交易号",
      successFrom: "2030-10-01",
      successTo: "2030-10-18",
      orderType: "plan_upgrade",
      channel: "bank_transfer",
      reconState: "diff",
      isApplied: "false",
    });
    expect(paymentSearch(writeTableSearch(paymentTableSearch(search)))).toEqual(search);
    expect(
      paymentSearch({
        page: -1,
        pageSize: 500,
        q: " ",
        successFrom: "2030-02-30",
        channel: "offline",
        isApplied: true,
      }),
    ).toEqual({
      page: 1,
      pageSize: 20,
      q: undefined,
      successFrom: undefined,
      successTo: undefined,
      orderType: undefined,
      channel: undefined,
      reconState: undefined,
      isApplied: undefined,
    });
  });
  it("大额汇总保持逐分精度，0与null分开；人员/权限变化不能沿用同一读取scope", () => {
    expect(moneyText("900719925474099301")).toBe("¥9,007,199,254,740,993.01");
    expect(moneyText("-101")).toBe("−¥1.01");
    expect(moneyText(0)).toBe("¥0.00");
    expect(moneyText("0")).toBe("¥0.00");
    expect(moneyText(null)).toBe("—");
    expect(moneyText("1e4")).toBe("—");
    const access: AccessSnapshot = {
      staff: {
        id: "0199e187-e72a-7000-8000-000000000001",
        name: "虚构财务",
        roleKey: "finance",
        roleName: "财务",
      },
      moduleLevels: { finance: "v" },
      isLead: false,
      dataScope: "own",
      actions: [],
      releases: {},
    };
    for (const changed of [
      null,
      { ...access, dataScope: "all" as const },
      { ...access, actions: ["finance.refund.execute"] },
      { ...access, staff: { ...access.staff, id: "0199e187-e72a-7000-8000-000000000002" } },
    ])
      expect(financeScope(changed)).not.toBe(financeScope(access));
  });
});
