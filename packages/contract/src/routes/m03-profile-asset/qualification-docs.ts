// 商家端：门店档案、资质与素材 · qualification-docs（docs/api/m03-profile-asset.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantRoute } from "../builders.js";
import { errorResponses, okResponse, IdSchema } from "../../common/index.js";
import { z } from "../../zod.js";
import { SignedUrlSchema } from "../a01-system/files.schemas.js";
import {
  QualificationDocCreateBodySchema,
  QualificationDocPatchSchema,
  QualificationDocRecognizedSchema,
  QualificationDocUpdateResultSchema,
  QualificationDocRemoveResultSchema,
} from "./qualification.schemas.js";

export const mQualificationDocCreate = merchantRoute({
  method: "post",
  path: "/m/qualification-docs",
  operationId: "m.qualificationDoc.create",
  summary:
    "证照挂到草稿并同步识别回显：{fileId, docType: business_license | branch_license | industry_permit, permitType?}；同类旧证照从草稿移除",
  "x-capability": "store.qualification.edit",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  "x-idempotent-reason":
    "三段式（C51 先调外部、再开事务；A139 已登记）：先占用幂等记录，事务外识别（复用 ocr_result），再开事务落证照行；结果脱敏（C50、A80）：幂等记录不存 recognized、submitted，重放时为空并带 replayed",
  request: {
    body: {
      content: { "application/json": { schema: QualificationDocCreateBodySchema } },
      required: true,
    },
  },
  "x-three-phase": true,
  "x-redact-on-replay": ["recognized", "submitted"],
  responses: {
    ...okResponse(QualificationDocRecognizedSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mQualificationDocUpdate = merchantRoute({
  method: "patch",
  path: "/m/qualification-docs/{qualificationDocId}",
  operationId: "m.qualificationDoc.update",
  summary: "保存核对后的证照提交值（识别有误时人工修正）",
  "x-capability": "store.qualification.edit",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    params: z.object({ qualificationDocId: IdSchema }),
    body: {
      content: { "application/json": { schema: QualificationDocPatchSchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(QualificationDocUpdateResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mQualificationDocDownloadUrls = merchantRoute({
  method: "post",
  path: "/m/qualification-docs/{qualificationDocId}/download-urls",
  operationId: "m.qualificationDoc.downloadUrls",
  summary: "签发证照图片的 5 分钟读地址（本门店草稿、在审或生效证照），每次写访问审计",
  "x-capability": "store.qualification.edit",
  "x-clerk-view": "none",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发短时地址，结果不进幂等记录，避免回放过期地址（A18、A19）",
  request: {
    params: z.object({ qualificationDocId: IdSchema }),
    body: { required: true, content: { "application/json": { schema: z.strictObject({}) } } },
  },
  responses: { ...okResponse(SignedUrlSchema), ...errorResponses(400, 401, 403, 404, 409, 503) },
});

export const mQualificationDocRemove = merchantRoute({
  method: "post",
  path: "/m/qualification-docs/{qualificationDocId}/remove",
  operationId: "m.qualificationDoc.remove",
  summary: "从草稿移除证照（释放文件引用，保留 7 天）",
  "x-capability": "store.qualification.edit",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: { params: z.object({ qualificationDocId: IdSchema }) },
  responses: {
    ...okResponse(QualificationDocRemoveResultSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});
