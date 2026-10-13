// 商家端：账号与登录 · sms-codes（docs/api/m01-account.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { errorResponses, okResponse } from "../../common/index.js";
import { merchantRoute } from "../builders.js";
import { SmsCodeCreateBodySchema, SmsCodeResultSchema } from "./account.schemas.js";

export const mSmsCodeCreate = merchantRoute({
  method: "post",
  path: "/m/sms-codes",
  operationId: "m.smsCode.create",
  summary: "发送换绑手机号的短信验证码：purpose=phone_change，发到账号当前手机号",
  "x-auth": "user",
  "x-capability": "me.*",
  "x-clerk-view": "same",
  "x-idempotent": "required",
  "x-three-phase": true,
  request: {
    body: { required: true, content: { "application/json": { schema: SmsCodeCreateBodySchema } } },
  },
  responses: {
    ...okResponse(SmsCodeResultSchema),
    ...errorResponses(400, 401, 403, 409, 426, 428, 429, 503),
  },
});
