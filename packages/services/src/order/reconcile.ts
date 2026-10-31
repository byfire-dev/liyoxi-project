import { alertsOf, lockRows } from "../kernel/index.js";
import type { Assembly, Clock, Tx, TxRunner } from "../kernel/index.js";
import type { CancelDeps } from "./cancel-context.js";
import { ensureFinalQualificationCancel } from "./qualification-followup.js";
import { timerKey } from "../timers/index.js";

interface LicenseEnd {
  dramaId: string;
  licenseEndDate: string | null;
  currentRevisionId: string | null;
}
export interface OrderReconcileDeps {
  tx: TxRunner;
  clock: Clock;
  assembly: Assembly;
  cancel: CancelDeps;
  ensureLetters(
    tx: Tx,
    itemIds: readonly string[],
    triggerRef: string,
  ): Promise<{
    created: number;
    revised: number;
    voided: number;
  }>;
  qualificationScopes(
    tx: Tx,
    input: { cursor?: string; limit: number },
  ): Promise<
    {
      entityId: string;
      storeId: string;
    }[]
  >;
  currentLicenseEnd(tx: Tx, dramaId: string): Promise<LicenseEnd | null>;
  ticketByItem(tx: Tx, itemId: string): Promise<{ deliveryTicketId: string; step: string } | null>;
}
export interface OrderReconcileResult {
  inspected: number;
  lettersCreated: number;
  lettersRevised: number;
  lettersVoided: number;
  cancellationsCreated: number;
  resyncArmed: number;
  shortened: number;
}
const PAGE = 100,
  HOUR = 3_600_000;
const terminal = ["cancelled", "refunded", "ended", "terminated"];

