// 后台：商家、资质审核与素材复核 · qualification-docs（docs/api/a03-merchant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminRoute } from "../builders.js";
import { errorResponses, okResponse, IdSchema } from "../../common/index.js";
import { z } from "../../zod.js";
import {
  QualificationDocReviewBodySchema,
  QualificationSubmissionDetailSchema,
} from "./qualification.schemas.js";

export const adminQualificationDocUpdate = adminRoute({
  method: "patch",
  path: "/admin/qualification-docs/{qualificationDocId}",
  operationId: "admin.qualificationDoc.update",
  summary: "审核员修正识别字段并重跑系统比对（OCR 误识别时的出口）",
  "x-permission": "merchant.qualification.review",
  "x-idempotent": "required",
  request: {
    params: z.object({ qualificationDocId: IdSchema }),
    body: {
      content: { "application/json": { schema: QualificationDocReviewBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(QualificationSubmissionDetailSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
