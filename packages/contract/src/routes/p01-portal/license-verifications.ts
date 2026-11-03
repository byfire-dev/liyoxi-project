// 电脑端下载页 · license-verifications（docs/api/p01-portal.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { errorResponses, okResponse } from "../../common/index.js";
import { portalRoute } from "../builders.js";
import {
  LicenseVerificationQuerySchema,
  LicenseVerificationViewSchema,
} from "./license-verification.schemas.js";

export const portalLicenseVerificationGet = portalRoute({
  method: "get",
  path: "/portal/license-verifications",
  operationId: "portal.licenseVerification.get",
  summary:
    "授权书验真：按查询参数 code（验真码）与可选的 revNo（二维码里的版次）返回编号、版次、显示状态、授权方、被授权方（脱敏）、剧名、平台与账号、期限、内容指纹、当前版文件 SHA-256、签署方式与证书序列号，以及扫的那一版是否为当前版次",
  "x-auth": "public",
  request: { query: LicenseVerificationQuerySchema },
  responses: { ...okResponse(LicenseVerificationViewSchema), ...errorResponses(400, 404, 429) },
  "x-idempotent-reason": "GET，纯查询（A18）：不写库、不要求幂等键",
});
