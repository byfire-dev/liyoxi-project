import type { PrismaClient } from "@liyoxi/db";
import { paramsAt } from "../../config/index.js";
import { createIdempotencyContext, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext } from "../../kernel/index.js";
import { snapshotTables } from "../../testing/index.js";
import { archiveHarness, archiveServices, memberContext, SLOW, TABLES } from "./store-archive.js";

export { archiveServices, memberContext, SLOW };
export const RESTORE_TABLES = [
  ...TABLES,
  "idempotency_record",
  "store_profile",
  "store_profile_media",
  "store_service_item",
  "agreement_consent",
];

export function restoreHarness(prisma: PrismaClient) {
  const base = archiveHarness(prisma);
  let originalLimit: number | undefined;
  async function owner() {
    const user = await base.make.merchantUser();
    const result = await base.tenant.createEntity(memberContext(user.id));
    // 首店经真实拥有者创建；第二店及额度覆盖是现有约束允许的历史事实。
    const second = await base.make.store({ entityId: result.entityId });
    await prisma.entity.update({
      where: { id: result.entityId },
      data: { storeLimitOverride: 2 },
    });
    return {
      ...result,
      userId: user.id,
      secondId: second.id,
      ctx: memberContext(user.id, result.entityId, result.storeId),
    };
  }
  async function archived() {
    const own = await owner();
    await base.tenant.archiveStore(own.ctx, { storeId: own.secondId });
    return own;
  }
  async function limit(value: number) {
    if (originalLimit === undefined)
      originalLimit = (await paramsAt(prisma, ["tenant.default_store_limit"], base.clock.now()))[
        "tenant.default_store_limit"
      ];
    base.clock.advance(1);
    const staff = await base.make.staff({ staffRoleKey: "super_admin" });
    await prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key: "tenant.default_store_limit",
        value,
        effectiveAt: base.clock.now(),
        createdAt: base.clock.now(),
        createdByStaffId: staff.id,
      },
    });
  }
  async function restoreParams() {
    if (originalLimit === undefined) return;
    await limit(originalLimit);
    originalLimit = undefined;
  }
  return {
    ...base,
    owner,
    archived,
    limit,
    restoreParams,
    state: () => snapshotTables(prisma, RESTORE_TABLES),
  };
}
export type RestoreHarness = ReturnType<typeof restoreHarness>;
export type Owner = Awaited<ReturnType<RestoreHarness["owner"]>>;
export function restoreIdem(ctx: IdentityContext, storeId: string, key = uuidv7()) {
  return createIdempotencyContext({
    mode: "required",
    scope: "m.store.restore",
    actor: ctx.actor,
    key,
    request: { method: "POST", pathParams: { storeId }, body: null, storeId: ctx.storeId },
  });
}
