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

export { createSmsInit, smsTemplateReader, SmsInitSchema } from "./sms-init.js";
export { createSmsHealth } from "./sms-health.js";
export type { SmsHealth } from "./sms-health.js";
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

export { createNotifyDispatcher } from "./service.js";
export type { NotifyDispatcherService, OpsAlertSendInput, OpsAlertSendResult } from "./service.js";
export type { NotifyDispatchDeps } from "./context.js";
export type { NotifyQueueRef, NotifyQueueTask } from "./context.js";

export {
  findNotifyN1Violations,
  findNotifyN2Violations,
  findNotifyN3Violations,
  findNotifyN15Violations,
} from "./invariants.js";

export type { DirectNotificationInput } from "./direct.js";
export { sendSystemAlert, SYSTEM_ALERT_SCENE } from "./system-alert.js";
export type { SystemAlertInput, SystemAlertResult } from "./system-alert.js";

export { sendStaffWecomInvite } from "./staff-invite.js";

export { sendQuotaExceeded } from "./entitlement.js";

export type { InvoiceMailSource } from "./context.js";
