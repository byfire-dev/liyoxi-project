import { calendarDate, endOfDay, startOfDay } from "@liyoxi/shared/time";
import { buildStaffContext, isStaffRoleKey, normalizeRoleConfig } from "../authz/index.js";
import { assertLockOrder } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { openField } from "../security/index.js";
import type { Keyring } from "../security/index.js";

/** Real active staff contexts, without a session, step-up or any mutation. */
export async function staffContextsForNotify(tx: Tx) {
  const rows = await tx.staff.findMany({ include: { staffRole: true }, orderBy: { id: "asc" } });
  return rows.flatMap((row) =>
    row.status !== "active" || !isStaffRoleKey(row.staffRole.key)
      ? []
      : [
          buildStaffContext({
            staff: {
              id: row.id,
              roleKey: row.staffRole.key,
              isLead: row.isLead,
              staffGroupId: row.staffGroupId,
            },
            role: normalizeRoleConfig(row.staffRole.key, row.staffRole),
            groupStaffIds: rows
              .filter(
                (other) => row.staffGroupId !== null && other.staffGroupId === row.staffGroupId,
              )
              .map((other) => other.id),
            stepUpAt: null,
          }),
        ],
  );
}

export async function staffTargetForNotify(tx: Tx, id: string, keys: () => Keyring | null) {
  assertLockOrder(tx, "staff", [id]);
  await tx.$queryRaw`SELECT id FROM staff WHERE id = ${id}::uuid FOR NO KEY UPDATE`;
  const row = await tx.staff.findUnique({ where: { id } });
  if (!row || row.status !== "active") return null;
  const keyring = keys();
  return {
    active: true,
    ...(row.wecomBindStatus === "bound" && row.wecomUserid ? { wecomUserid: row.wecomUserid } : {}),
    ...(keyring
      ? {
          phone: openField(keyring, "staff.phone_enc", row.phoneEnc),
          phoneRef: Buffer.from(row.phoneBidx).toString("hex"),
          phoneMask: row.phoneMask,
        }
      : {}),
  };
}

export async function followUpForNotify(tx: Tx, id: string) {
  const row = await tx.followUp.findUnique({ where: { id } });
  return row
    ? {
        bizType: "follow_up",
        bizId: row.id,
        entityId: row.entityId,
        storeId: row.storeId,
        status: row.doneAt === null && row.nextFollowAt !== null ? "pending" : "done",
        version: row.lockVersion,
        name: "跟进事项",
        ...(row.nextFollowAt ? { targetDate: calendarDate(row.nextFollowAt) } : {}),
        staffIds: row.ownerStaffId ? [row.ownerStaffId] : [],
      }
    : null;
}

export async function followUpsDueForNotify(tx: Tx, now: Date) {
  return tx.followUp.findMany({
    where: {
      doneAt: null,
      nextFollowAt: { gte: startOfDay(calendarDate(now)), lte: endOfDay(calendarDate(now)) },
      ownerStaff: { status: "active" },
    },
    select: { id: true },
    orderBy: [{ nextFollowAt: "asc" }, { id: "asc" }],
  });
}

export async function activeStaffForNotify(
  tx: Tx,
  query: { roleKey?: string; isLead?: boolean; ids?: string[] },
) {
  return (
    await tx.staff.findMany({
      where: {
        status: "active",
        ...(query.roleKey ? { staffRole: { key: query.roleKey } } : {}),
        ...(query.isLead === undefined ? {} : { isLead: query.isLead }),
        ...(query.ids ? { id: { in: query.ids } } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
    })
  ).map((row) => row.id);
}
