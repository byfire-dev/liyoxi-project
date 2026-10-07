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
export { createSmsHealth, bindSmsHealth } from "./sms-health.js";
export { registration } from "./register.js";
