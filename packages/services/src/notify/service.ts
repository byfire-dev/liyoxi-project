import { AppError } from "../kernel/index.js";
import type { NotifyDispatchDeps } from "./context.js";
import { sendQuotaExceeded } from "./entitlement.js";
import { dispatchEvent } from "./dispatch.js";
import { clearDeletedMerchant } from "./cleanup.js";
import { deliveryRunner } from "./delivery.js";
import { remindScan } from "./reminders.js";
import { directSender } from "./direct.js";
import { validateConfiguration } from "./configuration.js";
import { fanoutRunner } from "./fanout.js";
import type { NotifyQueueRef, NotifyQueueTask } from "./context.js";
import { remindAssetDemand } from "./asset-demand.js";
import { IdSchema } from "@liyoxi/contract";
import { z } from "zod";

export interface OpsAlertSendInput {
  readonly generation: string;
  readonly phase: "open" | "recovered" | "heartbeat" | "channel";
  readonly phones: readonly string[];
  readonly title: string;
  readonly signal?: AbortSignal;
}
export interface OpsAlertSendResult {
  /** 同步受理已确认；不代表短信实际到达。 */
  readonly accepted: boolean;
  readonly unknown: boolean;
  readonly configured: boolean;
}
const OpsAlertInput = z.strictObject({
  generation: IdSchema,
  phase: z.enum(["open", "recovered", "heartbeat", "channel"]),
  phones: z.array(z.string().regex(/^1[3-9][0-9]{9}$/u)).max(16),
  title: z.string().min(1).max(64),
});

export function createNotifyDispatcher(deps: NotifyDispatchDeps) {
  const runner = deliveryRunner(deps);
  const direct = directSender(deps);
  const fanout = fanoutRunner(deps);
  async function sendOpsAlert(raw: OpsAlertSendInput): Promise<OpsAlertSendResult> {
    const { signal, ...data } = raw;
    const input = OpsAlertInput.parse(data);
    if (!input.phones.length) return { accepted: false, unknown: false, configured: false };
    let accepted = true,
      unknown = false,
      configured = true;
    for (const phone of new Set(input.phones)) {
      signal?.throwIfAborted();
      const target = deps.directTarget(phone);
      if (!target) {
        accepted = configured = false;
        continue;
      }
      try {
        const result = await direct.sendDirect(
          {
            purpose: "ops_alert",
            templateKey: "ops_alert",
            phone,
            params: { rule_name: input.title },
            directKey: `alert:${input.generation}:${input.phase[0]}:${target.phoneRef}`,
          },
          { ...(signal ? { signal } : {}) },
        );
        const delivery = await deps.tx.run((tx) =>
          tx.notificationDelivery.findUniqueOrThrow({
            where: { id: result.deliveryId },
            select: { status: true, reason: true },
          }),
        );
        accepted &&= delivery.status === "sent";
        unknown ||= delivery.status === "sending" || delivery.reason === "unknown_outcome";
        if (delivery.reason === "unconfigured") configured = false;
      } catch (error) {
        signal?.throwIfAborted();
        // 原直发公口保留结果；读回失败等异常不能被报告为已受理。
        accepted = false;
        if (error instanceof AppError && error.error === "NOT_FOUND") configured = false;
        else if (!(error instanceof AppError && ["RATE_LIMITED", "INTERNAL"].includes(error.error)))
          unknown = true;
      }
    }
    return { accepted, unknown, configured };
  }
  return {
    ...runner,
    deliver: (ref: NotifyQueueRef) =>
      "fanoutId" in ref ? fanout.deliver(ref) : runner.deliver(ref),
    scan: async (enqueue: (ref: NotifyQueueTask) => Promise<void>) =>
      (await runner.scan(enqueue)) + (await fanout.scan(enqueue)),
    validateConfiguration: () => validateConfiguration(deps),
    sendDirect: direct.sendDirect,
    sendOpsAlert,
    verificationAvailable: direct.verificationAvailable,
    remindAssetDemand: (tx: Parameters<typeof remindAssetDemand>[0], id: string) =>
      remindAssetDemand(tx, deps, id),
    sendQuotaExceeded: (
      tx: Parameters<typeof sendQuotaExceeded>[0],
      event: Parameters<typeof sendQuotaExceeded>[2],
    ) => sendQuotaExceeded(tx, deps, event),
    close: async () => {
      await Promise.all([runner.close(), direct.close(), fanout.close()]);
    },
    onEvent: (
      tx: Parameters<typeof dispatchEvent>[0],
      event: Parameters<typeof dispatchEvent>[2],
    ) => dispatchEvent(tx, deps, event),
    onMerchantUserDeleted: (
      tx: Parameters<typeof clearDeletedMerchant>[0],
      event: Parameters<typeof clearDeletedMerchant>[2],
    ) => clearDeletedMerchant(tx, deps, event),
    remindScan: (context: Parameters<typeof remindScan>[1]) => remindScan(deps, context),
  };
}
export type NotifyDispatcherService = ReturnType<typeof createNotifyDispatcher>;
/** Raw registrations carry metadata; only the runtime's scoped Assembly can execute them. */
export function boundNotifyDispatcher(): NotifyDispatcherService {
  throw new AppError("INTERNAL", { message: "通知派发需要本运行时的领域装配" });
}

export function boundNotifyAssembly(): NotifyDispatchDeps["assembly"] {
  throw new AppError("INTERNAL", { message: "通知领域事实需要本运行时的领域装配" });
}
