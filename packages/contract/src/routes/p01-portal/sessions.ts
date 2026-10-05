// 电脑端下载页 · sessions（docs/api/p01-portal.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { portalMeta } from "../meta-only.js";

export const portalSessionCurrentGet = portalMeta({
  method: "get",
  path: "/portal/sessions/current",
  operationId: "portal.session.current.get",
  summary:
    "当前下载页会话（GET /portal/sessions/current）：授权门店与主体名称、授权老板（脱敏）、能力点、到期时间；需要会话的页面加载时先调，401 时进入会话失效说明页",
  "x-auth": "portal",
  "x-idempotent-reason": "GET，纯查询（A18）：不写库、不要求幂等键",
});

export const portalSessionCurrentDelete = portalMeta({
  method: "delete",
  path: "/portal/sessions/current",
  operationId: "portal.session.current.delete",
  summary:
    "电脑端退出（DELETE /portal/sessions/current）：写 portal_session.revoked_at 与 revoke_reason = portal_logout，写 auth_event，清除 Cookie",
  "x-auth": "portal",
  "x-idempotent": "none",
  "x-idempotent-reason":
    "退出登录（A43；C47 的 none 白名单登记 portal.session.current.delete）：重复退出无副作用，端上把 401 当作已退出",
});
