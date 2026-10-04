import { derived, entry, type StatusToneGroup } from "./types.js";

const BY_DEADLINE = "无枚举对应：队列的展示状态，由工单步骤、下架任务状态与时限推导";

/** 任务队列（成片交付、下架核查）：只在后台出现。超时与逾期一律红 */
export const taskQueue: StatusToneGroup = {
  key: "task-queue",
  object: "任务队列（成片交付、下架核查）",
  entries: [
    derived("待交付", null, "warning", BY_DEADLINE),
    derived("待核查", null, "warning", BY_DEADLINE),
    derived("已超时", null, "danger", BY_DEADLINE),
    derived("逾期未下架", null, "danger", BY_DEADLINE),
    derived("已交付", null, "success", BY_DEADLINE),
    entry("已核查", "takedown_task.status", ["checked"], null, "success"),
  ],
};
