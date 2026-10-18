import { PendingConsentSchema } from "../../common/pending-consent.js";
// 商家端：账号与登录 · 当前账号、登录与本人安全结构（docs/api/m01-account.md 第 2、3.1–3.5、3.8–3.10 节）。
// PendingConsent 引 common；ConsentInput、DeviceInfo 引 agreement.schemas.ts 的，EntityBrief 引 m02 的（约定 C87），不另写一份。
// 老板与店员同一结构（clerkView = same）：手机号只出脱敏串（约定 C40、C57 放行 Mask 结尾的键）。
import {
  CursorQuerySchema,
  IdSchema,
  InstantSchema,
  cursorPage,
  openEnum,
  orNull,
} from "../../common/index.js";
import {
  MERCHANT_ROLE,
  MERCHANT_USER_NOTICE_KIND,
  QUALIFICATION_STATUS,
  STORE_LIFECYCLE,
} from "../../enums/index.js";
import { z } from "../../zod.js";
import { EntityBriefSchema } from "../m02-tenant/tenant.schemas.js";

import { ConsentInputSchema, DeviceInfoSchema } from "./agreement.schemas.js";

// ---------- 2.2 MeUser ----------

/** 账号当前可执行的动作（约定 C16）：change-phone 只在短信通道已配置时出现 */
export const ME_USER_ACTIONS = ["update", "change-phone", "deletion"] as const;
export type MeUserAction = (typeof ME_USER_ACTIONS)[number];

export const MeUserSchema = z
  .object({
    merchantUserId: IdSchema,
    displayName: orNull(z.string()),
    phoneMask: z.string(),
    registeredAt: InstantSchema,
    actions: z.array(z.enum(ME_USER_ACTIONS)),
  })
  .openapi("MeUser");
export type MeUser = z.infer<typeof MeUserSchema>;

export const SmsCodeCreateBodySchema = z.strictObject({ purpose: z.literal("phone_change") });
export const SmsCodeResultSchema = z
  .strictObject({
    purpose: z.literal("phone_change"),
    targetPhoneMask: z.string(),
    expiresAt: InstantSchema,
    resendAfterSec: z.int().nonnegative(),
  })
  .openapi("SmsCodeResult");
export type SmsCodeResult = z.infer<typeof SmsCodeResultSchema>;
export const DeletionBodySchema = z.strictObject({ hasConfirmed: z.literal(true) });
export const DeletionResultSchema = z
  .strictObject({ deletedAt: InstantSchema })
  .openapi("DeletionResult");
export const DeletionBlockerSchema = z
  .strictObject({
    kind: z.enum([
      "subscription_active",
      "payment_open",
      "refund_open",
      "invoice_open",
      "open_order",
      "release_online",
    ]),
    count: z.int().positive(),
  })
  .openapi("DeletionBlocker");
export const MeChangePhoneBodySchema = z.strictObject({
  oldSmsCode: z.string().regex(/^\d{4,8}$/),
  newPhoneCode: z.string().min(1).max(128),
});

// ---------- 2.3、2.4 成员关系概要 ----------

export const MembershipStoreSchema = z
  .object({
    storeId: IdSchema,
    name: orNull(z.string()),
    isPrimary: z.boolean(),
    lifecycle: openEnum(STORE_LIFECYCLE.values),
    qualificationStatus: openEnum(QUALIFICATION_STATUS.values),
  })
  .openapi("MembershipStore");
export type MembershipStore = z.infer<typeof MembershipStoreSchema>;

export const MembershipBriefSchema = z
  .object({
    memberId: IdSchema,
    role: openEnum(MERCHANT_ROLE.values),
    memberDisplayName: orNull(z.string()),
    joinedAt: InstantSchema,
    /** 上次选择的门店；没有记录或它已不在本条 stores 里时为 null */
    lastStoreId: orNull(IdSchema),
    entity: EntityBriefSchema,
    stores: z.array(MembershipStoreSchema),
  })
  .openapi("MembershipBrief");
export type MembershipBrief = z.infer<typeof MembershipBriefSchema>;

// ---------- 2.6 一次性提示 ----------

export const UserNoticeSchema = z
  .object({
    userNoticeId: IdSchema,
    kind: openEnum(MERCHANT_USER_NOTICE_KIND.values),
    occurredAt: InstantSchema,
    /** 服务端按 kind 与发生时间（北京时间）拼出的文案；库里不存 */
    message: z.string(),
  })
  .openapi("UserNotice");
export type UserNotice = z.infer<typeof UserNoticeSchema>;

// ---------- 2.11 本人账号安全 ----------

export const UserNoticeAckResultSchema = z
  .object({ userNoticeId: IdSchema, ackedAt: InstantSchema })
  .openapi("UserNoticeAckResult");
export type UserNoticeAckResult = z.infer<typeof UserNoticeAckResultSchema>;

export const WECHAT_IDENTITY_ACTIONS = ["delete"] as const;
export type WechatIdentityAction = (typeof WECHAT_IDENTITY_ACTIONS)[number];

