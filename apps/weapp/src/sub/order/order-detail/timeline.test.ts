import { describe, expect, it } from "vitest";

import { formatOrderTimelineTime } from "./timeline";

describe("订单时间轴的日历日期与实际时刻", () => {
  it("未来使用期结束日按日期显示，不要求伪造午夜时刻", () => {
    const pendingEnd = { key: "usage_ended", state: "todo", at: "2028-10-07" };
    expect(formatOrderTimelineTime(pendingEnd.at)).toBe("2028-10-07");
  });

  it("真实时刻继续按北京时间显示，跨日与显式偏移一致", () => {
    expect(formatOrderTimelineTime("2026-10-26T16:30:00.000Z")).toBe("10-27 00:30");
    expect(formatOrderTimelineTime("2026-10-27T00:30:00+08:00")).toBe("10-27 00:30");
  });

  it("没有时区的非法时刻仍拒绝，不把日期前缀当作完整日期", () => {
    expect(() => formatOrderTimelineTime("2028-10-07T00:00:00")).toThrow(RangeError);
  });

  it("尚未发生且没有计划日期的节点保持没有展示时间", () => {
    expect(formatOrderTimelineTime(null)).toBeUndefined();
  });
});
