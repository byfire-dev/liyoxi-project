import {
  approvalKindsOf,
  findI1Violations,
  findI3Violations,
  handleApprovalSlaBreach,
  onApprovalCalendarImported,
} from "../approval/index.js";
import type { ApprovalSlaBinding } from "../approval/index.js";
import { invariantNow } from "../kernel/index.js";
import type { Assembly } from "../kernel/index.js";

/** Fixed worker composition; no process-global approval binding or replacement kind. */
export function createApprovalSlaAssembly(base: Assembly) {
  if (
    base.subscribers.filter((item) => item.name === "approval.onCalendarImported").length !== 1 ||
    base.timerHandlers.filter((item) => item.kind === "sla.breach").length !== 1
  )
    throw new TypeError("审批时限需要唯一的日历订阅者与 sla.breach 处理器");
  const kinds = approvalKindsOf(base);
  let deps: ApprovalSlaBinding | undefined,
    closed = false;
  const current = () => {
    if (closed || !deps) throw new TypeError("本审批时限运行时尚未绑定或已经关闭");
    return deps;
  };
  const subscribers = base.subscribers.map((item) =>
    item.name === "approval.onCalendarImported"
      ? {
          ...item,
          handle: (...args: Parameters<typeof item.handle>) =>
            onApprovalCalendarImported(args[0], current(), args[1]),
        }
      : item,
  );
  const timerHandlers = base.timerHandlers.map((item) =>
    item.kind === "sla.breach"
      ? {
          ...item,
          handle: (...args: Parameters<typeof item.handle>) =>
            args[1].subjectType === "approval_request"
              ? handleApprovalSlaBreach(args[0], current(), args[1])
              : item.handle(...args),
        }
      : item,
  );
  const invariants = base.invariants.map((item) =>
    item.code === "approval.I1" || item.code === "approval.I3"
      ? {
          ...item,
          run: (
            tx: Parameters<NonNullable<typeof item.run>>[0],
            _scope: Parameters<NonNullable<typeof item.run>>[1],
            ctx: Parameters<NonNullable<typeof item.run>>[2],
          ) => {
            current();
            return item.code === "approval.I1"
              ? findI1Violations(tx, kinds)
              : findI3Violations(tx, invariantNow(ctx), kinds);
          },
        }
      : item,
  );
  const assembly: Assembly = {
    ...base,
    subscribers,
    timerHandlers,
    invariants,
    subscriber: (name) => subscribers.find((item) => item.name === name),
    timerHandler: (kind) => timerHandlers.find((item) => item.kind === kind),
    invariant: (code) => invariants.find((item) => item.code === code),
  };
  return {
    assembly,
    attach(value: Omit<ApprovalSlaBinding, "kinds">) {
      if (closed || deps) throw new TypeError("审批时限运行时只能绑定一次");
      deps = { ...value, kinds };
    },
    close() {
      closed = true;
      deps = undefined;
    },
  };
}