export const WechatIdentityItemSchema = z
  .object({
    wechatIdentityId: IdSchema,
    boundAt: InstantSchema,
    lastLoginAt: InstantSchema,
    deviceSummary: orNull(z.string()),
    isCurrent: z.boolean(),
    actions: z.array(z.enum(WECHAT_IDENTITY_ACTIONS)),
  })
  .openapi("WechatIdentityItem");
export type WechatIdentityItem = z.infer<typeof WechatIdentityItemSchema>;

export const WechatIdentityListSchema =
  cursorPage(WechatIdentityItemSchema).openapi("WechatIdentityList");
export type WechatIdentityList = z.infer<typeof WechatIdentityListSchema>;

export const WechatIdentityRemoveResultSchema = z
  .object({
    wechatIdentityId: IdSchema,
    revokedSessionCount: z.int().nonnegative(),
    isCurrentSessionRevoked: z.boolean(),
  })
  .openapi("WechatIdentityRemoveResult");
export type WechatIdentityRemoveResult = z.infer<typeof WechatIdentityRemoveResultSchema>;

// ---------- 2.1 MeView ----------

export const MeViewSchema = z
  .object({
    user: MeUserSchema,
    /** V1.0 至多 1 条 */
    memberships: z.array(MembershipBriefSchema),
    pendingConsents: z.array(PendingConsentSchema),
    notices: z.array(UserNoticeSchema),
  })
  .openapi("MeView");
export type MeView = z.infer<typeof MeViewSchema>;

// ---------- 3.5、3.8–3.10 本人账号请求 ----------

export const MeUpdateBodySchema = z.object({
  displayName: z
    .string()
    .trim()
    .refine((value) => [...value].length >= 1 && [...value].length <= 20, "称呼须为 1 至 20 字")
    .openapi({ minLength: 1, maxLength: 20 }),
});
export type MeUpdateBody = z.infer<typeof MeUpdateBodySchema>;

export const UserNoticeAcknowledgeParamsSchema = z.object({ userNoticeId: IdSchema });
export type UserNoticeAcknowledgeParams = z.infer<typeof UserNoticeAcknowledgeParamsSchema>;

export const WechatIdentityListQuerySchema = CursorQuerySchema;
export type WechatIdentityListQuery = z.infer<typeof WechatIdentityListQuerySchema>;

export const WechatIdentityRemoveParamsSchema = z.object({ wechatIdentityId: IdSchema });
export type WechatIdentityRemoveParams = z.infer<typeof WechatIdentityRemoveParamsSchema>;

// ---------- 2.7 首触来源 ----------

/** 端上不自报来源类型：两个码由服务端转大写后查登记表判定 */
export const AttributionSchema = z
  .object({
    channelCode: z.string().max(32).optional(),
    inviteCode: z.string().max(32).optional(),
    scene: z.int().optional(),
  })
  .openapi("Attribution");
export type Attribution = z.infer<typeof AttributionSchema>;

// ---------- 3.1、3.2 请求体 ----------

const LoginCodeSchema = z.string().min(1).max(128);

export const SessionCreateBodySchema = z.object({
  loginCode: LoginCodeSchema,
  device: DeviceInfoSchema.optional(),
});
export type SessionCreateBody = z.infer<typeof SessionCreateBodySchema>;

/** 手机号登录写同意记录的场景：agreement_consent.scene 的子集 */
export const PHONE_LOGIN_CONSENT_SCENES = ["login", "member_join"] as const;
export type PhoneLoginConsentScene = (typeof PHONE_LOGIN_CONSENT_SCENES)[number];

export const PhoneLoginBodySchema = z.object({
  loginCode: LoginCodeSchema,
  phoneCode: LoginCodeSchema,
  consents: z.array(ConsentInputSchema).min(1).max(2),
  consentScene: z.enum(PHONE_LOGIN_CONSENT_SCENES).optional(),
  attribution: AttributionSchema.optional(),
  device: DeviceInfoSchema.optional(),
});
export type PhoneLoginBody = z.infer<typeof PhoneLoginBodySchema>;

// ---------- 2.8 登录结果 ----------

/** 会话令牌：lyxm_<sid>.<32 字节随机数的 base64url>（约定 C3）。库里只存随机部分的 sha256 */
export const SessionTokenSchema = z.string().regex(/^lyxm_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/);

/** needPhone = true 时 token 与 me 都是 null：不能静默登录，保持游客态 */
export const SilentLoginResultSchema = z
  .object({
    needPhone: z.boolean(),
    token: orNull(SessionTokenSchema),
    me: orNull(MeViewSchema),
  })
  .openapi("SilentLoginResult");
export type SilentLoginResult = z.infer<typeof SilentLoginResultSchema>;

export const PhoneLoginResultSchema = z
  .object({
    token: SessionTokenSchema,
    me: MeViewSchema,
    isNewUser: z.boolean(),
    /** 本微信此前登录的是另一个有成员关系的账号、这次被改绑过来时给出原账号的脱敏手机号 */
    switchedFrom: orNull(z.object({ phoneMask: z.string() })),
  })
  .openapi("PhoneLoginResult");
export type PhoneLoginResult = z.infer<typeof PhoneLoginResultSchema>;
