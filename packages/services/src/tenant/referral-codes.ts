import { ReferralCodeRowSchema } from "@liyoxi/contract";
import type {
  ReferralCodeCreateBody,
  ReferralCodeList,
  ReferralCodeListQuery,
  ReferralCodeRow,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { record } from "../audit/index.js";
import type { AuditRequestMeta } from "../audit/index.js";
import { authorize } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, isUniqueViolation, lockRows, uuidv7 } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx } from "../kernel/index.js";
const include = {
  ownerStaff: true,
  _count: { select: { merchantUsers: true, entities: true } },
} as const;
type Row = Prisma.ReferralCodeGetPayload<{ include: typeof include }>;
const view = (row: Row): ReferralCodeRow =>
  ReferralCodeRowSchema.parse({
    referralCodeId: row.id,
    code: row.code,
    sourceType: row.sourceType,
    owner: row.ownerStaff
      ? {
          staffId: row.ownerStaff.id,
          staffNo: row.ownerStaff.staffNo,
          name: row.ownerStaff.name,
          roleKey: row.ownerStaff.staffRoleKey,
          isLead: row.ownerStaff.isLead,
          status: row.ownerStaff.status,
        }
      : null,
    label: row.label,
    status: row.status,
    disabledAt: row.disabledAt?.toISOString() ?? null,
    registeredUserCount: row._count.merchantUsers,
    entityCount: row._count.entities,
    createdAt: row.createdAt.toISOString(),
  });
function allow(clock: Clock, ctx: IdentityContext, staff: StaffContext, write: boolean) {
  if (ctx.actor.type !== "staff" || ctx.actor.client !== "admin" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  authorize(
    staff,
    {
      module: { module: "merchant", need: "view" },
      permission: write ? "merchant.referral_code.manage" : null,
    },
    clock.now(),
  );
}
export async function listReferralCodesIn(
  tx: Tx,
  clock: Clock,
  ctx: IdentityContext,
  staff: StaffContext,
  input: ReferralCodeListQuery,
): Promise<ReferralCodeList> {
  allow(clock, ctx, staff, false);
  const where: Prisma.ReferralCodeWhereInput = {
    ...(input.q
      ? {
          OR: [
            { code: { contains: input.q, mode: "insensitive" } },
            { label: { contains: input.q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(input.sourceType ? { sourceType: { in: input.sourceType } } : {}),
    ...(input.status ? { status: { in: input.status } } : {}),
    ...(input.ownerStaffId ? { ownerStaffId: input.ownerStaffId } : {}),
  };
  const total = await tx.referralCode.count({ where });
  const rows = await tx.referralCode.findMany({
    where,
    include,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (input.page - 1) * input.pageSize,
    take: input.pageSize,
  });
  return { items: rows.map(view), page: input.page, pageSize: input.pageSize, total };
}
async function audit(
  tx: Tx,
  ctx: IdentityContext,
  meta: AuditRequestMeta,
  row: Row,
  op: "create" | "disable" | "enable",
  before: string | null,
  reasonText?: string,
) {
  await record(tx, ctx.actor, meta, {
    stream: "ops",
    category: "referral_code",
    action: `tenant.referral_code.${op}`,
    summary: { create: "登记渠道码", disable: "停用渠道码", enable: "启用渠道码" }[op],
    target: { type: "referral_code", id: row.id, label: row.code },
    ...(reasonText ? { reason: { code: "other", text: reasonText } } : {}),
    before: before ? { status: before } : null,
    after: {
      code: row.code,
      sourceType: row.sourceType,
      ownerStaffId: row.ownerStaffId,
      status: row.status,
    },
    fields: ["code", "sourceType", "ownerStaffId", "status"],
  });
}
/** 当前员工鉴权由identity完成；同Tx共享员工锁使sales归属在创建时仍有效。 */
export async function createReferralCodeIn(
  tx: Tx,
  clock: Clock,
  ctx: IdentityContext,
  staff: StaffContext,
  input: ReferralCodeCreateBody,
  meta: AuditRequestMeta,
): Promise<ReferralCodeRow> {
  allow(clock, ctx, staff, true);
  await lockRows(
    tx,
    "staff",
    [...new Set([staff.staff.id, ...(input.ownerStaffId ? [input.ownerStaffId] : [])])].sort(),
    "share",
  );
  if (input.ownerStaffId) {
    const owner = await tx.staff.findUnique({
      where: { id: input.ownerStaffId },
      select: { status: true },
    });
    if (!owner || owner.status !== "active") throw new AppError("VALIDATION_FAILED");
  }
  const now = clock.now();
  let row: Row;
  try {
    row = await tx.referralCode.create({
      data: {
        id: uuidv7(),
        code: input.code,
        sourceType: input.sourceType,
        ownerStaffId: input.ownerStaffId ?? null,
        label: input.label ?? null,
        status: "active",
        createdAt: now,
        updatedAt: now,
      },
      include,
    });
  } catch (error) {
    if (isUniqueViolation(error, ["uq_referral_code_code"]))
      throw new AppError("REFERRAL_CODE_TAKEN");
    throw error;
  }
  await audit(tx, ctx, meta, row, "create", null);
  return view(row);
}
/** referral_code不参加业务锁排序，原状态CAS使同一状态动作只成功一次。 */
export async function setReferralCodeStatusIn(
  tx: Tx,
  clock: Clock,
  ctx: IdentityContext,
  staff: StaffContext,
  id: string,
  op: "disable" | "enable",
  meta: AuditRequestMeta,
  reasonText?: string,
): Promise<ReferralCodeRow> {
  allow(clock, ctx, staff, true);
  const before = op === "disable" ? "active" : "disabled",
    status = op === "disable" ? "disabled" : "active",
    now = clock.now();
  const count = await tx.referralCode.updateMany({
    where: { id, status: before },
    data: {
      status,
      disabledAt: op === "disable" ? now : null,
      lockVersion: { increment: 1 },
      updatedAt: now,
    },
  });
  if (count.count === 0) {
    if (!(await tx.referralCode.findUnique({ where: { id }, select: { id: true } })))
      throw new AppError("NOT_FOUND");
    throw new AppError("STATE_NOT_ALLOWED");
  }
  const row = await tx.referralCode.findUniqueOrThrow({ where: { id }, include });
  await audit(tx, ctx, meta, row, op, before, reasonText);
  return view(row);
}
