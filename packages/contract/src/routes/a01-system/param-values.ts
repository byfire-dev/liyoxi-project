// 后台：登录、员工、权限与系统 · param-values（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminParamValueList = adminMeta({
  method: "get",
  path: "/admin/param-values",
  operationId: "admin.paramValue.list",
  summary: "系统参数：分组、元数据（类型、范围、单位、默认值）、当前值与待生效值、最近保存人",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminParamValueReplace = adminMeta({
  method: "put",
  path: "/admin/param-values",
  operationId: "admin.paramValue.replace",
  summary: "整批保存参数（[{key, value, expectedRev, effectiveFrom?}]，整批乐观锁）",
  "x-permission": "sys.param.edit",
  "x-idempotent": "required",
});

export const adminParamValueWithdraw = adminMeta({
  method: "post",
  path: "/admin/param-values/{paramValueId}/withdraw",
  operationId: "admin.paramValue.withdraw",
  summary: "撤销一条尚未生效的预约参数值",
  "x-permission": "sys.param.edit",
  "x-idempotent": "required",
});
