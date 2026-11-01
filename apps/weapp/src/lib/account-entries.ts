import { WEAPP_PAGES } from "../pages";

const ENTRIES = [
  { route: "sub/profile/profile/index", title: "门店档案", icon: "store", owner: true },
  { route: "sub/order/orders/index", title: "订单", icon: "file-text", owner: true },
  { route: "sub/publish/tasks/index", title: "发布任务", icon: "clipboard-list", owner: true },
  { route: "sub/publish/accounts/index", title: "发布账号", icon: "smartphone", owner: true },
  { route: "sub/asset/lib/index", title: "素材库", icon: "image", owner: false },
  { route: "sub/profile/staff-profile/index", title: "我的资料", icon: "user", owner: false },
  { route: "sub/member/members/index", title: "成员", icon: "users", owner: true },
  { route: "sub/service/messages/index", title: "消息", icon: "bell", owner: false },
  { route: "sub/service/settings/index", title: "设置", icon: "sliders", owner: false },
] as const;

export const accountPageImplemented = (route: string) =>
  WEAPP_PAGES.some((page) => page.route === route && page.implemented);
export const accountEntries = (viewerRole: string) =>
  ENTRIES.filter(
    (entry) => accountPageImplemented(entry.route) && (!entry.owner || viewerRole === "owner"),
  );
