import type { Prisma, PrismaClient } from "@liyoxi/db";
import { media } from "../../index.js";
import { createIdempotencyContext, uuidv7 } from "../../kernel/index.js";
import type { IdentityContext, Tx, TxRunner } from "../../kernel/index.js";
import { snapshotTables } from "../../testing/index.js";
import type { AdjustableClock } from "../../testing/index.js";
import { createTenant } from "../index.js";
import type { TenantDeps } from "../index.js";
import { removalHarness, removalServices, memberContext, SLOW } from "./member-removal.js";

export { memberContext, SLOW };
export const TABLES = [
  "entity",
  "store",
  "entity_member",
  "store_member",
  "merchant_user",
  "invitation",
  "store_asset",
  "store_asset_usage",
  "user_session",
  "portal_session",
  "agreement_consent",
  "billing_account",
  "subscription_term",
  "audit_log",
  "outbox_event",
  "status_transition",
];
type Options = {
  counts?: TenantDeps["readMemberAssetCounts"] | null;
  events?: TenantDeps["events"] | null;
};

// 仅测试组合根从公开 namespace 接实际 media；生产 tenant 不直接依赖同层域。
export function managementServices(
  prisma: PrismaClient,
  clock?: AdjustableClock,
  runner?: TxRunner,
  options: Options = {},
) {
  const base = removalServices(prisma, clock, runner);
  const tenant = createTenant({
    tx: base.tx,
    clock: base.clock,
    flow: base.flow,
    assembly: base.assembly,
    ...(options.counts === null
      ? {}
      : { readMemberAssetCounts: options.counts ?? media.readMemberAssetCounts }),
    ...(options.events === null ? {} : { events: options.events ?? base.events }),
  });
  return { ...base, tenant };
}

export function managementHarness(prisma: PrismaClient) {
  const base = removalHarness(prisma);
  const services = managementServices(prisma, base.clock);
  const { clock } = base;
  // 这些是合法历史前提，不冒称本测试执行了尚未交付的邀请/上传 producer。
  async function invitation(
    owner: { entityId: string; storeId: string; memberId: string },
    extra: Partial<Prisma.InvitationCreateManyInput> = {},
  ) {
    const now = clock.now();
    return prisma.invitation.create({
      data: {
        id: uuidv7(),
        entityId: owner.entityId,
        storeId: owner.storeId,
        role: "clerk",
        inviterMemberId: owner.memberId,
        tokenHash: Buffer.from(uuidv7().replaceAll("-", "").repeat(2), "hex"),
        tokenEnc: null,
        status: "pending",
        clientRequestId: uuidv7(),
        createdAt: new Date(now.getTime() - 1_000),
        updatedAt: now,
        expiresAt: new Date(now.getTime() + 3_600_000),
        ...extra,
      },
    });
  }
  async function asset(
    scope: { entityId: string; storeId: string },
    userId: string,
    extra: Partial<Prisma.StoreAssetCreateManyInput> = {},
  ) {
    const now = clock.now();
    return prisma.storeAsset.create({
      data: {
        id: uuidv7(),
        entityId: scope.entityId,
        storeId: scope.storeId,
        type: "text",
        textBody: "成员管理的虚构历史素材",
        uploadActorType: "merchant",
        uploadActorId: userId,
        uploadActorRole: "clerk",
        uploadClient: "weapp",
        processingState: "pending",
        reviewState: "unreviewed",
        adoptedCount: 0,
        idempotencyKey: uuidv7(),
        createdAt: now,
        updatedAt: now,
        ...extra,
      },
    });
  }
  return {
    ...base,
    ...services,
    invitation,
    asset,
    state: (tx: Tx | PrismaClient = prisma) => snapshotTables(tx, TABLES),
  };
}
export type ManagementHarness = ReturnType<typeof managementHarness>;
export type Owner = Awaited<ReturnType<ManagementHarness["owner"]>>;
export type Clerk = Awaited<ReturnType<ManagementHarness["clerk"]>>;

export function updateIdem(
  ctx: IdentityContext,
  memberId: string,
  storeIds: readonly string[],
  key = uuidv7(),
) {
  return createIdempotencyContext({
    mode: "required",
    scope: "m.member.update",
    actor: ctx.actor,
    key,
    request: {
      method: "PATCH",
      pathParams: { memberId },
      body: { storeIds },
      storeId: ctx.storeId,
    },
  });
}
