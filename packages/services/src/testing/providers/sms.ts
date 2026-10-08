// 假短信：不发，只记下来。

import { ok } from "../../providers/types.js";
import type { ProviderMethodName, SmsProvider } from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl, FakeNotificationControl } from "./base.js";

type Method = ProviderMethodName<SmsProvider>;

export type FakeSmsMessage =
  | { kind: "activation_code"; phone: string; code: string }
  | {
      kind: "subscribe_fallback";
      phone: string;
      templateKey: string;
      params: Record<string, string>;
    }
  | { kind: "oncall_alert"; phones: string[]; title: string; content: string };

export interface FakeSms
  extends
    FakeNotificationControl<"sendActivationCode" | "sendSubscribeFallback" | "sendOncallAlert">,
    SmsProvider,
    FakeControl<Method> {
  /** “发出去”的短信，按先后 */
  readonly sent: FakeSmsMessage[];
  /** 发给这个手机号的最后一个激活码 */
  lastActivationCode(phone: string): string | undefined;
}

export function createFakeSms(options: { clock?: FakeClock } = {}): FakeSms {
  const core = createFakeCore<Method>(options.clock ?? systemClock, [
    "sendActivationCode",
    "sendSubscribeFallback",
    "sendOncallAlert",
  ]);
  const sent: FakeSmsMessage[] = [];

  return {
    status: "fake",
    configured: true,
    ...core.control,
    ...core.notificationControl,
    sent,
    lastActivationCode(phone) {
      for (const message of [...sent].reverse()) {
        if (message.kind === "activation_code" && message.phone === phone) return message.code;
      }
      return undefined;
    },

    sendActivationCode: (input) =>
      core.runNotification(
        "sendActivationCode",
        input,
        () => {
          sent.push({ kind: "activation_code", phone: input.phone, code: input.code });
          return ok(undefined);
        },
        input.signal,
      ),
    sendSubscribeFallback: (input) =>
      core.runNotification(
        "sendSubscribeFallback",
        input,
        () => {
          sent.push({
            kind: "subscribe_fallback",
            phone: input.phone,
            templateKey: input.templateKey,
            params: { ...input.params },
          });
          return ok(undefined);
        },
        input.signal,
      ),
    sendOncallAlert: (input) =>
      core.runNotification(
        "sendOncallAlert",
        input,
        () => {
          sent.push({
            kind: "oncall_alert",
            phones: [...input.phones],
            title: input.title,
            content: input.content,
          });
          return ok(undefined);
        },
        input.signal,
      ),
  };
}
