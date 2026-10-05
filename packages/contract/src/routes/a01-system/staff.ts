// 后台：登录、员工、权限与系统 · staff（docs/api/a01-system.md）。由 routemap.json 接管（W0-10），之后以本文件为准：
// 改接口同 PR 改 routemap.json 与分组文档，pnpm contract:docs-check 对账。归属的里程碑在 ../milestones.ts。
import { adminMeta } from "../meta-only.js";

export const adminStaffList = adminMeta({
  method: "get",
  path: "/admin/staff",
  operationId: "admin.staff.list",
  summary:
    "员工列表与选人下拉：员工页按姓名、角色、状态筛选；选人模式按池给候选，标出轮询推荐与按来源的在办量",
  "x-permission": "assert-in-handler",
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
});

export const adminStaffCreate = adminMeta({
  method: "post",
  path: "/admin/staff",
  operationId: "admin.staff.create",
  summary: "新增员工（立即启用或暂不启用），生成激活码并经短信下发",
  "x-permission": "sys.staff.manage",
  "x-idempotent": "required",
  "x-idempotent-reason": "结果脱敏（A80）：重放时激活码为 null 并带 replayed: true",
});

export const adminStaffGet = adminMeta({
  method: "get",
  path: "/admin/staff/{staffId}",
  operationId: "admin.staff.get",
  summary: "员工详情（编辑弹层回显、所在分配池、企业微信绑定状态）",
  "x-permission": null,
  "x-idempotent-reason": "纯查询（GET 不写库，A19）",
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
