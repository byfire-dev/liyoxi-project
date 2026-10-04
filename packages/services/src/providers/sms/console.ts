// 控制台短信：不真发，把内容打进日志。只限 local、test；stg、prod 选它即启动失败（index.ts 的工厂拦）。
// 01 第 9 节“未配置时：控制台输出；提醒只剩站内与订阅消息”。
// 日志走注入的 logger，不用 console（服务端禁 console.log）。

import { ok } from "../types.js";
import type { ProviderLogger, SmsProvider } from "../types.js";

export function createConsoleSms(deps: { logger: ProviderLogger }): SmsProvider {
  const { logger } = deps;
  return {
    status: "local",
    configured: true,
    async sendActivationCode({ phone, code }) {
      logger.info({ provider: "sms", phone, code }, "[sms:console] 员工激活码");
      return ok(undefined);
    },
    async sendSubscribeFallback({ phone, templateKey, params }) {
      logger.info({ provider: "sms", phone, templateKey, params }, "[sms:console] 订阅消息的补发");
      return ok(undefined);
    },
    async sendOncallAlert({ phones, title, content }) {
      logger.info({ provider: "sms", phones, title, content }, "[sms:console] 值班告警");
      return ok(undefined);
    },
  };
}
