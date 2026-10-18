import type { PrismaClient } from "@liyoxi/db";
import { vi } from "vitest";
import type { StoreCreateBody } from "@liyoxi/contract";
import { paramsAt } from "../../config/index.js";
import {
  createIdempotencyContext,
  createIdentityContext,
  guardProviderCall,
  uuidv7,
} from "../../kernel/index.js";
import type { IdentityContext, TxRunner } from "../../kernel/index.js";
import { assertCurrentSessionForTest, snapshotTables } from "../../testing/index.js";
import { createTenant } from "../index.js";
import type { TenantDeps } from "../index.js";
import { acceptHarness, APPID, SLOW } from "./invitation-accept.js";

export { APPID, SLOW };
export const BODY: StoreCreateBody = {
  name: "公开新增分店",
  addressDetail: "公开新址二号",
  industryCode: "C990",
  categoryCode: "C991",
};
export const TABLES = [
  "store",
  "store_profile",
  "entity",
  "entity_member",
  "store_member",
  "store_service_item",
  "store_profile_media",
  "file_ref",
  "status_transition",
  "audit_log",
  "outbox_event",
  "timer",
];
type Ports = NonNullable<TenantDeps["storeCreation"]>;
export function storeIdem(ctx: IdentityContext, body: StoreCreateBody, key = uuidv7()) {
  return createIdempotencyContext({
    mode: "required",
    scope: "m.store.create",
    actor: ctx.actor,
    key,
    request: { method: "POST", body, storeId: ctx.storeId },
  });
}

export async function storeHarness(prisma: PrismaClient) {
  const base = await acceptHarness(prisma);
  const validated = vi.fn<Ports["validateBasics"]>(async () => {
    // 本域替身只证明三段式外检不持有事务；真实Profile与四项复制由ops/API整叶证明。
    guardProviderCall({ provider: "wechat", method: "checkText" });
  });
  const initialized = vi.fn<Ports["initialize"]>(async (tx, ctx, _principal, input) => {
    // 最小typed测试端口只创建真实档案行，不伪装三类资料或品牌复制已执行。
    const now = base.clock.now();
    await tx.storeProfile.create({
      data: {
        storeId: input.targetStoreId,
        entityId: ctx.entityId!,
        ...input.initial,
        copiedFromStoreId: input.copyFromStoreId,
        copyOptions: [...input.copyOptions],
        createdAt: now,
        updatedAt: now,
      },
    });
  });
  const ports: Ports = {
    assertSession: async (tx, principal, now) => {
      await assertCurrentSessionForTest(tx, principal, now, APPID);
    },
    validateBasics: validated,
    initialize: initialized,
  };
  function side(client = prisma, runner?: TxRunner, overrides: Partial<Ports> = {}) {
    const service = base.side(client, runner);
    const tenant = createTenant({
      ...service,
      storeCreation: { ...ports, ...overrides },
      archiveTimers: service.timers,
    });
    return { ...service, tenant };
  }
  const service = side();
  let originalLimit: number | undefined;
  async function limit(value: number) {
    originalLimit ??= (await paramsAt(prisma, ["tenant.default_store_limit"], base.clock.now()))[
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
  async function restoreLimit() {
    if (originalLimit === undefined) return;
    await limit(originalLimit);
    originalLimit = undefined;
  }
  async function owner() {
    const parent = await base.owner();
    await prisma.entity.update({ where: { id: parent.entityId }, data: { storeLimitOverride: 3 } });
    return {
      ...parent,
      ctx: createIdentityContext({
        ...parent.ctx,
        actor: { type: "merchant", id: parent.userId, client: "weapp", role: parent.role },
      }),
    };
  }
  async function create(
    user: Awaited<ReturnType<typeof owner>>,
    body: StoreCreateBody = BODY,
    on = service.tenant,
    key = uuidv7(),
    ctx = user.ctx,
  ) {
    return on.createStore(ctx, body, {
      principal: user.principal,
      idem: storeIdem(ctx, body, key),
    });
  }
  return {
    ...base,
    ...service,
    owner,
    side,
    create,
    ports,
    validated,
    initialized,
    limit,
    restoreLimit,
    state: () => snapshotTables(prisma, TABLES),
  };
}
export type StoreHarness = Awaited<ReturnType<typeof storeHarness>>;
export type Owner = Awaited<ReturnType<StoreHarness["owner"]>>;
