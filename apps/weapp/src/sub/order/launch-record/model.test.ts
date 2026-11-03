import { expect, it, vi } from "vitest";
import { task, tasks } from "../../../../shots/delivery-fixtures";
import { patrolLabel, readLaunchRecord } from "./model";
it("真实巡检历史原样保留，并保持原上线详情", async () => {
  const detail = structuredClone(task);
  detail.patrols = [
    {
      patrolTaskId: "patrol",
      status: "recovered",
      checkedAt: "2026-11-01T00:00:00Z",
      checkedByName: "核查员",
      results: [],
      abnormalKind: { code: "offline", name: "作品不可见" },
      note: "已恢复",
      foundAt: "2026-10-30T00:00:00Z",
      recoveredAt: "2026-11-01T00:00:00Z",
    },
  ];
  const result = await readLaunchRecord(
    { tasks: async () => tasks, task: async () => detail },
    "item",
    () => true,
  );
  expect(result[0]?.patrols).toEqual(detail.patrols);
  expect(result[0]?.timeline).toEqual(task.timeline);
  expect(patrolLabel("recovered")).toBe("复查已恢复");
  expect(patrolLabel("pending")).not.toContain("正常");
});
it("重复游标显式失败且跨上下文迟到详情丢弃", async () => {
  const list = vi.fn(async () => ({ ...tasks, hasMore: true, nextCursor: "same" }));
  await expect(
    readLaunchRecord({ tasks: list, task: async () => task }, "item", () => true),
  ).rejects.toThrow("分页已变化");
  expect(list).toHaveBeenCalledTimes(2);
  let current = true;
  const result = await readLaunchRecord(
    {
      tasks: async () => tasks,
      task: async () => {
        current = false;
        return task;
      },
    },
    "item",
    () => current,
  );
  expect(result).toEqual([]);
});
