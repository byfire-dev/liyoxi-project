// 后台：内容运营与通知配置 · sms-templates（docs/api/a09-ops.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminSmsTemplateList = adminMeta({
  method: "get",
  path: "/admin/sms-templates",
  operationId: "admin.smsTemplate.list",
  summary:
    "短信模板：消息模板页的短信页签与通道配置页共用（模板编号、签名、状态、用途、触发时机、近 7 天发送、示例预览）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminSmsTemplateSummary = adminMeta({
  method: "get",
  path: "/admin/sms-templates/summary",
  operationId: "admin.smsTemplate.summary",
  summary: "短信页签计数（OpsTemplates“短信 N”），另带按状态的计数",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminSmsTemplateUpdate = adminMeta({
  method: "patch",
  path: "/admin/sms-templates/{templateKey}",
  operationId: "admin.smsTemplate.update",
  summary: "绑定短信模板编号与签名，启停模板（验证码类不可停用）",
  "x-permission": "sys.super_admin",
  "x-idempotent": "required",
});

export const adminSmsTemplateTestSend = adminMeta({
  method: "post",
  path: "/admin/sms-templates/{templateKey}/test-send",
  operationId: "admin.smsTemplate.testSend",
  summary:
    "按模板测试发送短信到当前员工在参数 notify.test_recipients 里登记的手机号（直发，用模板示例参数；含只用于直发的验证码类模板）",
  "x-permission": null,
  "x-idempotent": "required",
  "x-idempotent-reason": "对外发送（A17）；C51 三段式，先落库",
});
