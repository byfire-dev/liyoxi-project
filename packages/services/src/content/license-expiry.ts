import { addDays, calendarDate, dayRange } from "@liyoxi/shared/time";
import { lockRows, uuidv7, createIdentityContext } from "../kernel/index.js";
import type { Clock, Tx, InvariantViolation, FiredTimer } from "../kernel/index.js";
import type { Flow } from "../flow/index.js";
import type { Timers } from "../timers/index.js";
import { dateOf } from "./checks.js";
export const licenseTimerPrefix = (id: string) => `content.license_end:drama:${id}:`;
export const licenseTimerKey = (id: string, date: string) => `${licenseTimerPrefix(id)}${date}`;
export function createContentLicense(deps: {
  clock: Clock;
  flow: Flow;
  timers: Pick<Timers, "arm" | "cancel">;
}) {
  async function rearm(tx: Tx, id: string) {
    await lockRows(tx, "drama", [id]);
    const row = await tx.drama.findUnique({ where: { id }, include: { dramaCopyrights: true } });
    await deps.timers.cancel(tx, {
      subject: { type: "drama", id },
      kinds: ["content.license_end"],
      keyPrefix: licenseTimerPrefix(id),
    });
    const end = dateOf(row?.dramaCopyrights[0]?.licenseEndDate ?? null);
    if (row?.status !== "listed" || row.archivedAt || !end) return;
    await deps.timers.arm(tx, {
      kind: "content.license_end",
      subject: { type: "drama", id },
      fireAt: dayRange(addDays(end, 1)).start,
      key: licenseTimerKey(id, end),
      payload: { licenseEndDate: end },
    });
  }
  async function expire(tx: Tx, id: string, now: Date, dedupeKey?: string) {
    await lockRows(tx, "drama", [id]);
    const row = await tx.drama.findUnique({ where: { id }, include: { dramaCopyrights: true } }),
      end = dateOf(row?.dramaCopyrights[0]?.licenseEndDate ?? null);
    if (!row || row.status !== "listed" || !end || calendarDate(now) <= end) return false;
    const ctx = createIdentityContext({
      actor: { type: "system", job: "content.license_end" },
      requestId: uuidv7(),
    });
    await deps.flow.transition(tx, ctx, {
      machine: "drama",
      stateField: "status",
      id,
      event: "drama.license_expire",
      meta: {
        requestId: ctx.requestId,
        ip: null,
        userAgent: null,
        authMethod: null,
        sessionId: null,
        jobName: "content.license_end",
      },
      set: { delisted_at: now, delist_reason_code: "license_expired", delist_note: null },
      emit: {
        type: "drama.delisted",
        payload: { v: 1, dramaId: id, reasonCode: "license_expired" },
        ...(dedupeKey ? { dedupeKey } : {}),
      },
    });
    return true;
  }
  return {
    rearm,
    async handle(tx: Tx, timer: FiredTimer) {
      if (timer.subjectType !== "drama" || !timer.subjectId) return "skipped" as const;
      await lockRows(tx, "drama", [timer.subjectId]);
      const row = await tx.dramaCopyright.findUnique({ where: { dramaId: timer.subjectId } }),
        end = dateOf(row?.licenseEndDate ?? null);
      const stored = await tx.timer.findUnique({
        where: { id: timer.id },
        select: { dedupeKey: true, status: true },
      });
      if (
        !end ||
        stored?.status === "cancelled" ||
        stored?.dedupeKey !== licenseTimerKey(timer.subjectId, end)
      )
        return "skipped" as const;
      return (await expire(tx, timer.subjectId, deps.clock.now(), `tmr:${stored.dedupeKey}`))
        ? ("fired" as const)
        : ("skipped" as const);
    },
    async check(tx: Tx, code: "I2" | "I3", at: Date): Promise<InvariantViolation[]> {
      const rows = await tx.drama.findMany({
          where: { status: "listed" },
          include: { dramaCopyrights: true },
          orderBy: { id: "asc" },
        }),
        violations: InvariantViolation[] = [];
      // Drama has no rank. One subject at a time; no file or higher-ranked locks are acquired here.
      for (const row of rows) {
        await lockRows(tx, "drama", [row.id]);
        const current = await tx.drama.findUnique({
            where: { id: row.id },
            include: { dramaCopyrights: true },
          }),
          end = dateOf(current?.dramaCopyrights[0]?.licenseEndDate ?? null);
        if (!current || current.status !== "listed") continue;
        if (code === "I2" && !end)
          violations.push({
            subject: { type: "drama", id: row.id },
            detail: { licenseEndDate: null },
          });
        if (code === "I2" && end && calendarDate(at) > end) {
          if (await expire(tx, row.id, at))
            violations.push({
              subject: { type: "drama", id: row.id },
              detail: { licenseEndDate: end },
              healed: { action: "license_expire", at },
            });
        }
        if (code === "I3" && end && calendarDate(at) <= end) {
          const fireAt = dayRange(addDays(end, 1)).start,
            key = licenseTimerKey(row.id, end);
          const timers = await tx.timer.findMany({
            where: {
              kind: "content.license_end",
              subjectType: "drama",
              subjectId: row.id,
              status: { in: ["scheduled", "dispatched"] },
            },
          });
          if (
            timers.length !== 1 ||
            timers[0]?.dedupeKey !== key ||
            timers[0].fireAt.getTime() !== fireAt.getTime()
          ) {
            await rearm(tx, row.id);
            const active = await tx.timer.findMany({
              where: {
                kind: "content.license_end",
                subjectType: "drama",
                subjectId: row.id,
                status: { in: ["scheduled", "dispatched"] },
              },
            });
            const restored =
              active.length === 1 &&
              active[0]?.dedupeKey === key &&
              active[0].fireAt.getTime() === fireAt.getTime();
            violations.push({
              subject: { type: "drama", id: row.id },
              detail: { licenseEndDate: end },
              ...(restored ? { healed: { action: "license_timer_rearmed", at } } : {}),
            });
          }
        }
      }
      return violations;
    },
  };
}
export type ContentLicense = ReturnType<typeof createContentLicense>;
