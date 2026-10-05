// 商家端：账号与登录 · agreement-consents（docs/api/m01-account.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mAgreementConsentList = merchantMeta({
  method: "get",
  path: "/m/agreement-consents",
  operationId: "m.agreementConsent.list",
  summary: "已签署协议：协议名、版本、生效日期、最近确认时间与场景、首次签署时间与场景、关联单据",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});

export const mAgreementConsentCreate = merchantMeta({
  method: "post",
  path: "/m/agreement-consents",
  operationId: "m.agreementConsent.create",
  summary: "提交协议同意（登录后协议更新需要重新同意时）；交易类同意不走本接口",
  "x-auth": "user",
  "x-clerk-view": "same",
  "x-idempotent": "natural",
  "x-idempotent-by": ["uq_agreement_consent_no_biz"],
});

export const mAgreementConsentSummary = merchantMeta({
  method: "get",
  path: "/m/agreement-consents/summary",
  operationId: "m.agreementConsent.summary",
  summary: "合同页“协议 · N”的计数；查询参数同列表（除分页）",
  "x-capability": "contract.read",
  "x-clerk-view": "none",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
});
