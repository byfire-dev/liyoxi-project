// 后台：内容运营与通知配置 · site-notices（docs/api/a09-ops.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import { SiteNoticeQuerySchema, SiteNoticePageSchema } from "./site.schemas.js";

export const adminSiteNoticeList = adminRoute({
  method: "get",
  path: "/admin/site-notices",
  operationId: "admin.siteNotice.list",
  summary: "规则变更公告记录（套餐调整、计费参数、协议版本触发；只读）",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: SiteNoticeQuerySchema },
  responses: { ...okResponse(SiteNoticePageSchema), ...errorResponses(400, 403) },
});
