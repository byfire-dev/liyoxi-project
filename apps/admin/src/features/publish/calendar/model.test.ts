import { describe, expect, it } from "vitest";
import type { AccessSnapshot } from "../../../lib/permissions";
import {
  beijingDate,
  calendarDays,
  calendarQuery,
  calendarSearch,
  dayLabel,
  managerAccess,
  selectedDate,
  verifyingTasks,
  verifyApprovalId,
} from "./model";
import { calendarFixture, id, task } from "./test-fixture";
describe("上线日历的真实日期与范围", () => {
  it("北京时间跨日跨年；拒绝不存在日期、跨月选中日和非法经理", () => {
    const now = new Date("2026-12-31T16:00:00Z");
    expect(beijingDate(now)).toBe("2027-01-01");
    expect(
      calendarSearch({ month: "bad", date: "2026-02-30", managerId: "x", bypass: true }, now),
    ).toEqual({ month: "2027-01", date: undefined, managerId: undefined });
    expect(
      calendarSearch({ month: "2024-02", date: "2024-02-29", managerId: id(1) }, now).date,
    ).toBe("2024-02-29");
    expect(calendarSearch({ month: "2026-02", date: "2026-02-29" }, now).date).toBeUndefined();
    expect(calendarSearch({ month: "2026-02", date: "2026-03-01" }, now).date).toBeUndefined();
    expect(calendarQuery(calendarSearch({ month: "2026-12", managerId: id(1) }))).toEqual({
      month: "2026-12",
      managerId: id(1),
    });
  });
  it("完整日期轴取workCalendar，周六调休与缺历均不按星期猜测；保留服务器未截断统计", () => {
    const source = calendarFixture(),
      before = structuredClone(source);
    const days = calendarDays(source);
    expect(days.map(dayLabel)).toEqual(["国庆节", "缺少日历", "调休 · 调休上班"]);
    expect(days.map((day) => day.items)).toEqual([[], [], []]);
    expect(days[2]?.isWorkday).toBe(true);
    expect(source.stats.total).toBe(8);
    expect(source).toEqual(before);
  });
  it("选中日不沿用上个月/已失效范围；默认今天来自响应", () => {
    const source = calendarFixture();
    expect(selectedDate(source, "2026-09-30")).toBe("2026-10-02");
    expect(selectedDate(source, "2026-10-03")).toBe("2026-10-03");
    expect(selectedDate({ ...source, today: "2026-11-01" })).toBe("2026-10-01");
  });
  it("只为当前verifying且有submission的账号开放核验，不取历史已通过版本", () => {
    expect(
      verifyingTasks([
        task,
        { ...task, reviewStatus: "passed" },
        { ...task, currentSubmissionId: null },
        { ...task, reviewStatus: "need_fix", latestPassedSubmissionId: id(8) },
      ]),
    ).toEqual([task]);
    const detail = {
      launchSubmissionId: id(4),
      isCurrentRound: true,
      approval: { approvalId: id(7), status: "pending" },
    };
    expect(verifyApprovalId(detail, id(4))).toBe(id(7));
    expect(verifyApprovalId(detail, id(5))).toBeNull();
    expect(verifyApprovalId({ ...detail, isCurrentRound: false }, id(4))).toBeNull();
    expect(
      verifyApprovalId({ ...detail, approval: { ...detail.approval, status: "approved" } }, id(4)),
    ).toBeNull();
  });
  it("经理候选遵真实pool鉴权，publisher不会额外调用员工管理口", () => {
    const viewer: AccessSnapshot = {
      staff: { id: id(1), name: "虚构员工", roleKey: "publisher", roleName: "发布专员" },
      isLead: false,
      moduleLevels: { publish: "v" },
      actions: [],
      dataScope: "own",
      releases: {},
    };
    expect(managerAccess(viewer)).toEqual({ allowed: false, pool: true });
    expect(managerAccess({ ...viewer, moduleLevels: { system: "v" } })).toEqual({
      allowed: true,
      pool: false,
    });
    expect(managerAccess({ ...viewer, actions: ["merchant.manager.assign"] })).toEqual({
      allowed: true,
      pool: true,
    });
  });
});
