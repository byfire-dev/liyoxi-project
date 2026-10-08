// W0-21 种子：订阅槽位、短信模板、通知场景
export { seed } from "./seed.js";
export {
  DEFAULT_SCENE_BINDING,
  SCENE_BINDINGS,
  sceneBindingOf,
  SMS_TEMPLATE_SEEDS,
  WX_TEMPLATE_SLOT_SEEDS,
} from "./seed-data.js";
export type { SceneBinding, WxTemplateSlotKey } from "./seed-data.js";
export { createNotifyMessages } from "./messages.js";
export type { NotifyMessages, NotifyMessagesDeps } from "./messages.js";
export { countUnread } from "./messages.scope.js";
export type { MessageActor, UnreadMessageQuery } from "./messages.scope.js";
export type { NotifySettingActor } from "./settings.js";
export { registration } from "./register.js";

export { createSubscribeResults, readSubscribePlan } from "./subscribe-results.js";
export type {
  SubscribeResults,
  SubscribeResultsDeps,
  SubscribePrincipal,
} from "./subscribe-results.js";
export { createWechatReceiptHandler } from "./wechat-receipts.js";
export type { WechatReceiptHandler, WechatReceiptInput } from "./wechat-receipts.js";
