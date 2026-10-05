// 商家端：交付与发布 · samples（docs/api/m05-delivery-publish.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mSampleConfirm = merchantMeta({
  method: "post",
  path: "/m/samples/{sampleId}/confirm",
  operationId: "m.sample.confirm",
  summary: "确认样片 {versionNo, viewedVia, hasViewed}，推进到批量合成",
  "x-capability": "delivery.confirm_sample",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});

export const mSampleDownloadUrls = merchantMeta({
  method: "post",
  path: "/m/samples/{sampleId}/download-urls",
  operationId: "m.sample.downloadUrls",
  summary:
    "签发水印版样片的 15 分钟直链（保存到相册查看）；每次写访问审计，首次访问回写 sample.first_viewed_at",
  "x-capability": "delivery.confirm_sample",
  "x-clerk-view": "none",
  "x-idempotent": "none",
  "x-idempotent-reason": "签发短时地址，结果不进幂等记录，避免回放过期地址（A18、A19）",
});

export const mSampleRequestChange = merchantMeta({
  method: "post",
  path: "/m/samples/{sampleId}/request-change",
  operationId: "m.sample.requestChange",
  summary: "对样片提出修改意见（合成问题）：{feedbackKind: 'compose', note, imageFileIds?}",
  "x-capability": "delivery.confirm_sample",
  "x-clerk-view": "none",
  "x-idempotent": "required",
});
