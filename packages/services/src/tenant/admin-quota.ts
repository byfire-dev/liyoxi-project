import { EntityIdParamsSchema, EntityQuotaUpdateBodySchema } from "@liyoxi/contract";
import type { EntityCard, EntityQuotaUpdateBody } from "@liyoxi/contract";
import { record } from "../audit/index.js";
import type { AuditRequestMeta } from "../audit/index.js";
import { assertIssuedScope, authorize, entityScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, bumpLockVersion, lockRows } from "../kernel/index.js";
import type {
  Clock,
  IdempotencyContext,
  IdentityContext,
  MerchantFactsReader,
  Tx,
  TxRunner,
} from "../kernel/index.js";
import { adminEntityGetIn } from "./admin-read.js";
import type { TenantAdminReadDeps } from "./admin-read.js";

interface Deps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly adminRead?: TenantAdminReadDeps;
  readonly facts: MerchantFactsReader;
}
const requirement = {
  module: { module: "merchant", need: "view" },
  permission: "merchant.quota.override",
} as const;
async function currentStaff(tx: Tx, staff: StaffContext): Promise<void> {
  const row = await tx.staff.findUnique({
    where: { id: staff.staff.id },
    select: { status: true, staffRoleKey: true, staffGroupId: true, isLead: true },
  });
  if (
    row?.status !== "active" ||
    row.staffRoleKey !== "super_admin" ||
    row.staffRoleKey !== staff.staff.roleKey ||
    row.staffGroupId !== staff.staff.staffGroupId ||
    row.isLead !== staff.staff.isLead
  )
    throw new AppError("PERMISSION_DENIED");
}

/** 入口先授权再进入 required；缓存命中不运行写事务内的函数。 */
export async function updateEntityQuota(
  deps: Deps,
  ctx: IdentityContext,
  staff: StaffContext,
  input: EntityQuotaUpdateBody & { readonly entityId: string },
  options: { readonly idem: IdempotencyContext; readonly meta: AuditRequestMeta },
): Promise<EntityCard> {
  if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  assertIssuedScope(staff.scope);
  authorize(staff, requirement, deps.clock.now());
  const { entityId, ...rawBody } = input;
  const params = EntityIdParamsSchema.safeParse({ entityId });
  const parsed = EntityQuotaUpdateBodySchema.safeParse(rawBody);
  if (!params.success || !parsed.success) throw new AppError("VALIDATION_FAILED");
  if (options?.idem?.mode !== "required") throw new AppError("INTERNAL");
  const body = parsed.data;
  const meta = { ...options.meta };
  // 只读快照在 claim 之前；不承诺原3秒claim等待期间会话/角色全局线性化。
  await deps.tx.run(async (tx) => {
    await currentStaff(tx, staff);
  });
  authorize(staff, requirement, deps.clock.now());
  return deps.tx.run(
    async (tx) => {
      await lockRows(tx, "staff", [staff.staff.id], "share");
      await lockRows(tx, "entity", [entityId]);
      await currentStaff(tx, staff);
      const row = await tx.entity.findFirst({
        where: { AND: [{ id: entityId }, entityScope(staff.scope)] },
        select: {
          lifecycle: true,
          lockVersion: true,
          storeLimitOverride: true,
          memberLimitOverride: true,
        },
      });
      if (!row) throw new AppError("NOT_FOUND");
      if (row.lifecycle !== "active") throw new AppError("STATE_NOT_ALLOWED");
      if (body.lockVersion !== row.lockVersion)
        throw new AppError("VERSION_CONFLICT", { details: { lockVersion: row.lockVersion } });
      if (
        body.confirm.storeLimitOverride !== row.storeLimitOverride ||
        body.confirm.memberLimitOverride !== row.memberLimitOverride
      )
        throw new AppError("CONFIRM_MISMATCH");
      const before = {
        storeLimitOverride: row.storeLimitOverride,
        memberLimitOverride: row.memberLimitOverride,
      };
      const after = {
        storeLimitOverride:
          body.storeLimitOverride !== undefined ? body.storeLimitOverride! : row.storeLimitOverride,
        memberLimitOverride:
          body.memberLimitOverride !== undefined
            ? body.memberLimitOverride!
            : row.memberLimitOverride,
      };
      // 完整锁和所有前提读后取新时刻；先验证再做第一笔写。
      const at = deps.clock.now();
      authorize(staff, requirement, at);
      await bumpLockVersion(tx, { table: "entity", id: entityId, expected: body.lockVersion });
      await tx.entity.update({ where: { id: entityId }, data: { ...after, updatedAt: at } });
      const result = await adminEntityGetIn(tx, deps.adminRead, deps.facts, at, staff, entityId);
      await record(tx, ctx.actor, meta, {
        stream: "ops",
        category: "merchant_quota",
        action: "admin.entity.quota.update",
        summary: "调整主体门店与成员额度",
        entityId,
        target: { type: "entity", id: entityId },
        reason: { code: "other", text: body.reasonText },
        before,
        after,
        fields: ["storeLimitOverride", "memberLimitOverride"],
      });
      return result;
    },
    { idem: options.idem },
  );
}
