// 后台：内容运营与通知配置 · site-configs（docs/api/a09-ops.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  SiteConfigParamsSchema,
  SiteConfigViewSchema,
  SiteConfigDraftBodySchema,
  SiteConfigPublishBodySchema,
  SiteConfigRevisionsQuerySchema,
  SiteConfigRevisionsPageSchema,
} from "./site.schemas.js";

export const adminSiteConfigGet = adminRoute({
  method: "get",
  path: "/admin/site-configs/{configKey}",
  operationId: "admin.siteConfig.get",
  summary: "站点配置当前内容与草稿：首页推荐位（home_recommend）、商城配置（mall）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: SiteConfigParamsSchema },
  responses: { ...okResponse(SiteConfigViewSchema), ...errorResponses(400, 403, 404, 409) },
});

export const adminSiteConfigDraftReplace = adminRoute({
  method: "put",
  path: "/admin/site-configs/{configKey}/draft",
  operationId: "admin.siteConfig.draft.replace",
  summary: "保存站点配置草稿（整份覆盖，带 lockVersion）",
  "x-permission": null,
  "x-idempotent": "required",
  request: {
    params: SiteConfigParamsSchema,
    body: {
      content: { "application/json": { schema: SiteConfigDraftBodySchema } },
      required: true,
    },
  },
  responses: { ...okResponse(SiteConfigViewSchema), ...errorResponses(400, 403, 404, 409) },
});

export const adminSiteConfigPublish = adminRoute({
  method: "post",
  path: "/admin/site-configs/{configKey}/publish",
  operationId: "admin.siteConfig.publish",
  summary: "发布站点配置（base_rev_no 冲突返回 409；旧版本归档）",
  "x-permission": null,
  "x-idempotent": "required",
  request: {
    params: SiteConfigParamsSchema,
    body: {
      content: { "application/json": { schema: SiteConfigPublishBodySchema } },
      required: true,
    },
  },
  responses: { ...okResponse(SiteConfigViewSchema), ...errorResponses(400, 403, 404, 409) },
});

export const adminSiteConfigRevisionList = adminRoute({
  method: "get",
  path: "/admin/site-configs/{configKey}/revisions",
  operationId: "admin.siteConfig.revision.list",
  summary: "站点配置版本记录（发布时间、发布人）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: SiteConfigParamsSchema, query: SiteConfigRevisionsQuerySchema },
  responses: {
    ...okResponse(SiteConfigRevisionsPageSchema),
    ...errorResponses(400, 403, 404, 409),
  },
});
