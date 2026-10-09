import type { PrismaClient } from "@liyoxi/db";
import type { OrderCreateBody } from "@liyoxi/contract";
import {
  createLedgerHarness,
  assembleForTest,
  createFakeProviders,
  openTerm,
  prepareOrderProfile as profile,
  prepareOrderDrama as drama,
  prepareOrderAgreement as version,
} from "../../testing/index.js";
type LedgerHarnessOptions = NonNullable<Parameters<typeof createLedgerHarness>[1]>;
import { createBizNoIssuer, createIdentityContext, uuidv7 } from "../../kernel/index.js";
import { createContent } from "../../content/index.js";
import { createFlow } from "../../flow/index.js";
import { createMedia } from "../../media/index.js";
import { createDocs } from "../../docs/index.js";
import { createConfig } from "../../config/index.js";
import { createTimers } from "../../timers/index.js";
import { createOrderService } from "../service.js";
import type { OrderActor, OrderDeps } from "../context.js";
export function harness(prisma: PrismaClient, options: LedgerHarnessOptions = {}) {
  const h = createLedgerHarness(prisma, options),
    assembly = assembleForTest({ entry: "api" }),
    fake = createFakeProviders({ clock: h.clock }),
    flow = createFlow({ assembly, clock: h.clock, events: h.events }),
    media = createMedia({
      tx: h.tx,
      clock: h.clock,
      assembly,
      events: h.events,
      storage: fake.storage,
    });
  const deps: OrderDeps = {
    tx: h.tx,
    clock: h.clock,
    assembly,
    bizNo: createBizNoIssuer({ clock: h.clock, appEnv: "test" }),
    ledger: h.ledger,
    docs: createDocs({ tx: h.tx, clock: h.clock }),
    content: createContent({ clock: h.clock, flow, media, assembly, events: h.events }),
    media,
    events: h.events,
    timers: createTimers({ assembly }),
    config: createConfig({ db: prisma, clock: h.clock, redis: null, report: () => {} }),
  };
  return { ...h, assembly, fake, deps, order: createOrderService(deps) };
}
export type Harness = ReturnType<typeof harness>;
export async function buyer(
  h: Harness,
  options: { planCode?: string; gate?: "full" | "parallel"; subscribed?: boolean } = {},
) {
  const made = await h.make.merchant({ verified: true }),
    member = await h.prisma.entityMember.findFirstOrThrow({
      where: { entityId: made.entity.id, merchantUserId: made.user.id },
    });
  const actor: OrderActor = {
    ctx: createIdentityContext({
      actor: { type: "merchant", id: made.user.id, client: "weapp" },
      requestId: `order_${uuidv7()}`,
    }),
    membership: {
      memberId: member.id,
      entityId: made.entity.id,
      storeId: made.store.id,
      role: "owner",
      storeMode: "active",
    },
  };
  await profile(h.prisma, h, actor);
  if (options.gate === "parallel")
    await h.prisma.store.update({
      where: { id: made.store.id },
      data: { qualificationStatus: "pending", isPrimary: true },
    });
  const term =
    options.subscribed === false
      ? null
      : (await openTerm(h, { entityId: made.entity.id, planCode: options.planCode ?? "pro" })).term;
  const accountId = uuidv7(),
    now = h.clock.now(),
    staff = await h.make.staff({ staffRoleKey: "publisher" });
  await h.prisma.channelAccount.create({
    data: {
      id: accountId,
      entityId: made.entity.id,
      storeId: made.store.id,
      platform: "douyin",
      accountName: "测试账号",
      accountUid: accountId,
      accountUidNorm: accountId,
      status: "available",
      accountType: "personal",
      submittedAt: now,
      verifiedAt: now,
      verifiedByStaffId: staff.id,
      createdAt: now,
      updatedAt: now,
    },
  });
  return { ...made, actor, term, accountId };
}
export async function body(
  h: Harness,
  b: Awaited<ReturnType<typeof buyer>>,
  ids: readonly string[],
  top = false,
): Promise<OrderCreateBody> {
  const q = await h.order.quote(b.actor, {
    dramaIds: [...ids],
    isTopModel: top,
    channelAccountIds: [b.accountId],
  });
  return {
    dramaIds: [...ids],
    channelAccountIds: [b.accountId],
    focusCodes: ["W115F"],
    isTopModel: top,
    agreementVersionId: q.agreement.agreementVersionId,
    expect: q.expect,
  };
}
export async function residual(h: Harness, entityId: string) {
  return {
    orders: await h.prisma.dramaOrder.count({ where: { entityId } }),
    items: await h.prisma.orderItem.count({ where: { entityId } }),
    holds: await h.prisma.pointHold.count({ where: { entityId, refType: "order_item" } }),
    consents: await h.prisma.agreementConsent.count({ where: { entityId, scene: "order_submit" } }),
  };
}

export { profile, drama, version };
