// 后台：内容运营与通知配置 · home-banners（docs/api/a09-ops.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminHomeBannerList = adminMeta({
  method: "get",
  path: "/admin/home-banners",
  operationId: "admin.homeBanner.list",
  summary:
    "Banner 列表：标题、图片、跳转、时间窗、启用、点击数、派生状态（生效中、已排期、已结束、已停用）；可按是否已结束筛选",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminHomeBannerSummary = adminMeta({
  method: "get",
  path: "/admin/home-banners/summary",
  operationId: "admin.homeBanner.summary",
  summary:
    "Banner 计数与上限：生效中、已排期、已结束、已停用张数与同时生效上限（OpsHome 页头“生效中 N 张 · 最多 5 张”）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminHomeBannerCreate = adminMeta({
  method: "post",
  path: "/admin/home-banners",
  operationId: "admin.homeBanner.create",
  summary: "新增 Banner（任意时刻同时生效 ≤5 张，按区间重叠校验）",
  "x-permission": null,
  "x-idempotent": "required",
  "x-idempotent-reason":
    "结果脱敏（A80、C50）：x-redact-on-replay = imageUrl，同键重放时为 null 并带 replayed: true",
});

export const adminHomeBannerBatchReorder = adminMeta({
  method: "post",
  path: "/admin/home-banners/reorder",
  operationId: "admin.homeBanner.batchReorder",
  summary: "拖动调整轮播顺序（提交全部未结束 Banner 的 id 数组；已结束的不参与、position 不变）",
  "x-permission": null,
  "x-idempotent": "required",
  "x-idempotent-reason":
    "结果脱敏（A80、C50）：x-redact-on-replay = items[].imageUrl，同键重放时为 null 并带 replayed: true",
});

export const adminHomeBannerUpdate = adminMeta({
  method: "patch",
  path: "/admin/home-banners/{homeBannerId}",
  operationId: "admin.homeBanner.update",
  summary: "编辑 Banner，或启用 / 停用（已结束的不可切换）",
  "x-permission": null,
  "x-idempotent": "required",
  "x-idempotent-reason":
    "结果脱敏（A80、C50）：x-redact-on-replay = imageUrl，同键重放时为 null 并带 replayed: true",
});
