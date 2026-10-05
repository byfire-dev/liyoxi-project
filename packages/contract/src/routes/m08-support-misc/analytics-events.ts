// 商家端：客服、消息与通用接口 · analytics-events（docs/api/m08-support-misc.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mAnalyticsEventBatchCreate = merchantMeta({
  method: "post",
  path: "/m/analytics-events",
  operationId: "m.analyticsEvent.batchCreate",
  summary:
    "埋点批量上报 {sentAt, anonymousId, sessionId, clientVersion, platform, scene?, events[1–50]: {eventId, name, occurredAt, storeId?, props}}；端上只报 app_launch、profile_step_save、store_switch、mall_view、trailer_play、drama_detail_view、share_click 与扩展事件 banner_click、playback_fallback、trailer_first_frame，各事件 props schema 见 m08 2.11",
  "x-auth": "optional",
  "x-clerk-view": "same",
  "x-idempotent": "none",
  "x-idempotent-reason":
    "埋点：事件按 event_id 在 analytics_event_dedup 去重，不经幂等记录（A18、C47）",
});
