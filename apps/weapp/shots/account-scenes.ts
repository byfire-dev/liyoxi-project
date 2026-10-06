/** 固定离线样张登记；Node 截图脚本直接读取，不引运行时。 */
export const ACCOUNT_SCENES = [
  { name: "login-unchecked", route: "pages/login/index" },
  { name: "login-checked", route: "pages/login/index" },
  { name: "agreement", route: "pages/agreement/index?id=00000000-0000-4000-8000-000000000001" },
  { name: "mine-owner", route: "pages/mine/index" },
  { name: "mine-clerk", route: "pages/mine/index" },
  { name: "mine-guest", route: "pages/mine/index" },
  { name: "store-switch", route: "pages/mine/index" },
  { name: "reconsent", route: "pages/mine/index" },
] as const;
