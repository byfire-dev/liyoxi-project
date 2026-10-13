// 商家端：门店档案、资质与素材 · store-profile（docs/api/m03-profile-asset.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { merchantMeta } from "../meta-only.js";
import { merchantRoute } from "../builders.js";
import { errorResponses, okResponse } from "../../common/index.js";
import {
  StoreProfileOverviewSchema,
  StoreProfileBasicSchema,
  StoreProfileBasicOwnerSchema,
  StoreProfileBasicPatchSchema,
  StoreProfileMediaSchema,
  StoreProfileMediaOwnerSchema,
  StoreProfileMediaPatchSchema,
  StoreProfileServiceSchema,
  StoreProfileServiceOwnerSchema,
  StoreProfileServicePatchSchema,
} from "./profile.schemas.js";
import { z } from "../../zod.js";
import {
  QualificationViewSchema,
  QualificationViewOwnerSchema,
  QualificationDraftPatchSchema,
  ContactPatchSchema,
  ContactViewSchema,
  QualificationSubmitBodySchema,
  QualificationDiscardBodySchema,
} from "./qualification.schemas.js";

export const mStoreProfileGet = merchantRoute({
  method: "get",
  path: "/m/store-profile",
  operationId: "m.storeProfile.get",
  summary:
    "建档首页聚合：完整度、四步摘要与状态、审核状态、主体名称、素材总数与近 7 天新增、成员摘要、广告三态计数；按角色裁剪",
  "x-capability": "store.profile.read",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  responses: {
    ...okResponse(StoreProfileOverviewSchema),
    ...errorResponses(400, 401, 403, 409, 503),
  },
});

export const mStoreProfileBasicGet = merchantRoute({
  method: "get",
  path: "/m/store-profile/basic",
  operationId: "m.storeProfile.basic.get",
  summary:
    "建档第 1 步：品牌名称与 Logo、门店名称、行业品类、地址与选点、营业时间、电话、人均、品牌简介；重审字段的生效值与待审值",
  "x-capability": "store.profile.read",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  responses: { ...okResponse(StoreProfileBasicSchema), ...errorResponses(400, 401, 403, 409, 503) },
});

export const mStoreProfileBasicUpdate = merchantRoute({
  method: "patch",
  path: "/m/store-profile/basic",
  operationId: "m.storeProfile.basic.update",
  summary:
    "保存第 1 步（只存草稿）：{draft, lockVersion, confirmReview?}；已通过门店改名称/地址/行业品类时先返回 409 REVIEW_REQUIRED，确认后重审字段写入 change 草稿；提交走 m.storeProfile.qualification.submit",
  "x-capability": "store.profile.edit",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  "x-three-phase": true,
  request: {
    body: {
      content: { "application/json": { schema: StoreProfileBasicPatchSchema } },
      required: true,
    },
  },
  "x-redact-on-replay": ["logo.url", "logo.expiresAt", "logo.coverUrl"],
  responses: {
    ...okResponse(StoreProfileBasicOwnerSchema.extend({ replayed: z.boolean() })),
    ...errorResponses(400, 401, 403, 409, 503),
  },
});

export const mStoreProfileContactUpdate = merchantRoute({
  method: "patch",
  path: "/m/store-profile/contact",
  operationId: "m.storeProfile.contact.update",
  summary:
    "保存资质联系人：{name, phoneSource: login | input, phone?, smsCode?, lockVersion}；改成非登录手机号须带短信验证码（短信未配置时记为未验证并提示审核人）",
  "x-capability": "store.qualification.edit",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  "x-three-phase": true,
  request: {
    body: { content: { "application/json": { schema: ContactPatchSchema } }, required: true },
  },
  responses: { ...okResponse(ContactViewSchema), ...errorResponses(400, 401, 403, 409, 503) },
});

export const mStoreProfileContactSmsCodeCreate = merchantMeta({
  method: "post",
  path: "/m/store-profile/contact/sms-codes",
  operationId: "m.storeProfile.contactSmsCode.create",
  summary:
    "资质联系人手机号发码：{phone}；号码是登录手机号时不发码（isLoginPhone）；否则发 6 位验证码，5 分钟有效",
  "x-capability": "store.qualification.edit",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  "x-idempotent-reason":
    "三段式（C51 先落库、提交后直发，A84）：先占用幂等记录，事务插入 sms_verification 并提交，事务外 notify.sendDirect，发送失败删行并释放占用",
});

export const mStoreProfileMediaGet = merchantRoute({
  method: "get",
  path: "/m/store-profile/media",
  operationId: "m.storeProfile.media.get",
  summary:
    "建档第 2 步：门头、店内环境、服务或产品实拍、已有宣传素材四组媒体（标签、类型、时长、顺序）",
  "x-capability": "store.profile.read",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  responses: { ...okResponse(StoreProfileMediaSchema), ...errorResponses(400, 401, 403, 409, 503) },
});

