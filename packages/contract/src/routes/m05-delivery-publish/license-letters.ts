// 商家端：交付与发布 · license-letters（docs/api/m05-delivery-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  LicenseLetterQuerySchema,
  LicenseLetterFilterSchema,
  LicenseLetterParamSchema,
  LicenseLetterPageSchema,
  LicenseLetterSummarySchema,
  LicenseLetterDetailSchema,
  LicenseLetterDownloadBodySchema,
  LicenseLetterDownloadUrlSchema,
} from "./license.schemas.js";

export const mLicenseLetterList = merchantRoute({
  method: "get",
  path: "/m/license-letters",
  operationId: "m.licenseLetter.list",
  summary:
    "定制内容授权书列表（?orderId=）：剧名、状态（待生效/生效中/已失效）、规格、授权期限、订单号、生成时间；按剧目 × 发布账号各 1 份",
  "x-capability": "contract.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { query: LicenseLetterQuerySchema },
  responses: {
    ...okResponse(LicenseLetterPageSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const mLicenseLetterSummary = merchantRoute({
  method: "get",
  path: "/m/license-letters/summary",
  operationId: "m.licenseLetter.summary",
  summary: "合同页“定制内容授权书 · N”的计数；查询参数同列表（除分页）",
  "x-capability": "contract.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { query: LicenseLetterFilterSchema },
  responses: {
    ...okResponse(LicenseLetterSummarySchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const mLicenseLetterGet = merchantRoute({
  method: "get",
  path: "/m/license-letters/{licenseLetterId}",
  operationId: "m.licenseLetter.get",
  summary:
    "授权书详情（预览）：授权方、被授权方、下单门店、剧名与集数、许可信息、授权平台与账号、授权期限、权利范围、专属声明、验真码",
  "x-capability": "contract.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  request: { params: LicenseLetterParamSchema },
  responses: {
    ...okResponse(LicenseLetterDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const mLicenseLetterDownloadUrls = merchantRoute({
  method: "post",
  path: "/m/license-letters/{licenseLetterId}/download-urls",
  operationId: "m.licenseLetter.downloadUrls",
  summary: "签发授权书 PDF 的 5 分钟读地址，每次写访问审计",
  "x-capability": "contract.read",
  "x-clerk-view": "none",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发短时地址，结果不进幂等记录，避免回放过期地址（A18、A19）",
  request: {
    params: LicenseLetterParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: LicenseLetterDownloadBodySchema } },
    },
  },
  responses: {
    ...okResponse(LicenseLetterDownloadUrlSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});
