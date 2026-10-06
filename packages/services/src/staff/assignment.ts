// M1 分配最小实现：只取池内工号最小的启用员工，忽略城市、当班和游标（G2-A 回补）。
import { ASSIGNMENT_POOL } from "@liyoxi/contract/enums";
import type { StaffBrief } from "@liyoxi/contract";
import { lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { staffBriefOf } from "./me.js";

export type AssignmentPool = (typeof ASSIGNMENT_POOL.values)[number];

/** 推荐只读、不加锁；真实指派用 pickNext，并在任何业务行锁之前调用。 */
export async function recommendedStaff(tx: Tx, pool: AssignmentPool): Promise<StaffBrief | null> {
  const row = await tx.staff.findFirst({
    where: { status: "active", assignmentPoolMembers: { some: { pool } } },
    orderBy: [{ staffNo: "asc" }, { id: "asc" }],
    select: { id: true, staffNo: true, name: true, staffRoleKey: true, isLead: true, status: true },
  });
  return row === null ? null : staffBriefOf(row);
}

export async function pickNext(
  tx: Tx,
  pool: AssignmentPool,
  _scopeKey: string,
): Promise<StaffBrief | null> {
  if (!(ASSIGNMENT_POOL.values as readonly string[]).includes(pool))
    throw new TypeError("分配池未登记");
  const candidate = await recommendedStaff(tx, pool);
  if (candidate === null) return null;
  await lockRows(tx, "staff", [candidate.staffId], "share");
  // 等锁期间可能被禁用：锁住后再读，不把已经禁用的人交出去。
  const row = await tx.staff.findFirst({
    where: { id: candidate.staffId, status: "active", assignmentPoolMembers: { some: { pool } } },
    select: { id: true, staffNo: true, name: true, staffRoleKey: true, isLead: true, status: true },
  });
  return row === null ? null : staffBriefOf(row);
}

/** 上层展示员工摘要的唯一批量入口，不带个人信息与凭据。 */
export async function staffBriefs(tx: Tx, ids: readonly string[]): Promise<StaffBrief[]> {
  const rows = await tx.staff.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, staffNo: true, name: true, staffRoleKey: true, isLead: true, status: true },
    orderBy: [{ staffNo: "asc" }, { id: "asc" }],
  });
  return rows.map(staffBriefOf);
}
