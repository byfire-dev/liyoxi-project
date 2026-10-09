import type { Assembly } from "../kernel/index.js";
import { createStaffManagement } from "./management.js";
import type { StaffManagementDeps } from "./management.js";
import { findStaffViolations } from "./full-invariants.js";
import { handleStaffSlaBreach, onStaffCalendarImported } from "./sla.js";

/** Only this scope's staff entries and assignment_history branch acquire instance dependencies. */
export function createStaffAssembly(base: Assembly) {
  let deps: StaffManagementDeps | undefined;
  let closed = false;
  let scanCursor: string | undefined;
  let scanning: Promise<void> | undefined;
  const recoverInvites = (signal?: AbortSignal) => {
    if (scanning) return scanning;
    const input = current();
    if (!input.sendWecomInvite) throw new TypeError("员工邀请通知尚未装配");
    scanning = (async () => {
      const rows = await input.tx.run((tx) =>
        tx.staff.findMany({
          where: {
            status: "active",
            wecomBindStatus: "invited",
            ...(scanCursor ? { id: { gt: scanCursor } } : {}),
          },
          orderBy: { id: "asc" },
          take: 100,
          select: { id: true, createdAt: true },
        }),
      );
      for (const row of rows) {
        if (closed || signal?.aborted) break;
        scanCursor = row.id;
        try {
          await input.sendWecomInvite!({ staffId: row.id, createdAt: row.createdAt });
        } catch {
          /* Durable invited state is retried after the cursor wraps. */
        }
      }
      if (rows.length < 100) scanCursor = undefined;
    })().finally(() => {
      scanning = undefined;
    });
    return scanning;
  };
  const current = () => {
    if (closed || !deps) throw new TypeError("员工运行时尚未绑定或已关闭");
    return deps;
  };
  const subscribers = base.subscribers.map((item) =>
    item.name === "staff.onCalendarImported"
      ? {
          ...item,
          handle: (
            tx: Parameters<typeof item.handle>[0],
            event: Parameters<typeof item.handle>[1],
          ) => onStaffCalendarImported(tx, current(), event),
        }
      : item,
  );
  const timerHandlers = base.timerHandlers.map((item) =>
    item.kind === "sla.breach"
      ? {
          ...item,
          handle: (
            tx: Parameters<typeof item.handle>[0],
            timer: Parameters<typeof item.handle>[1],
          ) =>
            timer.subjectType === "assignment_history"
              ? handleStaffSlaBreach(tx, current(), timer)
              : item.handle(tx, timer),
        }
      : item,
  );
  const recurringJobs = base.recurringJobs.map((item) =>
    item.kind === "notify.remind_scan"
      ? {
          ...item,
          run: async (ctx: Parameters<typeof item.run>[0]) => {
            const result = await item.run(ctx);
            if (!closed && !ctx.signal?.aborted) await recoverInvites(ctx.signal);
            return result;
          },
        }
      : item,
  );
  const recurringIndex = new Map(recurringJobs.map((item) => [item.kind, item]));
  const invariants = base.invariants.map((item) =>
    ["staff.I1", "staff.I10", "staff.I12"].includes(item.code)
      ? {
          ...item,
          run: (tx: Parameters<typeof findStaffViolations>[0]) =>
            findStaffViolations(
              tx,
              item.code.slice(6) as "I1" | "I10" | "I12",
              current(),
              assembly,
            ),
        }
      : item,
  );
  const subscriberIndex = new Map(subscribers.map((item) => [item.name, item]));
  const timerIndex = new Map(timerHandlers.map((item) => [item.kind, item]));
  const invariantIndex = new Map(invariants.map((item) => [item.code, item]));
  const assembly: Assembly = {
    ...base,
    subscribers,
    timerHandlers,
    recurringJobs,
    invariants,
    recurringJob: (kind) => recurringIndex.get(kind),
    subscriber: (name) => subscriberIndex.get(name),
    timerHandler: (kind) => timerIndex.get(kind),
    invariant: (code) => invariantIndex.get(code),
  };
  return {
    assembly,
    attach(input: StaffManagementDeps) {
      if (closed || deps) throw new TypeError("员工运行时只能绑定一次");
      deps = input;
      return createStaffManagement(input);
    },
    async close() {
      closed = true;
      await scanning;
    },
  };
}
