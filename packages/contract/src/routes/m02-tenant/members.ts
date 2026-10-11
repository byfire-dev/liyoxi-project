// 商家端：主体、门店与成员 · members（docs/api/m02-tenant.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { errorResponses, okResponse } from "../../common/index.js";
import { merchantRoute } from "../builders.js";
import {
  MemberIdParamsSchema,
  MemberRemovalResultSchema,
  MemberListSchema,
  MemberItemSchema,
  MemberUpdateBodySchema,
} from "./tenant.schemas.js";

export const mMemberList = merchantRoute({
  method: "get",
  path: "/m/members",
  operationId: "m.member.list",
  summary:
    "当前门店的成员（姓名、角色、加入日期、上传数与被采用数、多门店提示）、待接受邀请（备注名、有效期）与名额；按角色裁剪",
  "x-capability": "member.list",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  responses: { ...okResponse(MemberListSchema), ...errorResponses(401, 403) },
});

export const mMemberUpdate = merchantRoute({
  method: "patch",
  path: "/m/members/{memberId}",
  operationId: "m.member.update",
  summary: "调整店员所属门店（全量替换，至少保留 1 家），立即生效并通知该成员",
  "x-capability": "member.manage",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    params: MemberIdParamsSchema,
    body: { required: true, content: { "application/json": { schema: MemberUpdateBodySchema } } },
  },
  responses: { ...okResponse(MemberItemSchema), ...errorResponses(400, 401, 403, 404, 409) },
});

export const mMemberRemove = merchantRoute({
  method: "post",
  path: "/m/members/{memberId}/remove",
  operationId: "m.member.remove",
  summary: "移除店员：解除全部门店关系、释放名额、通知；其上传的素材保留在门店素材库",
  "x-capability": "member.manage",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: { params: MemberIdParamsSchema },
  responses: {
    ...okResponse(MemberRemovalResultSchema),
    ...errorResponses(400, 401, 403, 404, 409),
  },
});
