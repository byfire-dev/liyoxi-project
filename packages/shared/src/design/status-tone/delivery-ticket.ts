import { entry, type StatusToneGroup } from "./types.js";

const COLUMN = "delivery_ticket.step";
const IN_PROGRESS = { row: "各步骤进行中" } as const;

/** 交付工单：只在后台出现。枚举见 10 分组 第 3 节 */
export const deliveryTicket: StatusToneGroup = {
  key: "delivery-ticket",
  object: "交付工单",
  entries: [
    entry("待分配", COLUMN, ["assigning"], null, "warning"),
    entry("方案确认", COLUMN, ["plan_confirm"], null, "info", IN_PROGRESS),
    entry("广告准备", COLUMN, ["ad_prep"], null, "info", IN_PROGRESS),
    entry("样片制作", COLUMN, ["sample_making"], null, "info", IN_PROGRESS),
    entry("样片确认", COLUMN, ["sample_confirm"], null, "info", IN_PROGRESS),
    entry("批量合成", COLUMN, ["batch_compose"], null, "info", IN_PROGRESS),
    entry("成片交付", COLUMN, ["delivering"], null, "info", IN_PROGRESS),
    entry("上线核验", COLUMN, ["launch_verify"], null, "info", IN_PROGRESS),
    entry("待上线", COLUMN, ["awaiting_launch"], null, "warning", {
      row: null,
      note: "规范 第 13 节“待上线（后台）”的裁决点名了工单池，取橙；第 6.2 节的表没有单列这一步",
    }),
    entry("服务中", COLUMN, ["in_service"], null, "success"),
    entry("到期下架", COLUMN, ["takedown"], null, "neutral"),
  ],
};
