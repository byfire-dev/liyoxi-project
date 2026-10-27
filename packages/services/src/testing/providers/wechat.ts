// 假微信：预置 code 对应的会话与手机号；记下发出的订阅消息；文本检测可按预置给结论，
// 也可切到“服务不可用”；图片审核直接放行（计划 第 7.3 节表后的留桩清单）。

import { failed, ok } from "../../providers/types.js";
import type {
  ContentVerdict,
  ProviderMethodName,
  WechatProvider,
  WechatSession,
  WechatShippingInput,
  WechatShippingOrder,
} from "../../providers/types.js";
import { createFakeCore, systemClock } from "./base.js";
import type { FakeClock, FakeControl, FakeNotificationControl } from "./base.js";

type Method = ProviderMethodName<WechatProvider>;

export interface FakeSubscribeMessage {
  openid: string;
  templateId: string;
  page?: string;
  data: Record<string, string>;
}

export interface FakeWechat
  extends FakeNotificationControl<"sendSubscribeMessage">, WechatProvider, FakeControl<Method> {
  /** 预置：wx.login 的 code → 会话。没预置的 code 返回 rejected */
  readonly sessions: Map<string, WechatSession>;
  /** 预置：手机号组件的 code → 手机号。没预置的 code 返回 rejected */
  readonly phones: Map<string, string>;
  /** 发出去的订阅消息 */
  readonly subscribeMessages: FakeSubscribeMessage[];
  /** 文本检测的预置结论，按顺序各用一次；用完了一律 pass */
  readonly textVerdicts: ContentVerdict[];
  readonly shippingOrders: Map<string, WechatShippingOrder>;
  readonly shippingUploads: WechatShippingInput[];
  /**
   * 把文本检测切到“服务不可用”：之后每次 checkText 都返回 unavailable，直到切回来。
   * 调用方要走“服务不可用即拒收”的分支，用它来测。
   */
  setTextCheckAvailable(available: boolean): void;
}

export function createFakeWechat(options: { clock?: FakeClock } = {}): FakeWechat {
  const core = createFakeCore<Method>(options.clock ?? systemClock, ["sendSubscribeMessage"]);
  const sessions = new Map<string, WechatSession>();
  const phones = new Map<string, string>();
  const subscribeMessages: FakeSubscribeMessage[] = [];
  const textVerdicts: ContentVerdict[] = [];
  const shippingOrders = new Map<string, WechatShippingOrder>();
  const shippingUploads: WechatShippingInput[] = [];
  let textCheckAvailable = true;
  let traceSeq = 0;

  return {
    status: "fake",
    configured: true,
    ...core.control,
    ...core.notificationControl,
    sessions,
    phones,
    subscribeMessages,
    textVerdicts,
    shippingOrders,
    shippingUploads,
    setTextCheckAvailable(available) {
      textCheckAvailable = available;
    },

    queryShippingInfo: (input) =>
      core.run("queryShippingInfo", input, () => {
        const order = shippingOrders.get(input.transactionId);
        return order ? ok(structuredClone(order)) : failed("unavailable", "替身无该发货订单事实");
      }),
    uploadShippingInfo: (input) =>
      core.run("uploadShippingInfo", input, () => {
        const order = shippingOrders.get(input.transactionId);
        if (
          !order ||
          order.state !== 1 ||
          order.shipping?.finished ||
          order.payerOpenid !== input.payerOpenid ||
          !(input.uploadedAt instanceof Date) ||
          !Number.isFinite(input.uploadedAt.getTime())
        )
          return {
            ...failed("rejected", "替身拒绝无订单或重复发货"),
            acceptance: "not_accepted" as const,
          };
        const snapshot = { ...input, uploadedAt: new Date(input.uploadedAt) };
        delete snapshot.signal;
        shippingUploads.push(snapshot);
        shippingOrders.set(input.transactionId, {
          ...order,
          state: 2,
          shipping: {
            logisticsType: 3,
            deliveryMode: 1,
            finished: true,
            items: [
              {
                description: input.itemDescription,
                uploadedAtSec: Math.floor(input.uploadedAt.getTime() / 1000),
              },
            ],
          },
        });
        return ok(undefined);
      }),

    code2Session: (input) =>
      core.run("code2Session", input, () => {
        const session = sessions.get(input.code);
        return session ? ok({ ...session }) : failed("rejected", "code 无效：替身里没有预置它");
      }),
    getPhoneNumber: (input) =>
      core.run("getPhoneNumber", input, () => {
        const phone = phones.get(input.code);
        return phone === undefined
          ? failed("rejected", "code 无效：替身里没有预置它")
          : ok({ phone });
      }),
    sendSubscribeMessage: (input) =>
      core.runNotification(
        "sendSubscribeMessage",
        input,
        () => {
          const message = { ...input };
          delete message.signal;
          subscribeMessages.push({ ...message, data: { ...input.data } });
          return ok(undefined);
        },
        input.signal,
      ),
    createMiniProgramCode: (input) =>
      core.run("createMiniProgramCode", input, () =>
        ok({
          image: new TextEncoder().encode(`fake-mini-code:${input.page ?? ""}:${input.scene}`),
          contentType: "image/png",
        }),
      ),
    checkText: (input) =>
      core.run("checkText", input, () => {
        if (!textCheckAvailable) return failed("unavailable", "文本内容安全服务不可用（替身）");
        traceSeq += 1;
        return ok({ verdict: textVerdicts.shift() ?? "pass", traceId: `fake-trace-${traceSeq}` });
      }),
    checkImage: (input) =>
      core.run(
        "checkImage",
        input,
        () => {
          traceSeq += 1;
          return ok({ verdict: "pass", traceId: `fake-trace-${traceSeq}` });
        },
        input.signal,
      ),
  };
}
