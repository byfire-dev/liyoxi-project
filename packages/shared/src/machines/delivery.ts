// delivery 模块：交付工单、交付方案、样片的状态迁移表。
// 每行：分组文档的行（分组:行号）、当前状态（null 是新建）、迁移事件码、新状态（SAME 是不改状态）；文档没写守卫的行尾是 NO_GUARD。
// 改这里的行，要在同一个 PR 改分组文档的那一行：pnpm machines:check 逐行对照。
import {
  DELIVERY_PLAN_STATUS,
  DELIVERY_TICKET_STEP,
  SAMPLE_STATUS,
  type EnumValue,
} from "@liyoxi/contract/enums";

import { NO_GUARD, SAME, chain } from "./define.js";

/** 步骤 1～9：暂停只发生在这九步，取消执行也只把这九步的工单终止（10 分组 ck_delivery_ticket_pause_steps） */
const STEPS_1_TO_9 = [
  "assigning",
  "plan_confirm",
  "ad_prep",
  "sample_making",
  "sample_confirm",
  "batch_compose",
  "delivering",
  "awaiting_launch",
  "launch_verify",
] as const satisfies readonly EnumValue<typeof DELIVERY_TICKET_STEP>[];

/** delivery_ticket.step：docs/data-model/10-delivery.md */
export const deliveryTicket = chain("delivery_ticket", "step", DELIVERY_TICKET_STEP, [
  // 表外行：开工建工单写在表后的说明里（门店已有交付经理时直接进方案确认）
  ["10:196", null, "ticket.created", ["assigning", "plan_confirm"], NO_GUARD],
  ["10:172", ["assigning"], "ticket.assign", ["plan_confirm"]],
  ["10:173", ["plan_confirm"], "plan.confirmed", ["ad_prep"]],
  ["10:174", ["ad_prep"], "ads.ready", ["sample_making"]],
  ["10:175", ["sample_making", "sample_confirm"], "sample.pushed", ["sample_confirm"]],
  ["10:176", ["sample_confirm"], "sample.confirmed", ["batch_compose"]],
  ["10:177", ["sample_confirm"], "sample.change_requested", ["sample_making"]],
  ["10:178", ["sample_confirm"], "sample.change_requested", ["ad_prep"]],
  ["10:179", ["sample_making", "sample_confirm"], "ad.reopened", ["ad_prep"]],
  ["10:180", ["batch_compose"], "episodes.all_passed", ["delivering"]],
  ["10:181", ["batch_compose", "delivering"], "ticket.rework", ["sample_making", "ad_prep"]],
  ["10:182", ["delivering"], "package.pushed", ["awaiting_launch"]],
  ["10:183", ["awaiting_launch"], "launch.changed", ["launch_verify"]],
  ["10:184", ["launch_verify"], "launch.changed", ["awaiting_launch"]],
  ["10:185", ["awaiting_launch", "launch_verify"], "launch.changed", ["in_service"]],
  ["10:186", ["in_service"], "usage.ended", ["takedown"]],
  ["10:187", ["awaiting_launch", "launch_verify"], "usage.ended", ["takedown"]],
  ["10:188", ["takedown"], "takedown.all_checked", ["archived"]],
  ["10:189", STEPS_1_TO_9, "ticket.hold", SAME, NO_GUARD],
  ["10:190", STEPS_1_TO_9, "ticket.resume", SAME],
  ["10:191", STEPS_1_TO_9, "ticket.terminate", ["terminated"]],
  ["10:192", ["in_service", "takedown"], "ticket.terminate", ["takedown"]],
  ["10:193", ["in_service"], "launch.verify_revoked", ["launch_verify"]],
  // 人工纠偏的更正白名单（D3 第 7.9 节；a05 第 3.26 节）：步骤 2～7 之间退到任一更靠前的步骤；
  // in_service → launch_verify；takedown → in_service。分组文档那一行只写“白名单内的步骤对”
  ["10:194", ["ad_prep"], "admin.force", ["plan_confirm"]],
  ["10:194", ["sample_making"], "admin.force", ["plan_confirm", "ad_prep"]],
  ["10:194", ["sample_confirm"], "admin.force", ["plan_confirm", "ad_prep", "sample_making"]],
  [
    "10:194",
    ["batch_compose"],
    "admin.force",
    ["plan_confirm", "ad_prep", "sample_making", "sample_confirm"],
  ],
  [
    "10:194",
    ["delivering"],
    "admin.force",
    ["plan_confirm", "ad_prep", "sample_making", "sample_confirm", "batch_compose"],
  ],
  ["10:194", ["in_service"], "admin.force", ["launch_verify"]],
  ["10:194", ["takedown"], "admin.force", ["in_service"]],
  ["10:195", ["awaiting_launch", "launch_verify", "in_service"], "reissue.opened", SAME],
  ["10:1377", DELIVERY_TICKET_STEP.values, "reissue.cancelled", SAME],
  ["10:195", ["awaiting_launch", "launch_verify", "in_service"], "package.reissued", SAME],
  ["10:1375", [...STEPS_1_TO_9, "in_service", "takedown"], "sla.recalculated", SAME],
]);

/** delivery_plan.status：docs/data-model/10-delivery.md */
export const deliveryPlan = chain("delivery_plan", "status", DELIVERY_PLAN_STATUS, [
  [
    "10:417",
    ["drafting", "revising", "pending_confirm", "confirmed"],
    "plan.push",
    ["pending_confirm"],
  ],
  ["10:418", ["pending_confirm"], "plan.confirm", ["confirmed"]],
  ["10:419", ["pending_confirm", "revising"], "plan.request_change", ["revising"]],
]);

/** sample.status：docs/data-model/10-delivery.md */
export const sample = chain("sample", "status", SAMPLE_STATUS, [
  ["10:640", null, "sample.uploaded", ["uploaded"]],
  ["10:641", ["uploaded"], "sample.check_rejected", ["check_rejected"]],
  ["10:642", ["uploaded"], "sample.qc_failed", ["qc_rejected"]],
  ["10:643", ["uploaded"], "sample.qc_passed", ["qc_passed"]],
  ["10:644", ["qc_passed"], "sample.pushed", ["pushed"]],
  ["10:645", ["pushed"], "sample.confirmed", ["confirmed"]],
  ["10:646", ["pushed"], "sample.change_requested", ["change_requested"]],
  ["10:647", ["pushed"], "sample.change_requested", ["superseded"]],
  ["10:648", ["uploaded", "qc_passed", "pushed"], "sample.superseded", ["superseded"]],
  ["10:649", ["confirmed"], "sample.superseded", ["superseded"]],
]);
