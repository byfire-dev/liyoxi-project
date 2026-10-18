import { DateSchema } from "@liyoxi/contract";
import type { ReminderRule, Tx } from "../kernel/index.js";
/** Information-class R7: current copyright, not immutable revision history. */
export async function listDramasLicenseEndingOn(tx: Tx, date: string) {
  const parsed = DateSchema.parse(date);
  return (
    await tx.dramaCopyright.findMany({
      where: { licenseEndDate: new Date(`${parsed}T00:00:00Z`), drama: { archivedAt: null } },
      select: { dramaId: true, drama: { select: { title: true } } },
      orderBy: { dramaId: "asc" },
    })
  ).map((row) => ({ dramaId: row.dramaId, title: row.drama.title, licenseEndDate: parsed }));
}
export const copyrightReminder: ReminderRule = {
  targets: (tx, query) => listDramasLicenseEndingOn(tx, DateSchema.parse(query.date)),
};
