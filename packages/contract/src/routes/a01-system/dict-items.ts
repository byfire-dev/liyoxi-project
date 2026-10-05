// 后台：登录、员工、权限与系统 · dict-items（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminDictItemList = adminMeta({
  method: "get",
  path: "/admin/dict-items",
  operationId: "admin.dictItem.list",
  summary: "字典项：按类型查询（树形，可带引用计数）；后台各处下拉与原因单选共用",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminDictItemCreate = adminMeta({
  method: "post",
  path: "/admin/dict-items",
  operationId: "admin.dictItem.create",
  summary: "新增字典项（编码由系统按顺序生成，保存后不可改；同级不重名）",
  "x-permission": "sys.dict.edit",
  "x-idempotent": "required",
});

export const adminDictItemUpdate = adminMeta({
  method: "patch",
  path: "/admin/dict-items/{dictItemId}",
  operationId: "admin.dictItem.update",
  summary: "修改字典项名称、说明，或启用 / 停用",
  "x-permission": "sys.dict.edit",
  "x-idempotent": "required",
});
