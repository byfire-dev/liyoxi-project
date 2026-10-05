// 后台：内容运营与通知配置 · agreement-consents（docs/api/a09-ops.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminAgreementConsentList = adminMeta({
  method: "get",
  path: "/admin/agreement-consents",
  operationId: "admin.agreementConsent.list",
  summary:
    "同意记录检索：按协议、版本、商家用户、主体或门店、场景、关联单据（bizType + bizId，或单号）、时间范围（手机号只回脱敏值）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminAgreementConsentGet = adminMeta({
  method: "get",
  path: "/admin/agreement-consents/{agreementConsentId}",
  operationId: "admin.agreementConsent.get",
  summary: "同意记录证据详情（手机号、信用代码只回脱敏值）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
