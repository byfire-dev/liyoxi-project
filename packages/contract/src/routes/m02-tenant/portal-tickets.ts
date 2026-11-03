// 商家端：主体、门店与成员 · portal-tickets（docs/api/m02-tenant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { errorResponses, okResponse } from "../../common/index.js";
import { merchantRoute } from "../builders.js";
import { PortalTicketParamsSchema } from "../p01-portal/auth.schemas.js";
import {
  PortalLookupQuerySchema,
  PortalApproveBodySchema,
  PortalTicketPreviewSchema,
  PortalTicketDecisionSchema,
} from "./portal.schemas.js";

export const mPortalTicketLookup = merchantRoute({
  method: "get",
  path: "/m/portal-tickets/lookup",
  operationId: "m.portalTicket.lookup",
  summary:
    "扫码或手输代码后取下载页登录票据摘要（?code=）：浏览器、大致地区、发起时间、到期时间、三个候选配对数字、票据 id",
  "x-capability": "portal.authorize",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { query: PortalLookupQuerySchema },
  responses: { ...okResponse(PortalTicketPreviewSchema), ...errorResponses(400, 401, 403, 410) },
});

export const mPortalTicketApprove = merchantRoute({
  method: "post",
  path: "/m/portal-tickets/{portalTicketId}/approve",
  operationId: "m.portalTicket.approve",
  summary: "允许这台电脑下载本店成片：{pairDigits}；配对数字不一致则票据作废",
  "x-capability": "portal.authorize",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    params: PortalTicketParamsSchema,
    body: { required: true, content: { "application/json": { schema: PortalApproveBodySchema } } },
  },
  responses: { ...okResponse(PortalTicketDecisionSchema), ...errorResponses(400, 401, 403, 410) },
});

export const mPortalTicketReject = merchantRoute({
  method: "post",
  path: "/m/portal-tickets/{portalTicketId}/reject",
  operationId: "m.portalTicket.reject",
  summary: "拒绝下载页登录",
  "x-capability": "portal.authorize",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: { params: PortalTicketParamsSchema },
  responses: { ...okResponse(PortalTicketDecisionSchema), ...errorResponses(400, 401, 403, 410) },
});
