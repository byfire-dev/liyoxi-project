import { assertNotInTransaction, isInTransaction, isUuid } from "../kernel/index.js";
import type { AlertInput, Alerts, Clock } from "../kernel/index.js";
import { createModelBudgetLedger } from "../media/index.js";
import type {
  ModelBudgetAdmission,
  ModelBudgetDecision,
  ModelBudgetMaintenance,
  ModelBudgetTransport,
} from "../media/index.js";
import type { ProviderLogger } from "../providers/types.js";
import { readModelBudgetPermit } from "./model-budget-permit.js";

/** 只拥有许可/维护/有界告警队列；transport与连接仍归调用方。构造零IO。 */
export function createModelBudgetRuntime(input: {
  readonly clock: Clock;
  readonly prefix: string;
  readonly transport?: ModelBudgetTransport;
  readonly alerts: Alerts;
  readonly logger: ProviderLogger;
}) {
  const ledger = createModelBudgetLedger(input);
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<unknown>>();
  const facts = new Map<string, AlertInput>();
  let disabled = false;
  let closing: Promise<void> | undefined;
  let draining: Promise<void> | undefined;
  let maintaining: Promise<ModelBudgetMaintenance> | undefined;
  const unavailable = { status: "denied", reason: "unavailable" } as const;
  const log = (evt: string) => {
    try {
      input.logger.warn({ evt }, "模型预算运行时保守关闭");
    } catch {
      // 日志失败不改变许可，也不覆盖业务异常。
    }
  };
  function record(kind: string, reason: string, storeId?: string): void {
    kind = ["asr", "vision", "digest", "maintenance"].includes(kind) ? kind : "unknown";
    const scope = reason === "quota_store" ? "store" : "global";
    const rule = reason.startsWith("quota_")
      ? "media.model_budget_exhausted"
      : "media.model_budget_unavailable";
    const dimension = scope === "store" && storeId && isUuid(storeId) ? storeId : "global";
    const key = `${rule}:${dimension}:${kind}:${reason}`;
    if (facts.size >= 64 && !facts.has(key)) {
      log("media.model_budget_alert_overflow");
      return;
    }
    facts.set(key, {
      rule,
      dimension,
      severity: "P2",
      detail: { kind, reason, scope },
    });
  }
  function track<T>(work: () => Promise<T>): Promise<T> {
    const running = Promise.resolve().then(work);
    pending.add(running);
    void running.then(
      () => pending.delete(running),
      () => pending.delete(running),
    );
    return running;
  }
  function drain(): Promise<void> {
    assertNotInTransaction("ops.modelBudget.drain");
    if (isInTransaction()) return Promise.resolve();
    return (draining ??= (async () => {
      // 一次只取有界快照；新事实留给下一轮，避免故障流量无限延长关停。
      const batch = [...facts.values()];
      facts.clear();
      for (const fact of batch) {
        try {
          await input.alerts.raise(fact);
        } catch {
          log("media.model_budget_alert_failed");
        }
      }
    })().finally(() => {
      draining = undefined;
    }));
  }
  function disable(): void {
    disabled = true;
    for (const controller of controllers) controller.abort();
  }
  const admission: ModelBudgetAdmission = {
    readPermit(tx, value) {
      return track(async () => {
        if (disabled) return null;
        try {
          const permit = await readModelBudgetPermit(tx, value);
          return disabled ? null : permit;
        } catch (error) {
          // 只在本次调用记录受控事实；此处仍可能持有PG锁，不能写告警或连Redis。
          record(
            ["asr", "vision", "digest"].includes(value.kind) ? value.kind : "unknown",
            "invalid_config",
          );
          throw error;
        }
      });
    },
    reserve(value, signal): Promise<ModelBudgetDecision> {
      assertNotInTransaction("ops.modelBudget.reserve");
      if (disabled || signal.aborted || isInTransaction()) return Promise.resolve(unavailable);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal.addEventListener("abort", abort, { once: true });
      controllers.add(controller);
      return track(async () => {
        try {
          if (disabled || signal.aborted) controller.abort();
          const result = await ledger.reserve(value, controller.signal);
          if (
            result.status === "denied" &&
            ["quota_global", "quota_store", "unavailable"].includes(result.reason)
          ) {
            record(value.kind, result.reason, value.storeId);
            await drain();
          }
          return disabled ? unavailable : result;
        } finally {
          controllers.delete(controller);
          signal.removeEventListener("abort", abort);
        }
      });
    },
  };
  return {
    admission,
    disable,
    drain,
    maintain(): Promise<ModelBudgetMaintenance> {
      assertNotInTransaction("ops.modelBudget.maintain");
      if (disabled || isInTransaction()) return Promise.resolve(unavailable);
      return (maintaining ??= track(async () => {
        const controller = new AbortController();
        controllers.add(controller);
        try {
          if (disabled) controller.abort();
          const result = await ledger.maintain(controller.signal);
          if (result.status === "denied" && !disabled) record("maintenance", "unavailable");
          await drain();
          return result;
        } finally {
          controllers.delete(controller);
        }
      }).finally(() => {
        maintaining = undefined;
      }));
    },
    close(): Promise<void> {
      disable();
      return (closing ??= (async () => {
        await Promise.allSettled([...pending]);
        await draining;
        await drain();
      })());
    },
  };
}
