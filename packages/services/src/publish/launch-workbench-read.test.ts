import { describe, expect, it } from "vitest";
import { LaunchCalendarQuerySchema, AdminLaunchTaskListQuerySchema } from "@liyoxi/contract";
import { deriveLaunchOverdue } from "./launch-overdue.js";
import type { LaunchOverdueFacts } from "./launch-overdue.js";
import { overdueHistoryDays } from "./launch-overdue-history.js";
import type { LaunchHistoryTransition } from "./launch-overdue-history.js";
import { launchCalendarBounds } from "./launch-workbench.js";

const at = (date: string, time = "12:00:00") => new Date(`${date}T${time}+08:00`);
const date = (value: string) => new Date(`${value}T00:00:00.000Z`);
const task = { id: "task-a", reviewStatus: "pending", isLive: false };
const facts = (overrides: Partial<LaunchOverdueFacts> = {}): LaunchOverdueFacts => ({
  orderItemId: "item-a",
  agreedLaunchDate: date("2026-11-03"),
  usageEndDate: date("2026-12-31"),
  phase: "to_launch",
  deliveredAt: at("2026-11-02"),
  pauseCount: 0,
  tasks: [task],
  ...overrides,
});
const transition = (
  day: string,
  state: string,
  isLive = false,
  time = "00:00:00",
): LaunchHistoryTransition => ({
  occurredAt: at(day, time),
  toState: state,
  event: "test",
  isLive,
});

describe("上线工作台统一当前日期口径", () => {
  it("按任务标出双平台中的未上线账号，工单已服务中仍可有逾期", () => {
    const overdue = deriveLaunchOverdue(
      facts({
        phase: "live",
        tasks: [task, { id: "live-b", reviewStatus: "passed", isLive: true }],
      }),
      at("2026-11-06"),
    );
    expect(overdue).toEqual({
      orderItemId: "item-a",
      agreedLaunchDate: "2026-11-03",
      overdueStartDate: "2026-11-04",
      overdueDays: 3,
      reason: "merchant",
      overdueTaskIds: ["task-a"],
    });
  });

  it.each([
    { pauseCount: 1 },
    { phase: "producing" },
    { agreedLaunchDate: null },
    { agreedLaunchDate: date("2026-11-06") },
    { usageEndDate: date("2026-11-05") },
    { deliveredAt: null },
    { tasks: [{ ...task, isLive: true, reviewStatus: "need_fix" }] },
    { tasks: [{ ...task, reviewStatus: "verifying" }] },
    { tasks: [{ ...task, reviewStatus: "passed" }] },
    { tasks: [{ ...task, reviewStatus: "void" }] },
  ])("暂停/阶段/止日与任务状态按契约排除：%j", (overrides) => {
    expect(deriveLaunchOverdue(facts(overrides), at("2026-11-06"))).toBeNull();
  });

  it("晚交付按北京时间交付次日起算，止日当天仍纳入", () => {
    expect(
      deriveLaunchOverdue(
        facts({
          deliveredAt: new Date("2026-11-04T17:00:00.000Z"),
          usageEndDate: date("2026-11-06"),
        }),
        at("2026-11-06"),
      ),
    ).toMatchObject({
      overdueStartDate: "2026-11-06",
      overdueDays: 1,
      reason: "late_delivery",
    });
    expect(
      deriveLaunchOverdue(facts({ deliveredAt: at("2026-11-06") }), at("2026-11-06", "13:00:00")),
    ).toMatchObject({ overdueStartDate: "2026-11-07", overdueDays: 0, reason: "late_delivery" });
  });
});

describe("近30天从真实状态及改期片段派生", () => {
  it("核验中的时间不算逾期，已上线后的补充退回不恢复逾期", () => {
    expect(
      overdueHistoryDays(
        {
          agreedLaunchDate: date("2026-11-01"),
          deliveredAt: at("2026-11-02"),
        },
        [
          transition("2026-11-02", "pending"),
          transition("2026-11-05", "verifying"),
          transition("2026-11-06", "need_fix"),
          transition("2026-11-08", "passed", true),
          transition("2026-11-09", "need_fix", true),
        ],
        [],
        at("2026-11-10"),
      ),
    ).toBe(4);
  });

  it("改约不能抹掉旧日期已发生的逾期，只在改期之后应用新日期", () => {
    expect(
      overdueHistoryDays(
        {
          agreedLaunchDate: date("2026-11-09"),
          deliveredAt: at("2026-11-01"),
        },
        [transition("2026-11-01", "pending")],
        [{ at: at("2026-11-05", "00:00:00"), prevDate: "2026-11-01" }],
        at("2026-11-10"),
      ),
    ).toBe(4);
  });

  it("同一自然日多个待补充片段只计一天，撤销后再次等待可继续计入", () => {
    expect(
      overdueHistoryDays(
        {
          agreedLaunchDate: date("2026-11-01"),
          deliveredAt: at("2026-11-01"),
        },
        [
          transition("2026-11-04", "pending", false, "08:00:00"),
          transition("2026-11-04", "verifying", false, "09:00:00"),
          transition("2026-11-04", "need_fix", false, "10:00:00"),
          transition("2026-11-04", "passed", true, "11:00:00"),
          transition("2026-11-05", "verifying", false, "08:00:00"),
          transition("2026-11-05", "need_fix", false, "09:00:00"),
        ],
        [],
        at("2026-11-05"),
      ),
    ).toBe(2);
  });

  it("仅累计窗口内有实际重叠的自然日，午夜结束不额外多算一天", () => {
    const item = { agreedLaunchDate: date("2026-09-01"), deliveredAt: at("2026-09-01") };
    expect(
      overdueHistoryDays(item, [transition("2026-09-01", "pending")], [], at("2026-11-10")),
    ).toBe(30);
    expect(
      overdueHistoryDays(
        item,
        [transition("2026-11-01", "pending"), transition("2026-11-02", "verifying")],
        [],
        at("2026-11-10"),
      ),
    ).toBe(1);
    expect(
      overdueHistoryDays(
        item,
        [transition("2026-09-01", "pending"), transition("2026-09-10", "passed", true)],
        [],
        at("2026-11-10"),
      ),
    ).toBe(0);
  });
});

describe("上线日历与列表查询边界", () => {
  it("自然月正确处理闰年，范围至多42个日期且month不能混用", () => {
    expect(launchCalendarBounds({ month: "2028-02" })).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(
      LaunchCalendarQuerySchema.safeParse({ from: "2026-11-01", to: "2026-12-12" }).success,
    ).toBe(true);
    expect(
      LaunchCalendarQuerySchema.safeParse({ from: "2026-11-01", to: "2026-12-13" }).success,
    ).toBe(false);
    for (const query of [
      {},
      { from: "2026-11-01" },
      { month: "2026-11", from: "2026-11-01", to: "2026-11-10" },
      { from: "2026-11-10", to: "2026-11-01" },
    ]) {
      expect(LaunchCalendarQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("列表缺省与严格布尔参数保持C43分页及七日窗口", () => {
    expect(AdminLaunchTaskListQuerySchema.parse({})).toMatchObject({
      tab: "overdue",
      days: 7,
      page: 1,
      pageSize: 20,
      readyOnly: false,
    });
    expect(AdminLaunchTaskListQuerySchema.parse({ readyOnly: "false" }).readyOnly).toBe(false);
    expect(AdminLaunchTaskListQuerySchema.safeParse({ readyOnly: "0" }).success).toBe(false);
    expect(AdminLaunchTaskListQuerySchema.safeParse({ days: "31" }).success).toBe(false);
  });
});
