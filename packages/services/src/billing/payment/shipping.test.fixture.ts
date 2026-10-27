import { createSessionMutexConnectionFactory } from "@liyoxi/db";
import type { BillingOrder, PaymentTxn } from "@liyoxi/db";
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { DEFAULT_CONTROLS } from "@liyoxi/shared/purchase-policy";
import { claimDeliveries, consumeDelivery, createEvents } from "../../events/index.js";
import { createSessionMutex } from "../../kernel/index.js";
import type { DeliveredEvent } from "../../kernel/index.js";
import { createClock, createRefundHarnessForTest, TEST_KEYRING } from "../../testing/index.js";
import { proposeFinanceConfig } from "../finance-config/index.js";
import { createShippingAssembly } from "./shipping-assembly.js";
import type { ShippingDeps } from "./shipping.js";
import { SHIPPING_SUBSCRIBER } from "./shipping.js";

export const APPID = "wx0000000000000000",
  MCHID = "1900000109";
export function shippingWorld(
  prisma: Parameters<typeof createRefundHarnessForTest>[0],
  connectionString: string,
) {
  const clock = createClock(new Date("2026-10-19T03:00:00.999Z"));
  const h = createRefundHarnessForTest(prisma, { clock });
  const configuredApproval = h.deps.approval;
  if (!configuredApproval) throw new TypeError("发货夹具必须装配真实审批公口");
  const approval = configuredApproval;
  const scopes: ReturnType<typeof createShippingAssembly>[] = [];
  const mutexes: ReturnType<typeof createSessionMutex>[] = [];
  async function controls(value: boolean) {
    const proposer = await h.staff("super_admin"),
      reviewer = await h.staff("super_admin");
    const proposal = await h.tx.run((tx) =>
      proposeFinanceConfig(
        tx,
        { approval, clock, keyring: TEST_KEYRING },
        proposer.ctx,
        {
          configKey: "controls",
          payload: { ...DEFAULT_CONTROLS, shippingReport: value },
          changeNote: "本轮发货隔离内控",
        },
        proposer.staff,
      ),
    );
    await h.tx.run((tx) =>
      approval.approve(tx, reviewer.ctx, {
        approvalId: proposal.approvalId,
        staff: reviewer.staff,
        lockVersion: 0,
      }),
    );
  }
  function source(override: Partial<ShippingDeps> = {}) {
    const mutex = createSessionMutex({
      connect: createSessionMutexConnectionFactory({ connectionString }),
    });
    mutexes.push(mutex);
    const scope = createShippingAssembly(h.assembly);
    scope.attach({
      tx: h.tx,
      clock,
      sessionMutex: mutex,
      provider: h.provider.wechat,
      appid: APPID,
      paymentAppid: APPID,
      mchid: MCHID,
      ...override,
    });
    scopes.push(scope);
    const events = createEvents({ assembly: scope.assembly, clock, tx: h.tx });
    const prepare = (event: DeliveredEvent) =>
      scope.beforeConsume(
        { eventId: event.id, subscriber: SHIPPING_SUBSCRIBER, dispatchNo: 1 },
        event,
      );
    return {
      prepare,
      consume: (event: DeliveredEvent) =>
        h.tx.run((tx) => scope.assembly.subscriber(SHIPPING_SUBSCRIBER)!.handle(tx, event)),
      async deliver(event: DeliveredEvent) {
        await events.expand();
        const { claimed } = await h.tx.run((tx) => claimDeliveries(tx));
        const ref = claimed.find(
          (r) => r.eventId === event.id && r.subscriber === SHIPPING_SUBSCRIBER,
        );
        if (!ref) throw new Error("本轮发货真实投递未展开/认领");
        const deps = {
          tx: h.tx,
          subscribers: events.subscribers,
          alerts: { raise: async () => {} },
          beforeConsume: scope.beforeConsume,
        };
        return {
          outcome: await consumeDelivery(deps, ref),
          repeat: () => consumeDelivery(deps, ref),
        };
      },
      close: () => scope.close(),
    };
  }
  async function eventOf(own: { order: BillingOrder; receipt: PaymentTxn }) {
    const stored = await prisma.outboxEvent.findFirstOrThrow({
      where: { eventType: "billing_order.paid", aggregateId: own.order.id },
    });
    const event: DeliveredEvent = {
      id: stored.id,
      type: stored.eventType,
      payload: EVENT_PAYLOAD_SCHEMAS["billing_order.paid"].parse(stored.payload),
    };
    if (own.receipt.channel === "wechat_jsapi") {
      h.provider.wechat.shippingOrders.set(own.receipt.channelTxnNo!, {
        transactionId: own.receipt.channelTxnNo!,
        outTradeNo: own.receipt.outTradeNo,
        mchid: MCHID,
        payerOpenid: own.receipt.channelPayerRef!,
        amountFen: own.receipt.channelAmountFen!,
        state: 1,
        shipping: null,
      });
    }
    return { ...own, event };
  }
  return {
    ...h,
    controls,
    source,
    eventOf,
    async paid() {
      return eventOf(await h.paid());
    },
    async closeAll() {
      for (const scope of scopes) scope.close();
      const closed = await Promise.allSettled(mutexes.map((mutex) => mutex.close()));
      h.close();
      const errors = closed.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
      if (errors.length) throw new AggregateError(errors, "本轮发货会话未完全关闭");
    },
  };
}
export type ShippingWorld = ReturnType<typeof shippingWorld>;
