// 后台：登录、员工、权限与系统 · staff（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";
import { adminRoute } from "../builders.js";
import {
  DictRefSchema,
  IdSchema,
  InstantSchema,
  PageQuerySchema,
  errorResponses,
  okResponse,
  openEnum,
  orNull,
} from "../../common/index.js";
import {
  ASSIGNMENT_POOL,
  ASSIGNMENT_HISTORY_SOURCE,
  ASSIGNMENT_HISTORY_SUBJECT_TYPE,
  STAFF_ACTIVATION_DELIVERY,
  STAFF_ACTIVATION_PURPOSE,
  STAFF_DISABLED_REASON,
  STAFF_ROLE_DATA_SCOPE,
  STAFF_ROLE_KEY,
  STAFF_STATUS,
  STAFF_WECOM_BIND_STATUS,
} from "../../enums/index.js";
import { z } from "../../zod.js";
import { StaffBriefSchema, adminPage } from "./structures.js";

const count = z.int().nonnegative();
const StaffGroupBriefSchema = z.object({ staffGroupId: IdSchema, name: z.string() });
export const PoolMemberSchema = z
  .object({
    pool: openEnum(ASSIGNMENT_POOL.values),
    staff: StaffBriefSchema,
    city: orNull(DictRefSchema),
    onDuty: z.boolean(),
    updatedAt: InstantSchema,
  })
  .openapi("PoolMember");
export type PoolMember = z.infer<typeof PoolMemberSchema>;
export const StaffListItemSchema = StaffBriefSchema.extend({
  phoneMask: orNull(z.string()),
  staffGroup: orNull(StaffGroupBriefSchema),
  dataScope: openEnum(STAFF_ROLE_DATA_SCOPE.values),
  wecomBindStatus: openEnum(STAFF_WECOM_BIND_STATUS.values),
  pools: z.array(openEnum(ASSIGNMENT_POOL.values)),
  lastLoginAt: orNull(InstantSchema),
  isActivated: z.boolean(),
  isLocked: z.boolean(),
  disabledReason: orNull(openEnum(STAFF_DISABLED_REASON.values)),
  handoverTo: orNull(StaffBriefSchema),
  openWorkCount: orNull(count),
  openWorkBySource: orNull(
    z.array(
      z.object({
        source: openEnum(ASSIGNMENT_HISTORY_SOURCE.values),
        subjectType: openEnum(ASSIGNMENT_HISTORY_SUBJECT_TYPE.values),
        count,
      }),
    ),
  ),
  onDuty: orNull(z.boolean()),
  isRecommended: z.boolean(),
  isSelf: z.boolean(),
  actions: z.array(
    openEnum([
      "update",
      "enable",
      "disable",
      "handover",
      "reset-password",
      "reset-mfa",
      "reissue-activation-code",
      "unlock",
      "invite-wecom",
      "bind-wecom",
    ]),
  ),
}).openapi("StaffListItem");
export type StaffListItem = z.infer<typeof StaffListItemSchema>;
export const StaffDetailSchema = StaffListItemSchema.extend({
  displayName: orNull(z.string()),
  servicePhone: orNull(z.string()),
  wecom: z.object({
    status: openEnum(STAFF_WECOM_BIND_STATUS.values),
    userid: orNull(z.string()),
    boundAt: orNull(InstantSchema),
    qrFileId: orNull(IdSchema),
    qrUrl: orNull(z.object({ url: z.url(), expiresAt: InstantSchema })),
  }),
  poolMemberships: z.array(PoolMemberSchema),
  security: z.object({
    isActivated: z.boolean(),
    totpEnrolledAt: orNull(InstantSchema),
    passwordChangedAt: orNull(InstantSchema),
    recoveryCodesLeft: count,
    lockedUntilTrusted: orNull(InstantSchema),
    lockedUntilUntrusted: orNull(InstantSchema),
    failTrusted: count,
    failUntrusted: count,
    lastLoginAt: orNull(InstantSchema),
    lastLoginIpMask: orNull(z.string()),
  }),
  pendingActivation: orNull(
    z.object({
      purpose: openEnum(STAFF_ACTIVATION_PURPOSE.values),
      delivery: openEnum(STAFF_ACTIVATION_DELIVERY.values),
      expiresAt: InstantSchema,
      attempts: count,
    }),
  ),
  disabledAt: orNull(InstantSchema),
  disabledBy: orNull(StaffBriefSchema),
  createdAt: InstantSchema,
  createdBy: orNull(StaffBriefSchema),
  updatedAt: InstantSchema,
  lockVersion: count,
}).openapi("StaffDetail");
export type StaffDetail = z.infer<typeof StaffDetailSchema>;
export const ActivationIssueSchema = z
  .object({
    purpose: openEnum(STAFF_ACTIVATION_PURPOSE.values),
    delivery: openEnum(STAFF_ACTIVATION_DELIVERY.values),
    expiresAt: InstantSchema,
    activationCode: orNull(z.string().regex(/^[A-Z0-9]{8}$/)),
    replayed: z.boolean(),
  })
  .openapi("ActivationIssue");
