import { describe, expect, it } from "vitest";
import {
  canRemind,
  followBody,
  overdueLabel,
  overdueSearch,
  trackFilters,
  trackQuery,
} from "./model";
import { id } from "../calendar/test-fixture";
describe("逾期跟进筛选与写入边界", () => {
  it("列表与summary用同一完整筛选，summary不带tab、页码或选中项", () => {
    const search = overdueSearch({
      tab: "upcoming",
      days: 30,
      page: 2,
      pageSize: 50,
      managerId: id(1),
      orderItemId: id(2),
      deliveryTicketId: id(3),
      readyOnly: "true",
      q: "  虚构门店  ",
      id: id(4),
      injected: true,
    });
    const { tab: _tab, page: _page, pageSize: _size, ...filters } = trackQuery(search);
    expect(filters).toEqual(trackFilters(search));
    expect(filters).toEqual({
      days: 30,
      managerId: id(1),
      orderItemId: id(2),
      deliveryTicketId: id(3),
      readyOnly: true,
      q: "虚构门店",
    });
    expect(
      overdueSearch({
        tab: "bad",
        days: 31,
        page: -1,
        pageSize: 1000,
        readyOnly: "1",
        managerId: "wrong",
      }),
    ).toMatchObject({
      tab: "overdue",
      days: 7,
      page: 1,
      pageSize: 20,
      readyOnly: false,
      managerId: undefined,
    });
  });
  it("成片晚交不文案冒充商家逾期，未交付/今天上线不靠本地时钟推导", () => {
    const row = {
      isDelivered: true,
      daysUntilLaunch: null,
      overdue: { startDate: "2026-10-01", days: 4, reason: "late_delivery" as const },
    };
    expect(overdueLabel(row)).toBe("成片晚交 · 4 天");
    expect(overdueLabel({ ...row, overdue: { ...row.overdue, reason: "merchant" } })).toBe(
      "商家未按期上线 · 4 天",
    );
    expect(overdueLabel({ isDelivered: false, overdue: null, daysUntilLaunch: 0 })).toBe(
      "成片未交付 · 今天上线",
    );
  });
  it("只用服务端提醒动作且今天已提醒不可重复", () => {
    expect(canRemind({ actions: [], isRemindedToday: false })).toBe(false);
    expect(canRemind({ actions: ["remind"], isRemindedToday: true })).toBe(false);
    expect(canRemind({ actions: ["remind"], isRemindedToday: false })).toBe(true);
  });
  it("跟进日期严格北京时间09点且晚于现在，不给非续费对象造意向/版本", () => {
    const now = new Date("2026-10-01T01:00:00Z");
    expect(followBody(id(1), "  已电话沟通  ", "2026-10-02", now)).toEqual({
      subjectType: "order_item",
      subjectId: id(1),
      content: "已电话沟通",
      nextFollowAt: "2026-10-02T09:00:00+08:00",
    });
    for (const next of ["2026-02-30", "2026-10-01", "2026-09-30"])
      expect(() => followBody(id(1), "沟通", next, now)).toThrow();
    expect(() => followBody(id(1), " ", "", now)).toThrow();
    expect(() => followBody(id(1), "文".repeat(201), "", now)).toThrow();
    expect(followBody(id(1), "暂不约下次", "", now)).not.toHaveProperty("nextFollowAt");
  });
});