export const mStoreProfileMediaUpdate = merchantRoute({
  method: "patch",
  path: "/m/store-profile/media",
  operationId: "m.storeProfile.media.update",
  summary: "保存第 2 步（整步覆盖四组媒体的 fileId、标签、顺序；校验门头 ≥1、环境 ≥3）",
  "x-capability": "store.profile.edit",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    body: {
      content: { "application/json": { schema: StoreProfileMediaPatchSchema } },
      required: true,
    },
  },
  "x-redact-on-replay": [
    "groups.door[].file.url",
    "groups.door[].file.expiresAt",
    "groups.door[].file.coverUrl",
    "groups.interior[].file.url",
    "groups.interior[].file.expiresAt",
    "groups.interior[].file.coverUrl",
    "groups.product[].file.url",
    "groups.product[].file.expiresAt",
    "groups.product[].file.coverUrl",
    "groups.promo[].file.url",
    "groups.promo[].file.expiresAt",
    "groups.promo[].file.coverUrl",
  ],
  responses: {
    ...okResponse(StoreProfileMediaOwnerSchema.extend({ replayed: z.boolean() })),
    ...errorResponses(400, 401, 403, 409, 503),
  },
});

export const mStoreProfileQualificationGet = merchantRoute({
  method: "get",
  path: "/m/store-profile/qualification",
  operationId: "m.storeProfile.qualification.get",
  summary:
    "当前资质视图：草稿或在审轮次、主体类型、证照元数据与识别结果、生效证照、驳回原因与被驳回的证照、预计完成时间；老板视图另带资质联系人 contact {name, phoneMask, phoneVerifyState, phoneVerifiedAt} 与在审轮次的 contactSnapshot；店员只有状态",
  "x-capability": "store.profile.read",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  responses: { ...okResponse(QualificationViewSchema), ...errorResponses(400, 401, 403, 409, 503) },
});

export const mStoreProfileQualificationUpdate = merchantRoute({
  method: "patch",
  path: "/m/store-profile/qualification",
  operationId: "m.storeProfile.qualification.update",
  summary:
    "保存第 4 步草稿：主体类型（企业/个体工商户）、信息确认；没有草稿时建草稿轮次（ensureDraft）",
  "x-capability": "store.qualification.edit",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    body: {
      content: { "application/json": { schema: QualificationDraftPatchSchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(QualificationViewOwnerSchema),
    ...errorResponses(400, 401, 403, 409, 503),
  },
});

export const mStoreProfileQualificationDiscard = merchantRoute({
  method: "post",
  path: "/m/store-profile/qualification/discard",
  operationId: "m.storeProfile.qualification.discard",
  summary: "丢弃资质草稿（放弃变更）",
  "x-capability": "store.qualification.edit",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: QualificationDiscardBodySchema } },
    },
  },
  responses: {
    ...okResponse(QualificationViewOwnerSchema),
    ...errorResponses(400, 401, 403, 404, 409, 503),
  },
});

export const mStoreProfileQualificationSubmit = merchantRoute({
  method: "post",
  path: "/m/store-profile/qualification/submit",
  operationId: "m.storeProfile.qualification.submit",
  summary:
    "提交资质审核（首次、驳回后重新提交、已通过后的变更）：十项提交校验、建审批单、进入审核队列",
  "x-capability": "store.qualification.edit",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  request: {
    body: {
      content: { "application/json": { schema: QualificationSubmitBodySchema } },
      required: true,
    },
  },
  responses: {
    ...okResponse(QualificationViewOwnerSchema),
    ...errorResponses(400, 401, 403, 409, 503),
  },
});

export const mStoreProfileServiceGet = merchantRoute({
  method: "get",
  path: "/m/store-profile/service",
  operationId: "m.storeProfile.service.get",
  summary:
    "建档第 3 步：主推服务（名称、现价、原价、图片、简介）、优惠活动、团购信息、核心卖点与补充说明",
  "x-capability": "store.profile.read",
  "x-clerk-view": "trimmed",
  "x-idempotent-reason": "纯查询，GET 不写库（A18、A19）",
  responses: {
    ...okResponse(StoreProfileServiceSchema),
    ...errorResponses(400, 401, 403, 409, 503),
  },
});

export const mStoreProfileServiceUpdate = merchantRoute({
  method: "patch",
  path: "/m/store-profile/service",
  operationId: "m.storeProfile.service.update",
  summary: "保存第 3 步（整步覆盖，含主推服务数组 1～10 项、卖点标签 ≤5）",
  "x-capability": "store.profile.edit",
  "x-clerk-view": "none",
  "x-idempotent": "required",
  "x-three-phase": true,
  request: {
    body: {
      content: { "application/json": { schema: StoreProfileServicePatchSchema } },
      required: true,
    },
  },
  "x-redact-on-replay": [
    "serviceItems[].image.url",
    "serviceItems[].image.expiresAt",
    "serviceItems[].image.coverUrl",
  ],
  responses: {
    ...okResponse(StoreProfileServiceOwnerSchema.extend({ replayed: z.boolean() })),
    ...errorResponses(400, 401, 403, 409, 503),
  },
});