export type ActivationIssue = z.infer<typeof ActivationIssueSchema>;
export const StaffMutationResultSchema = z
  .object({
    staff: StaffDetailSchema,
    activation: orNull(ActivationIssueSchema),
    replayed: z.boolean(),
  })
  .openapi("StaffMutationResult");
export type StaffMutationResult = z.infer<typeof StaffMutationResultSchema>;
export const StaffCreateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(10),
    phone: z.string().regex(/^1\d{10}$/),
    roleKey: z.enum(STAFF_ROLE_KEY.values),
    isLead: z.boolean().default(false),
    staffGroupId: IdSchema.optional(),
    activateNow: z.boolean(),
    activationDelivery: z.enum(STAFF_ACTIVATION_DELIVERY.values).default("sms"),
    inviteWecom: z.boolean().default(false),
    displayName: z.string().max(10).optional(),
    servicePhone: z
      .string()
      .max(20)
      .regex(/^[\d-]*$/)
      .optional(),
  })
  .openapi("StaffCreateBody");
export type StaffCreateBody = z.infer<typeof StaffCreateBodySchema>;
const csvEnum = (values: readonly string[]) =>
  z.string().regex(new RegExp(`^(?:${values.join("|")})(?:,(?:${values.join("|")}))*$`));
const queryBool = z.stringbool({ truthy: ["true"], falsy: ["false"] }).openapi({ type: "boolean" });
export const StaffListQuerySchema = PageQuerySchema.extend({
  q: z.string().min(1).max(20).optional(),
  roleKey: csvEnum(STAFF_ROLE_KEY.values).optional(),
  status: csvEnum(STAFF_STATUS.values).optional(),
  isLead: queryBool.optional(),
  staffGroupId: IdSchema.optional(),
  pool: csvEnum(ASSIGNMENT_POOL.values).optional(),
  withLoad: queryBool.default(false),
  recommendPool: z.enum(ASSIGNMENT_POOL.values).optional(),
  recommendCityCode: z.string().min(1).optional(),
  sort: z.enum(["staffNo", "-lastLoginAt", "openWorkCount"]).default("staffNo"),
})
  .superRefine((query, ctx) => {
    if (query.withLoad && query.pageSize > 50)
      ctx.addIssue({ code: "custom", path: ["pageSize"], message: "计算在办量时每页最多 50 条" });
    if (query.sort === "openWorkCount" && !query.withLoad)
      ctx.addIssue({ code: "custom", path: ["sort"], message: "在办量排序需要 withLoad" });
    if (query.recommendPool === "delivery_manager" && query.recommendCityCode === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["recommendCityCode"],
        message: "交付经理推荐须带城市",
      });
  })
  .openapi("StaffListQuery");
export type StaffListQuery = z.infer<typeof StaffListQuerySchema>;

export const adminStaffList = adminRoute({
  method: "get",
  path: "/admin/staff",
  operationId: "admin.staff.list",
  summary:
    "员工列表与选人下拉：员工页按姓名、角色、状态筛选；选人模式按池给候选，标出轮询推荐与按来源的在办量",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { query: StaffListQuerySchema },
  responses: {
    ...okResponse(adminPage(StaffListItemSchema)),
    ...errorResponses(400, 401, 403, 429),
  },
});

export const adminStaffCreate = adminRoute({
  method: "post",
  path: "/admin/staff",
  operationId: "admin.staff.create",
  summary: "新增员工（立即启用或暂不启用），生成激活码并经短信下发",
  "x-permission": "sys.staff.manage",
  "x-idempotent": "required",
  "x-idempotent-reason": "结果脱敏（A80）：重放时激活码为 null 并带 replayed: true",
  "x-redact-on-replay": ["activation.activationCode"],
  request: {
    body: { required: true, content: { "application/json": { schema: StaffCreateBodySchema } } },
  },
  responses: {
    ...okResponse(StaffMutationResultSchema),
    ...errorResponses(400, 401, 403, 409, 429),
  },
});

export const adminStaffGet = adminRoute({
  method: "get",
  path: "/admin/staff/{staffId}",
  operationId: "admin.staff.get",
  summary: "员工详情（编辑弹层回显、所在分配池、企业微信绑定状态）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
  request: { params: z.object({ staffId: IdSchema }) },
  responses: { ...okResponse(StaffDetailSchema), ...errorResponses(401, 403, 404, 429) },
});

export const adminStaffUpdate = adminMeta({
  method: "patch",
  path: "/admin/staff/{staffId}",
  operationId: "admin.staff.update",
  summary: "编辑员工：姓名、角色、主管标记、分组（手机号不可改）",
  "x-permission": "sys.staff.manage",
  "x-idempotent": "required",
});

