// 电脑端下载页 · portal-tickets（docs/api/p01-portal.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { portalMeta } from "../meta-only.js";

export const portalPortalTicketCreate = portalMeta({
  method: "post",
  path: "/portal/portal-tickets",
  operationId: "portal.portalTicket.create",
  summary:
    "电脑端创建扫码登录票据，返回 portalTicketId（uuid）、qrUrl（二维码内容，由 public_id 拼成）、shortCode、pairDigits、pollSecret（只出现这一次）、expiresAt、pollIntervalMs，页面据此渲染二维码、两位配对数字与倒计时",
  "x-auth": "public",
  "x-idempotent": "none",
  "x-idempotent-reason":
    "匿名建下载页票据（A18；C47 点名 portal.portalTicket.create）：没有会话，幂等记录没有 actor_key；重复创建只多一张 120 秒的短时票据",
});

export const portalPortalTicketGet = portalMeta({
  method: "get",
  path: "/portal/portal-tickets/{portalTicketId}",
  operationId: "portal.portalTicket.get",
  summary:
    "轮询票据状态（pending / approved / rejected / expired / consumed），凭请求头 X-Poll-Secret，只返回状态",
  "x-auth": "public",
  "x-idempotent-reason": "GET，纯查询（A18）：不写库、不要求幂等键",
});

export const portalPortalTicketExchange = portalMeta({
  method: "post",
  path: "/portal/portal-tickets/{portalTicketId}/exchange",
  operationId: "portal.portalTicket.exchange",
  summary:
    "凭 pollSecret 换取下载页会话：票据置 consumed，同事务建 portal_session 并 Set-Cookie __Host-lyx_portal；确认后密钥不符、尝试达上限或超过 60 秒时票据置 rejected，返回 200 与 status = rejected（作废随事务提交，A101 同一做法）",
  "x-auth": "public",
  "x-idempotent": "none",
  "x-idempotent-reason":
    "登录与换会话（A18；C47 点名 portal.portalTicket.exchange）：匿名请求没有 actor_key，不经幂等记录；票据状态守卫与 uq_portal_session_portal_ticket_id 保证一张票据只换出一个会话",
});
