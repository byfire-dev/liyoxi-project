import { approvalKindPort } from "../../approval/index.js";
import type { Assembly, KeyedPort, Tx, DeliveredEvent } from "../../kernel/index.js";
import type { FiredTimer } from "../../kernel/index.js";
import type { RefundDeps } from "./context.js";
import { stagingRefundApproval } from "../staging-pay/kind.js";
import { refundApproval } from "./approval.js";
import { createRefundSaga } from "./saga.js";
import { onRefundCalendarImported } from "./calendar.js";

const unavailable = (): never => {
  throw new TypeError("退款运行时尚未绑定或已关闭");
};
export const unboundRefundApproval = refundApproval(unavailable);
export const unboundRefundHandler = async (): Promise<never> => unavailable();
/** 注册只含受控任务；外呼由worker beforeRun和三段式在事务外执行。 */
export function createRefundAssembly(base: Assembly) {
  let deps: RefundDeps | undefined,
    closed = false;
  const current = () => {
    if (closed || !deps) return unavailable();
    return deps;
  };
  const kind = refundApproval(current);
  const stagingKind = base.appEnv === "stg" ? stagingRefundApproval(current) : undefined;
  const subscribers = base.subscribers.map((item) =>
    item.name === "billing.submitRefundTxn"
      ? {
          ...item,
          handle: (tx: Tx, event: DeliveredEvent) =>
            createRefundSaga(current()).onSubmit(tx, event),
        }
      : item.name === "billing.onCalendarImported"
        ? {
            ...item,
            handle: async (tx: Tx, event: DeliveredEvent) => {
              await onRefundCalendarImported(tx, current(), event);
              await item.handle(tx, event);
            },
          }
        : item,
  );
  const timerHandlers = base.timerHandlers.map((item) =>
    item.kind === "rf.poll"
      ? {
          ...item,
          handle: (tx: Tx, timer: FiredTimer) => createRefundSaga(current()).poll(tx, timer),
        }
      : item,
  );
  if (
    subscribers.filter((s) => s.name === "billing.submitRefundTxn").length !== 1 ||
    timerHandlers.filter((t) => t.kind === "rf.poll").length !== 1
  )
    throw new TypeError("退款必须复用唯一订阅者与定时器登记");
  const assembly: Assembly = {
    ...base,
    subscribers,
    timerHandlers,
    subscriber: (name) => subscribers.find((s) => s.name === name),
    timerHandler: (name) => timerHandlers.find((s) => s.kind === name),
    portEntries<T>(port: KeyedPort<T>) {
      const entries = base.portEntries(port);
      if (port !== (approvalKindPort as unknown as KeyedPort<T>)) return entries;
      if (!entries.has("plan_refund")) throw new TypeError("缺少退款审批登记");
      if (entries.has("staging_pay_refund") !== (base.appEnv === "stg"))
        throw new TypeError("预发退款审批登记与当前环境不一致");
      return new Map(
        [...entries].map(([key, value]) => [
          key,
          key === "plan_refund"
            ? (kind as unknown as T)
            : key === "staging_pay_refund" && stagingKind
              ? (stagingKind as unknown as T)
              : value,
        ]),
      );
    },
  };
  return {
    assembly,
    current,
    attach(value: RefundDeps) {
      if (closed || deps) throw new TypeError("退款运行时只能绑定一次");
      deps = value;
    },
    close() {
      closed = true;
      deps = undefined;
    },
  };
}