export const adminStaffBindWecom = adminMeta({
  method: "post",
  path: "/admin/staff/{staffId}/bind-wecom",
  operationId: "admin.staff.bindWecom",
  summary: "手工录入员工的企业微信 userid（兜底方式，V1.0 默认）",
  "x-permission": "sys.staff.wecom_bind",
  "x-idempotent": "required",
});

export const adminStaffDisable = adminMeta({
  method: "post",
  path: "/admin/staff/{staffId}/disable",
  operationId: "admin.staff.disable",
  summary: "禁用员工：在办事项移交给同角色启用员工，吊销会话，移出分配池",
  "x-permission": "sys.staff.secure_ops",
  "x-idempotent": "required",
});

export const adminStaffDutyUpdate = adminMeta({
  method: "patch",
  path: "/admin/staff/{staffId}/duty",
  operationId: "admin.staff.duty.update",
  summary: "切换客服“当班 / 接单中”开关",
  "x-permission": "assert-in-handler",
  "x-idempotent": "required",
});

export const adminStaffEnable = adminMeta({
  method: "post",
  path: "/admin/staff/{staffId}/enable",
  operationId: "admin.staff.enable",
  summary: "启用员工（待启用或已禁用），重置密码并下发激活码",
  "x-permission": "sys.staff.manage",
  "x-idempotent": "required",
  "x-idempotent-reason": "结果脱敏（A80）：重放时激活码为 null 并带 replayed: true",
});

export const adminStaffHandover = adminMeta({
  method: "post",
  path: "/admin/staff/{staffId}/handover",
  operationId: "admin.staff.handover",
  summary: "只移交在办事项、不禁用（调岗、长假）",
  "x-permission": "sys.staff.manage",
  "x-idempotent": "required",
});

export const adminStaffInviteWecom = adminMeta({
  method: "post",
  path: "/admin/staff/{staffId}/invite-wecom",
  operationId: "admin.staff.inviteWecom",
  summary: "发送企业微信绑定邀请（原型“邀请”按钮）",
  "x-permission": "sys.staff.wecom_bind",
  "x-idempotent": "required",
});

export const adminStaffOpenWorkGet = adminMeta({
  method: "get",
  path: "/admin/staff/{staffId}/open-work",
  operationId: "admin.staff.openWork.get",
  summary: "名下在办事项摘要（禁用、移交弹层用）：门店、工单、广告、客服工单、跟进待办",
  "x-permission": "sys.staff.manage",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminStaffPoolMembershipReplace = adminMeta({
  method: "put",
  path: "/admin/staff/{staffId}/pool-memberships",
  operationId: "admin.staff.poolMembership.replace",
  summary: "设置员工所在的分配池与城市（整体替换）",
  "x-permission": "sys.staff.manage",
  "x-idempotent": "required",
});

export const adminStaffReissueActivationCode = adminMeta({
  method: "post",
  path: "/admin/staff/{staffId}/reissue-activation-code",
  operationId: "admin.staff.reissueActivationCode",
  summary: "重新生成激活码（只返回这一次）",
  "x-permission": "sys.staff.manage",
  "x-idempotent": "required",
  "x-idempotent-reason": "结果脱敏（A80）：重放时激活码为 null 并带 replayed: true",
});

export const adminStaffResetMfa = adminMeta({
  method: "post",
  path: "/admin/staff/{staffId}/reset-mfa",
  operationId: "admin.staff.resetMfa",
  summary: "重置第二因子：清空动态口令与密码、吊销会话、下发新激活码",
  "x-permission": "sys.staff.secure_ops",
  "x-idempotent": "required",
  "x-idempotent-reason": "结果脱敏（A80）：重放时激活码为 null 并带 replayed: true",
});

export const adminStaffResetPassword = adminMeta({
  method: "post",
  path: "/admin/staff/{staffId}/reset-password",
  operationId: "admin.staff.resetPassword",
  summary: "重置登录密码：原密码与全部会话立即失效，下发重置码",
  "x-permission": "sys.staff.secure_ops",
  "x-idempotent": "required",
  "x-idempotent-reason": "结果脱敏（A80）：重放时激活码为 null 并带 replayed: true",
});

export const adminStaffUnlock = adminMeta({
  method: "post",
  path: "/admin/staff/{staffId}/unlock",
  operationId: "admin.staff.unlock",
  summary: "解除登录锁定",
  "x-permission": "sys.staff.manage",
  "x-idempotent": "required",
});

export const adminStaffSummary = adminMeta({
  method: "get",
  path: "/admin/staff/summary",
  operationId: "admin.staff.summary",
  summary: "员工计数：共 N 个账号 · 启用 · 待启用 · 已禁用（另给待激活、锁定人数）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});