/** One instance, one sweep; every business target commits independently. No global bindings. */
export function createOrderReconciler(deps: OrderReconcileDeps) {
  let closed = false,
    pending: Promise<OrderReconcileResult> | undefined;
  let lastLicenseScan: number | undefined;
  const assertOpen = () => {
    if (closed) throw new TypeError("订单对账运行时已经关闭");
  };
  async function sweep(beat?: () => void): Promise<OrderReconcileResult> {
    const result: OrderReconcileResult = {
      inspected: 0,
      lettersCreated: 0,
      lettersRevised: 0,
      lettersVoided: 0,
      cancellationsCreated: 0,
      resyncArmed: 0,
      shortened: 0,
    };
    const failures: string[] = [];
    let failed = 0;
    const target = async <T>(kind: string, id: string, work: (tx: Tx) => Promise<T>) => {
      assertOpen();
      try {
        return await deps.tx.run(async (tx) => {
          assertOpen();
          const value = await work(tx);
          assertOpen();
          return value;
        });
      } catch {
        assertOpen();
        failed++;
        if (failures.length < 20) failures.push(`${kind}:${id}`);
        return undefined;
      } finally {
        result.inspected++;
        beat?.();
      }
    };
    // The existing writer owns account coverage and phase checks. Healthy candidates are no-ops.
    let cursor: string | undefined;
    for (;;) {
      assertOpen();
      const page = await deps.tx.run((tx) =>
        tx.dramaOrder.findMany({
          where: {
            startedAt: { lt: new Date(deps.clock.now().getTime() - 600_000) },
            status: { notIn: ["cancelled", "refunded"] },
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          select: { id: true },
          orderBy: { id: "asc" },
          take: PAGE,
        }),
      );
      for (const row of page) {
        const change = await target("letters", row.id, async (tx) => {
          await lockRows(tx, "drama_order", [row.id]);
          const order = await tx.dramaOrder.findUnique({ where: { id: row.id } });
          if (
            !order?.startedAt ||
            order.startedAt.getTime() >= deps.clock.now().getTime() - 600_000 ||
            ["cancelled", "refunded"].includes(order.status)
          )
            return null;
          const items = await tx.orderItem.findMany({
            where: { dramaOrderId: row.id },
            select: { id: true },
            orderBy: { id: "asc" },
          });
          return deps.ensureLetters(
            tx,
            items.map((item) => item.id),
            "flow.reconcile_sweep",
          );
        });
        if (change) {
          result.lettersCreated += change.created;
          result.lettersRevised += change.revised;
          result.lettersVoided += change.voided;
        }
      }
      if (page.length < PAGE) break;
      cursor = page.at(-1)!.id;
    }
    cursor = undefined;
    for (;;) {
      assertOpen();
      const page = await deps.tx.run((tx) => deps.qualificationScopes(tx, { cursor, limit: PAGE }));
      for (const scope of page) {
        const created = await target("qualification", scope.storeId, (tx) =>
          ensureFinalQualificationCancel(tx, deps.cancel, scope),
        );
        if (created) result.cancellationsCreated++;
      }
      if (page.length < PAGE) break;
      cursor = page.at(-1)!.storeId;
    }
    const now = deps.clock.now().getTime();
    if (lastLicenseScan === undefined || now < lastLicenseScan || now - lastLicenseScan >= HOUR) {
      const beforeFailures = failed;
      cursor = undefined;
      for (;;) {
        assertOpen();
        const page = await deps.tx.run((tx) =>
          tx.orderItem.findMany({
            where: {
              usageEndSource: "license",
              phase: { notIn: terminal },
              ...(cursor ? { id: { gt: cursor } } : {}),
            },
            select: { id: true },
            orderBy: { id: "asc" },
            take: PAGE,
          }),
        );
        for (const row of page) {
          const change = await target("license", row.id, async (tx) => {
            const before = await tx.orderItem.findUnique({ where: { id: row.id } });
            if (!before) return null;
            // Copyright changes lock drama140; then lock immutable order160/item170 owners.
            await lockRows(tx, "drama", [before.dramaId]);
            await lockRows(tx, "drama_order", [before.dramaOrderId]);
            await lockRows(tx, "order_item", [before.id]);
            const item = await tx.orderItem.findUniqueOrThrow({
              where: { id: row.id },
              include: { dramaOrder: true },
            });
            if (
              item.usageEndSource !== "license" ||
              terminal.includes(item.phase) ||
              item.dramaOrder.openCancelRequestId ||
              ["cancelled", "refunded", "ended"].includes(item.dramaOrder.status)
            )
              return null;
            const ticket = await deps.ticketByItem(tx, item.id);
            if (ticket) {
              await lockRows(tx, "delivery_ticket", [ticket.deliveryTicketId]);
              const current = await deps.ticketByItem(tx, item.id);
              if (!current || ["takedown", "archived", "terminated"].includes(current.step))
                return null;
            }
            const license = await deps.currentLicenseEnd(tx, item.dramaId);
            if (!license?.licenseEndDate) return null;
            const end = item.usageEndDate.toISOString().slice(0, 10);
            if (end > license.licenseEndDate)
              return {
                kind: "shortened" as const,
                entityId: item.entityId,
                dramaId: item.dramaId,
                revisionId: license.currentRevisionId,
                licenseEndDate: license.licenseEndDate,
                end,
              };
            if (end === license.licenseEndDate) return null;
            if (!license.currentRevisionId) throw new TypeError("当前版权缺少真实修订行");
            const subject = { type: "order_item", id: item.id },
              key = timerKey("usage.resync", subject, license.currentRevisionId);
            // Re-arming with a new now would clear a missing M6 handler's retry/backoff history.
            if (
              await tx.timer.findFirst({
                where: { dedupeKey: key, status: { not: "cancelled" } },
                select: { id: true },
              })
            )
              return null;
            await deps.cancel.timers.arm(tx, {
              kind: "usage.resync",
              subject,
              key,
              fireAt: deps.clock.now(),
              entityId: item.entityId,
              storeId: item.storeId,
              payload: {
                v: 1,
                dramaId: item.dramaId,
                dramaCopyrightRevisionId: license.currentRevisionId,
              },
            });
            return { kind: "armed" as const };
          });
          if (change?.kind === "armed") result.resyncArmed++;
          if (change?.kind === "shortened") {
            result.shortened++;
            await alertsOf(deps.assembly).raise({
              rule: "order.license_shortened",
              severity: "P2",
              dimension: `${change.dramaId}:${change.revisionId ?? "current"}`,
              detail: {
                dramaId: change.dramaId,
                orderItemId: row.id,
                licenseEndDate: change.licenseEndDate,
                usageEndDate: change.end,
              },
            });
          }
        }
        if (page.length < PAGE) break;
        cursor = page.at(-1)!.id;
      }
      if (failed === beforeFailures) lastLicenseScan = now;
    }
    assertOpen();
    if (failed) throw new Error(`订单对账有${failed}个目标失败：${failures.join("，")}`);
    return result;
  }
  return {
    run(beat?: () => void) {
      assertOpen();
      return (pending ??= sweep(beat).finally(() => {
        pending = undefined;
      }));
    },
    async close() {
      closed = true;
      await Promise.allSettled(pending ? [pending] : []);
    },
  };
}
