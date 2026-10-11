// 商家端：主体、门店与成员 · invitations（docs/api/m02-tenant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";
import { merchantRoute } from "../builders.js";
import { errorResponses, okResponse } from "../../common/index.js";
import {
  InvitationCreateBodySchema,
  InvitationCardSchema,
  InvitationIdParamsSchema,
  InvitationMarkSharedResultSchema,
  InvitationRevokeBodySchema,
  InvitationRevokeResultSchema,
  InvitationLookupQuerySchema,
  InvitationPreviewSchema,
} from "./tenant.schemas.js";

export const mInvitationCreate = merchantRoute({
  method: "post",
  path: "/m/invitations",
  operationId: "m.invitation.create",
  summary:
    "预创建邀请：校验名额（含待接受）、生成一次性令牌、24 小时有效、占一个名额；未分享的卡片复用同一行并重置有效期",
  "x-capability": "member.manage",
  "x-clerk-view": "none",
  "x-idempotent": "natural",
  "x-idempotent-by": [
    "uq_invitation_inviter_member_id_client_request_id",
    "uq_invitation_request_inviter_client",
  ],
  "x-three-phase": true,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: InvitationCreateBodySchema } },
    },
  },
  responses: {
    ...okResponse(InvitationCardSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mInvitationLookup = merchantRoute({
  method: "get",
  path: "/m/invitations/lookup",
  operationId: "m.invitation.lookup",
  summary:
    "邀请落地页信息（?token=）：门店名、城市与品类、邀请人称呼、角色、有效期、状态（已使用、已撤回、已过期分别说明）、invitationId",
  "x-auth": "public",
  "x-clerk-view": "same",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  "x-rate-limit": "m.invitation",
  request: { query: InvitationLookupQuerySchema },
  responses: { ...okResponse(InvitationPreviewSchema), ...errorResponses(400, 404, 429) },
});

export const mInvitationAccept = merchantMeta({
  method: "post",
  path: "/m/invitations/{invitationId}/accept",
  operationId: "m.invitation.accept",
  summary:
    "接受邀请（请求体带 token）：校验令牌与状态、归属判定（空草稿主体让位）、建店员成员关系、通知老板",
  "x-auth": "user",
  "x-clerk-view": "same",
  "x-idempotent": "required",
});

export const mInvitationMarkShared = merchantRoute({
  method: "post",
  path: "/m/invitations/{invitationId}/mark-shared",
  operationId: "m.invitation.markShared",
  summary: "上报已分享（端上尽力上报，用于判断卡片能否复用）",
  "x-capability": "member.manage",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: { params: InvitationIdParamsSchema },
  responses: {
    ...okResponse(InvitationMarkSharedResultSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
});

export const mInvitationRevoke = merchantRoute({
  method: "post",
  path: "/m/invitations/{invitationId}/revoke",
  operationId: "m.invitation.revoke",
  summary: "撤回待接受的邀请（老板撤回；没分享就离开邀请页时端上尽力撤回），释放名额",
  "x-capability": "member.manage",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    params: InvitationIdParamsSchema,
    body: {
      required: true,
      content: { "application/json": { schema: InvitationRevokeBodySchema } },
    },
  },
  responses: {
    ...okResponse(InvitationRevokeResultSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
