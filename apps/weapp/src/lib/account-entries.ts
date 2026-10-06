import { WEAPP_PAGES } from "../pages";

const ENTRIES = [
  { route: "sub/profile/profile/index", title: "门店档案", owner: true },
  { route: "sub/order/orders/index", title: "订单", owner: true },
  { route: "sub/publish/tasks/index", title: "发布任务", owner: true },
  { route: "sub/publish/accounts/index", title: "发布账号", owner: true },
  { route: "sub/asset/lib/index", title: "素材库", owner: false },
  { route: "sub/profile/staff-profile/index", title: "我的资料", owner: false },
  { route: "sub/member/members/index", title: "成员", owner: true },
  { route: "sub/service/messages/index", title: "消息", owner: false },
  { route: "sub/service/settings/index", title: "设置", owner: false },
] as const;

export const accountPageImplemented = (route: string) =>
  WEAPP_PAGES.some((page) => page.route === route && page.implemented);
export const accountEntries = (viewerRole: string) =>
  ENTRIES.filter(
    (entry) => accountPageImplemented(entry.route) && (!entry.owner || viewerRole === "owner"),
  );
