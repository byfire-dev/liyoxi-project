// 后台：登录、员工、权限与系统 · roles（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminRoleList = adminMeta({
  method: "get",
  path: "/admin/roles",
  operationId: "admin.role.list",
  summary: "8 个内置角色：名称、职责、成员数、是否锁定、未保存标记由前端维护",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminRoleGet = adminMeta({
  method: "get",
  path: "/admin/roles/{roleKey}",
  operationId: "admin.role.get",
  summary: "角色详情：13 个模块等级、按角色预置的敏感权限点（含“仅主管”）、数据范围",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminRoleReplace = adminMeta({
  method: "put",
  path: "/admin/roles/{roleKey}",
  operationId: "admin.role.replace",
  summary: "保存角色权限（整体替换，带 lockVersion），员工刷新页面后生效",
  "x-permission": "sys.role.edit",
  "x-idempotent": "required",
});

export const adminRoleDefaultsGet = adminMeta({
  method: "get",
  path: "/admin/roles/{roleKey}/defaults",
  operationId: "admin.role.defaults.get",
  summary: "角色的代码默认配置（“恢复默认”回填用，保存后才生效）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
