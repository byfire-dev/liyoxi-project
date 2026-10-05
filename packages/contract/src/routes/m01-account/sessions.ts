// 商家端：账号与登录 · sessions（docs/api/m01-account.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";

export const mSessionCreate = merchantMeta({
  method: "post",
  path: "/m/sessions",
  operationId: "m.session.create",
  summary:
    "静默登录：wx.login 的 loginCode 换会话；微信身份已绑定且允许静默登录时返回令牌与 me，否则返回 needPhone 保持游客态",
  "x-auth": "public",
  "x-clerk-view": "same",
  "x-idempotent": "none",
  "x-idempotent-reason": "登录与换会话（A18）",
});

export const mSessionCurrentDelete = merchantMeta({
  method: "delete",
  path: "/m/sessions/current",
  operationId: "m.session.current.delete",
  summary: "退出登录：吊销当前会话并关闭该微信身份的静默登录",
  "x-auth": "user",
  "x-clerk-view": "same",
  "x-idempotent": "none",
  "x-idempotent-reason": "退出登录；端上把 401 当作已退出（A43）",
});

export const mSessionPhoneLogin = merchantMeta({
  method: "post",
  path: "/m/sessions/phone-login",
  operationId: "m.session.phoneLogin",
  summary:
    "手机号快捷登录/注册：{loginCode, phoneCode, consents, attribution}；首次登录建账号、记协议同意与来源；可能返回 REVERIFY_REQUIRED、switchedFrom",
  "x-auth": "public",
  "x-clerk-view": "same",
  "x-idempotent": "none",
  "x-idempotent-reason": "登录与换会话（A18）",
});
