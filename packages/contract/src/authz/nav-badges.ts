// 后台菜单角标键（a02 第 5 节 NavBadgeKey）：带待办角标的二级菜单项，admin.navBadge.get 按它返回数量。
// 接口上是开放枚举（x-open-enum）：端上遇到不认识的键忽略。后台的菜单登记表引这里的类型（W1-02 替换）。
// 纯常量：本文件不引任何包。对账：src/authz/nav-badges.test.ts（与 a02 第 5 节那一行的取值、顺序相同）。
export const NAV_BADGE_KEYS = [
  "merchant.review",
  "order.receipts",
  "order.renewals",
  "delivery.tickets",
  "delivery.ad_tasks",
  "publish.deliveries",
  "publish.verify",
  "publish.accounts",
  "publish.offline",
  "publish.patrol",
  "service.tickets",
  "finance.refunds",
  "finance.credit_adjust",
  "finance.invoices",
  "finance.reconcile",
  // “我的待审批”页；“系统 › 流程运维”页
  "approval.mine",
  "system.flow_ops",
] as const;

/** 菜单角标键 */
export type NavBadgeKey = (typeof NAV_BADGE_KEYS)[number];

export function isNavBadgeKey(value: unknown): value is NavBadgeKey {
  return typeof value === "string" && (NAV_BADGE_KEYS as readonly string[]).includes(value);
}
