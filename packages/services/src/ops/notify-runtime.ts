import {
  createApprovalReads,
  approvalKindsOf,
  approvalRecipientsForNotify,
} from "../approval/index.js";
import { getNotifyPurchaseMode } from "../billing/index.js";
import type { Params } from "../config/index.js";
import { createConfig } from "../config/index.js";
import { merchantTargetForNotify, wechatTargetForNotify } from "../identity/index.js";
import { alertsOf } from "../kernel/index.js";
import type { AppEnv, Assembly, Clock, TxRunner } from "../kernel/index.js";
import { createNotifyDispatcher, findNotifyN15Violations } from "../notify/index.js";
import { findN5Violations } from "../docs/index.js";
import type { NotifyDispatchDeps } from "../notify/index.js";
import { staffContextsForNotify, staffTargetForNotify } from "../staff/index.js";
import { maskPhone } from "@liyoxi/shared/mask";
import { addDays, calendarDate } from "@liyoxi/shared/time";
import { nextWorkStart } from "@liyoxi/shared/workcal";
import { loadWorkCalendar, workHoursAt } from "../sla/index.js";
import { phoneBidx, loadKeyring } from "../security/index.js";
import type { Keyring } from "../security/index.js";

/** Only these registrations acquire runtime dependencies; all other objects and ports are preserved. */
export function createNotifyAssembly(base: Assembly) {
  let dispatcher: ReturnType<typeof createRuntimeNotify> | undefined;
  let closed = false;
  const current = () => {
    if (closed || !dispatcher) throw new TypeError("本通知运行时尚未绑定或已经关闭");
    return dispatcher;
  };
  const subscribers = base.subscribers.map((item) =>
    item.name === "notify.onEvent"
      ? {
          ...item,
          handle: async (
            tx: Parameters<typeof item.handle>[0],
            event: Parameters<typeof item.handle>[1],
          ) => {
            await current().onEvent(tx, event);
          },
        }
      : item.name === "notify.onMerchantUserDeleted"
        ? {
            ...item,
            handle: async (
              tx: Parameters<typeof item.handle>[0],
              event: Parameters<typeof item.handle>[1],
            ) => {
              await current().onMerchantUserDeleted(tx, event);
            },
          }
        : item,
  );
  const recurringJobs = base.recurringJobs.map((item) =>
    item.kind === "notify.remind_scan"
      ? { ...item, run: (ctx: Parameters<typeof item.run>[0]) => current().remindScan(ctx) }
      : item,
  );
  const invariants = base.invariants.map((item) =>
    item.code === "notify.N15"
      ? {
          ...item,
          run: (tx: Parameters<typeof findNotifyN15Violations>[0]) => {
            current();
            return findNotifyN15Violations(tx, assembly);
          },
        }
      : item.code === "docs.N5"
        ? {
            ...item,
            run: (tx: Parameters<typeof findN5Violations>[0]) => {
              current();
              return findN5Violations(tx, assembly);
            },
          }
        : item,
  );
  const subscriberIndex = new Map(subscribers.map((item) => [item.name, item]));
  const recurringIndex = new Map(recurringJobs.map((item) => [item.kind, item]));
  const invariantIndex = new Map(invariants.map((item) => [item.code, item]));
  const assembly: Assembly = {
    ...base,
    subscribers,
    recurringJobs,
    invariants,
    subscriber: (name) => subscriberIndex.get(name),
    recurringJob: (kind) => recurringIndex.get(kind),
    invariant: (code) => invariantIndex.get(code),
  };
  return {
    assembly,
    attach(service: ReturnType<typeof createRuntimeNotify>) {
      if (closed || dispatcher) throw new TypeError("通知运行时只能绑定一次");
      dispatcher = service;
    },
    async close() {
      closed = true;
      await dispatcher?.close();
    },
  };
}

/** API and worker inject the same current facts; this factory starts no IO or timer. */
export function createRuntimeNotify(input: {
  tx: TxRunner;
  clock: Clock;
  assembly: Assembly;
  appEnv: AppEnv;
  params: Params;
  providers: NotifyDispatchDeps["providers"];
  logger: NotifyDispatchDeps["logger"];
  keys?: Parameters<typeof loadKeyring>[0];
  keyring?: Keyring;
  appid?: string;
}) {
  const { tx, clock, assembly } = input;
  let keyring = input.keyring;
  const keys = () =>
    input.keys?.DATA_KEYS && input.keys.BIDX_KEYS
      ? (keyring ??= loadKeyring(input.keys))
      : (keyring ?? null);
  const configAt = (t: Parameters<NotifyDispatchDeps["wxEnabled"]>[0]) =>
    createConfig({ db: t, clock, redis: null }); // per statement snapshot, no shared cached flag
  const reads = createApprovalReads({ kinds: approvalKindsOf(assembly), clock });
  return createNotifyDispatcher({
    appEnv: input.appEnv,
    tx,
    clock,
    assembly,
    providers: input.providers,
    logger: input.logger,
    params: input.params,
    alerts: alertsOf(assembly),
    appid: input.appid,
    wxEnabled: (t, entityId) => configAt(t).flags.isEnabled("notify.wx.enabled", { entityId }),
    smsEnabled: (t, entityId) => configAt(t).flags.isEnabled("notify.sms.enabled", { entityId }),
    purchaseMode: getNotifyPurchaseMode,
    directTarget: (phone) => {
      const current = keys();
      return current
        ? { phoneRef: phoneBidx(current, phone).toString("hex"), phoneMask: maskPhone(phone) }
        : null;
    },
    merchantTarget: (t, id) => merchantTargetForNotify(t, id, keys, true),
    staffTarget: (t, id) => staffTargetForNotify(t, id, keys),
    staffWorkAt: async (t, at) => {
      const from = calendarDate(at);
      const calendar = await loadWorkCalendar(
        t,
        { from, to: addDays(from, 366) },
        await workHoursAt(t, at),
      );
      return nextWorkStart(calendar, at).at;
    },

    wechatTarget: (t, id, user) => wechatTargetForNotify(t, id, user, input.appid),
    approvalRecipients: async (t, id) =>
      approvalRecipientsForNotify(t, id, reads, await staffContextsForNotify(t)),
  });
}
