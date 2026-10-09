import { STAFF_ROLE_KEY } from "@liyoxi/contract";
import { normalizeRoleConfig } from "../authz/index.js";
import {
  AppError,
  createIdentityContext,
  LOCK_ORDER,
  lockRows,
  staffFollowUpPort,
} from "../kernel/index.js";
import type { Assembly, InvariantViolation, Tx } from "../kernel/index.js";
import type { StaffManagementDeps } from "./management.js";
import { lockStaffSet } from "./manage-full.js";
import { transferWork, workSources } from "./work.js";
export const FULL_STAFF_CHECKS = [
  "I1",
  "I2",
  "I3",
  "I4",
  "I5",
  "I6",
  "I7",
  "I9",
  "I10",
  "I11",
  "I12",
  "I13",
] as const;
export type FullStaffCheck = (typeof FULL_STAFF_CHECKS)[number];
export async function findStaffViolations(
  tx: Tx,
  code: FullStaffCheck,
  deps?: StaffManagementDeps,
  assembly?: Assembly,
): Promise<InvariantViolation[]> {
  const result: InvariantViolation[] = [];
  const add = (id: string, problem: string, type = "staff", entityId?: string) =>
    result.push({ subject: { type, id }, ...(entityId ? { entityId } : {}), detail: { problem } });
  const [staff, groups] = await Promise.all([
    tx.staff.findMany({ orderBy: { id: "asc" } }),
    tx.staffGroup.findMany(),
  ]);
  const byId = new Map(staff.map((r) => [r.id, r]));
  const groupById = new Map(groups.map((r) => [r.id, r]));
  if (
    code === "I2" &&
    !staff.some((r) => r.status === "active" && r.staffRoleKey === "super_admin")
  )
    result.push({
      subject: { type: "staff_role", key: "super_admin" },
      detail: { problem: "no_active_super_admin" },
    });
  if (code === "I3")
    for (const r of staff)
      if (r.staffGroupId && groupById.get(r.staffGroupId)?.staffRoleKey !== r.staffRoleKey)
        add(r.id, "group_role_mismatch");
  if (code === "I4")
    for (const r of staff)
      if (r.handoverToStaffId && byId.get(r.handoverToStaffId)?.staffRoleKey !== r.staffRoleKey)
        add(r.id, "handover_role_mismatch");
  if (code === "I5")
    for (const role of STAFF_ROLE_KEY.values)
      if (groups.filter((g) => g.isDefault && g.staffRoleKey === role).length !== 1)
        result.push({
          subject: { type: "staff_role", key: role },
          detail: { problem: "default_group_count" },
        });
  if (code === "I6")
    for (const g of groups) {
      const members = staff.filter((r) => r.staffGroupId === g.id);
      if (members.length && !members.some((r) => r.status === "active" && r.isLead))
        add(g.id, "no_active_group_lead", "staff_group");
    }
  if (code === "I7")
    for (const role of await tx.staffRole.findMany()) {
      const cfg = normalizeRoleConfig(role.key as Parameters<typeof normalizeRoleConfig>[0], role);
      if (cfg.issues.length)
        result.push({
          subject: { type: "staff_role", key: role.key },
          detail: { problem: "role_configuration_invalid", issues: cfg.issues },
        });
    }
  if (code === "I9")
    for (const m of await tx.assignmentPoolMember.findMany())
      if (byId.get(m.staffId)?.status !== "active" || byId.get(m.staffId)?.staffRoleKey !== m.pool)
        add(m.staffId, "pool_role_mismatch");
  if (code === "I13")
    for (const f of await tx.followUp.findMany({
      where: { nextFollowAt: { not: null }, doneAt: null, ownerStaffId: { not: null } },
    })) {
      if (byId.get(f.ownerStaffId!)?.status === "disabled")
        add(f.id, "disabled_follow_up_owner", "follow_up", f.entityId);
    }
  if (code === "I11") {
    const rows = await tx.assignmentHistory.findMany({
      where: {
        source: "store_manager",
        subjectType: "store",
        contactDueAt: { not: null },
        contactedAt: null,
        contactVoidedAt: null,
      },
      orderBy: { seq: "desc" },
    });
    const all = await tx.assignmentHistory.findMany({
      where: { source: "store_manager", subjectType: "store" },
      orderBy: { seq: "desc" },
      select: { id: true, subjectId: true },
    });
    const latest = new Map<string, string>();
    for (const row of all) if (!latest.has(row.subjectId)) latest.set(row.subjectId, row.id);
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.subjectId) || latest.get(row.subjectId) !== row.id)
        add(row.id, "non_latest_live_contact_obligation", "assignment_history");
      seen.add(row.subjectId);
    }
  }
  if (code === "I12") {
    if (!assembly) throw new AppError("INTERNAL", { message: "跟进引用事实尚未装配" });
    const readers = assembly.portEntries(staffFollowUpPort);
    for (const f of await tx.followUp.findMany()) {
      const read = readers.get(f.subjectType);
      if (!read)
        throw new AppError("INTERNAL", {
          message: "跟进对象类型尚未登记",
          details: { subjectType: f.subjectType },
        });
      const fact = await read(tx, f.subjectId);
      if (!fact || fact.entityId !== f.entityId || fact.storeId !== f.storeId)
        add(f.id, "follow_up_subject_scope_mismatch", "follow_up", f.entityId);
    }
  }
  if (code === "I1" || code === "I10") {
    if (!deps) throw new AppError("INTERNAL", { message: "员工在办检查尚未装配" });
    const sources = workSources(deps);
    const disabled = staff.filter((r) => r.status === "disabled");
    const histories = await tx.assignmentHistory.findMany({
      where: { fromStaffId: { in: disabled.map((r) => r.id) } },
      orderBy: { seq: "desc" },
      select: { fromStaffId: true, toStaffId: true },
    });
    const recipients = new Map<string, string>();
    for (const h of histories)
      if (!recipients.has(h.fromStaffId)) recipients.set(h.fromStaffId, h.toStaffId);
    if (code === "I10") {
      await lockStaffSet(
        tx,
        disabled.flatMap((r) => [r.id, ...(recipients.has(r.id) ? [recipients.get(r.id)!] : [])]),
      );
      const byTable = new Map<Exclude<keyof typeof LOCK_ORDER, "assignment_cursor">, string[]>();
      for (const r of disabled)
        for (const item of await sources.read(tx, { staffId: r.id, now: deps.clock.now() }))
          for (const ref of item.locks) {
            const ids = byTable.get(ref.table) ?? [];
            ids.push(ref.id);
            byTable.set(ref.table, ids);
          }
      for (const [table, ids] of [...byTable].sort(([a], [b]) => LOCK_ORDER[a] - LOCK_ORDER[b]))
        await lockRows(tx, table, ids);
    }
    for (const stale of disabled) {
      const row = await tx.staff.findUniqueOrThrow({ where: { id: stale.id } });
      const items = await sources.read(tx, { staffId: row.id, now: deps.clock.now() });
      if (code === "I1") {
        if (items.length) add(row.id, "disabled_staff_open_work");
        if (await tx.staffSession.count({ where: { staffId: row.id, revokedAt: null } }))
          add(row.id, "disabled_staff_live_session");
        if (await tx.assignmentPoolMember.count({ where: { staffId: row.id } }))
          add(row.id, "disabled_staff_pool_membership");
      } else if (items.length) {
        const targetId = recipients.get(row.id);
        const target = targetId ? await tx.staff.findUnique({ where: { id: targetId } }) : null;
        if (!target || target.status !== "active" || target.staffRoleKey !== row.staffRoleKey) {
          add(row.id, "disabled_open_work_no_current_recipient");
          continue;
        }
        const now = deps.clock.now();
        await transferWork(
          tx,
          deps,
          createIdentityContext({ actor: { type: "system", job: "invariant.full" } }),
          { from: row, to: target, reason: "invariant_fix" },
        );
        result.push({
          subject: { type: "staff", id: row.id },
          detail: { problem: "disabled_staff_open_work", count: items.length },
          healed: { action: "reassigned_to_current_handover_recipient", at: now },
        });
      }
    }
  }
  return result;
}
