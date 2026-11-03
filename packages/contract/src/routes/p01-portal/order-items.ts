// 电脑端下载页 · order-items（docs/api/p01-portal.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { portalRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  PublishListViewSchema,
  PublishListItemParamsSchema,
} from "../a06-publish/publish-list.schemas.js";
import {
  PortalOrderItemParamsSchema,
  PortalOrderItemListQuerySchema,
  PortalOrderItemPageSchema,
  PortalReleaseViewSchema,
  PortalDownloadBodySchema,
  PortalDownloadResultSchema,
} from "./download.schemas.js";

export const portalOrderItemList = portalRoute({
  method: "get",
  path: "/portal/order-items",
  operationId: "portal.orderItem.list",
  summary:
    "本门店名下有生效中成片包或有待预览样片的订购项（剧名、集数、总大小、授权到期时间、是否有变更的集、待确认样片）；查询参数 tab（all | downloadable | sample_pending）；按成片包与样片推送时间的较晚者倒序；游标分页",
  "x-auth": "portal",
  "x-capability": "delivery.download",
  "x-idempotent-reason": "GET，纯查询（A18）：不写库、不要求幂等键",
  request: { query: PortalOrderItemListQuerySchema },
  responses: { ...okResponse(PortalOrderItemPageSchema), ...errorResponses(400, 401, 403, 500) },
});

export const portalOrderItemDownloadUrls = portalRoute({
  method: "post",
  path: "/portal/order-items/{orderItemId}/download-urls",
  operationId: "portal.orderItem.downloadUrls",
  summary:
    "签发下载直链并留痕：kind = episode 取单集 15 分钟直链；kind = zip 触发或取 ZIP（就绪给 3 小时直链，未就绪返回打包中，失败后带 retry: true 才重打）；kind = publish_list 只查不建，ZIP 已就绪时取随 ZIP 生成的发布清单文件（15 分钟），否则返回当前打包状态、不触发打包",
  "x-auth": "portal",
  "x-capability": "delivery.download",
  "x-idempotent": "none",
  "x-idempotent-reason":
    "签发短时地址（A18；C47、C60）：每次签发都是一次真实访问、都要留痕；结果不进幂等记录，避免回放已过期的地址；ZIP 打包自身按 zip_gen 与 media_job.dedupe_key 去重（06-media.md:962-964）",
  request: {
    params: PortalOrderItemParamsSchema,
    body: { required: true, content: { "application/json": { schema: PortalDownloadBodySchema } } },
  },
  responses: {
    ...okResponse(PortalDownloadResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 429, 500),
  },
});

export const portalOrderItemPublishListGet = portalRoute({
  method: "get",
  path: "/portal/order-items/{orderItemId}/publish-list",
  operationId: "portal.orderItem.publishList.get",
  summary:
    "发布清单：合集名称、每集标题、话题、简介（生效成片包上的清单文本），供一键复制与生成文本文件",
  "x-auth": "portal",
  "x-capability": "delivery.download",
  "x-idempotent-reason": "GET，纯查询（A18）：不写库、不要求幂等键",
  request: { params: PublishListItemParamsSchema },
  responses: { ...okResponse(PublishListViewSchema), ...errorResponses(400, 401, 403, 404, 500) },
});

export const portalOrderItemReleaseGet = portalRoute({
  method: "get",
  path: "/portal/order-items/{orderItemId}/release",
  operationId: "portal.orderItem.release.get",
  summary:
    "成片下载页数据：当前成片包清单（集号、文件名、大小、相对上一包是否变更）、推送序号、下载授权状态与到期时间",
  "x-auth": "portal",
  "x-capability": "delivery.download",
  "x-idempotent-reason": "GET，纯查询（A18）：不写库、不要求幂等键",
  request: { params: PortalOrderItemParamsSchema },
  responses: { ...okResponse(PortalReleaseViewSchema), ...errorResponses(400, 401, 403, 404, 500) },
});
