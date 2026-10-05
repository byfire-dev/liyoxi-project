// 后台：登录、员工、权限与系统 · debug（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminDebugClientIpGet = adminMeta({
  method: "get",
  path: "/admin/debug/client-ip",
  operationId: "admin.debug.clientIp.get",
  summary: "部署核对：回显解析出的客户端 IP",
  "x-permission": "sys.super_admin",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
