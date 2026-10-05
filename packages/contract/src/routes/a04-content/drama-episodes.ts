// 后台：短剧库与积分价 · drama-episodes（docs/api/a04-content.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminDramaEpisodeUpdate = adminMeta({
  method: "patch",
  path: "/admin/drama-episodes/{dramaEpisodeId}",
  operationId: "admin.dramaEpisode.update",
  summary: "修改剧集标题",
  "x-permission": null,
  "x-idempotent": "required",
});
