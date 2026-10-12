import { EntityCloseBodySchema, EntityIdParamsSchema } from "@liyoxi/contract";
import type { EntityCard, EntityCloseBody } from "@liyoxi/contract";
import { assertIssuedScope, authorize, entityScope } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type {
  Clock,
  IdempotencyContext,
  IdentityContext,
  MerchantFactsReader,
  Tx,
  TxRunner,
} from "../kernel/index.js";
import type { Flow } from "../flow/index.js";
import { adminEntityGetIn } from "./admin-read.js";
import type { TenantAdminReadDeps } from "./admin-read.js";
import { closeEntityIn } from "./entity-close.js";
import type { CloseEntityDeps } from "./entity-close.js";

interface Deps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly flow: Flow;
  readonly entityClose?: Pick<CloseEntityDeps, "assembly" | "timers">;
  readonly adminRead?: TenantAdminReadDeps;
  readonly facts: MerchantFactsReader;
}
const requirement = {
  module: { module: "merchant", need: "view" },
  permission: "merchant.entity.close",
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

/** required 命中不会运行写闭包，因此当前授权与可见性必须先查。 */
export async function closeEntity(
  deps: Deps,
  ctx: IdentityContext,
  staff: StaffContext,
  input: EntityCloseBody & { readonly entityId: string },
  options: { readonly idem: IdempotencyContext },
): Promise<EntityCard> {
  if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id)
    throw new AppError("PERMISSION_DENIED");
  assertIssuedScope(staff.scope);
  authorize(staff, requirement, deps.clock.now());
  const { entityId, ...rawBody } = input;
  const params = EntityIdParamsSchema.safeParse({ entityId });
  const parsed = EntityCloseBodySchema.safeParse(rawBody);
  if (!params.success || !parsed.success) throw new AppError("VALIDATION_FAILED");
  if (options?.idem?.mode !== "required" || !deps.entityClose) throw new AppError("INTERNAL");
  const core = { ...deps.entityClose, clock: deps.clock, flow: deps.flow };
  await deps.tx.run(async (tx) => {
    await currentStaff(tx, staff);
    if (
      !(await tx.entity.findFirst({
        where: { AND: [{ id: entityId }, entityScope(staff.scope)] },
        select: { id: true },
      }))
    )
      throw new AppError("NOT_FOUND");
  });
  authorize(staff, requirement, deps.clock.now());
  return deps.tx.run(
    async (tx) => {
      // 不在此处拿业务锁：原核心必须首先调用 order 的完整低序 prepare。
      authorize(staff, requirement, deps.clock.now());
      await closeEntityIn(tx, core, { ctx, staff }, { entityId, ...parsed.data });
      return adminEntityGetIn(tx, deps.adminRead, deps.facts, deps.clock.now(), staff, entityId);
    },
    { idem: options.idem },
  );
}
