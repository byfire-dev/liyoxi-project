// 后台：订购、取消、交付与广告任务 · license-letters（docs/api/a05-order-delivery.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { okResponse, errorResponses } from "../../common/index.js";
import {
  LicenseLetterParamSchema,
  LicenseLetterCorrectBodySchema,
  AdminLicenseLetterViewSchema,
  LicenseLetterVoidBodySchema,
  LicenseLetterVoidResultSchema,
} from "../m05-delivery-publish/license.schemas.js";

export const adminLicenseLetterCorrect = adminRoute({
  method: "post",
  path: "/admin/license-letters/{licenseLetterId}/correct",
  operationId: "admin.licenseLetter.correct",
  summary: "授权书更正并重出（主体更名、账号名笔误；编号不变，出 correction 版次）",
  "x-permission": "order.license_letter.manage",
  "x-idempotent": "required",
  request: {
    params: LicenseLetterParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: LicenseLetterCorrectBodySchema } },
    },
  },
  responses: {
    ...okResponse(AdminLicenseLetterViewSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});

export const adminLicenseLetterVoid = adminRoute({
  method: "post",
  path: "/admin/license-letters/{licenseLetterId}/void",
  operationId: "admin.licenseLetter.void",
  summary: "人工作废授权书并按当前事实重出新信（原因必填）",
  "x-permission": "order.license_letter.manage",
  "x-idempotent": "required",
  request: {
    params: LicenseLetterParamSchema,
    body: {
      required: true,
      content: { "application/json": { schema: LicenseLetterVoidBodySchema } },
    },
  },
  responses: {
    ...okResponse(LicenseLetterVoidResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 500),
  },
});
