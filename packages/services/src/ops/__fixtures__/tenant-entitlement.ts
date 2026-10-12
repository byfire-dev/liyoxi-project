import { createHash } from "node:crypto";
import type { PrismaClient } from "@liyoxi/db";
import { createConfig } from "../../config/index.js";
import { consumeDelivery, createEvents, dispatchDue } from "../../events/index.js";
import type { DeliveryRef, DispatchDeps } from "../../events/index.js";
import { alertsOf, notifyReadOf, uuidv7 } from "../../kernel/index.js";
import type { Assembly, DeliveredEvent, Tx, TxRunner } from "../../kernel/index.js";
import type { NotifyDispatcherService } from "../../notify/index.js";
import {
  assembleForTest,
  createFakeProviders,
  createLedgerHarness,
  openTerm,
  snapshotTables,
  TEST_KEYRING,
} from "../../testing/index.js";
import type { LedgerHarness } from "../../testing/index.js";
import { createNotifyAssembly, createRuntimeNotify } from "../notify-runtime.js";
import {
  createRuntimeTenantEntitlement,
  createTenantEntitlementAssembly,
} from "../tenant-entitlement-runtime.js";

export const SLOW = 120_000;
export const SCENE = "m.quota_exceeded";
export const SUBSCRIBER = "tenant.onEntitlementChanged";
export const TABLES = [
  "entity",
  "store",
  "entity_member",
  "store_member",
  "invitation",
  "merchant_user",
  "billing_account",
  "subscription_term",
  "grant_schedule",
  "point_lot",
  "ledger_operation",
  "point_ledger_entry",
  "outbox_event",
  "notification",
  "merchant_message",
  "notification_delivery",
];
export type Change = "expired" | "rolled_over";
export interface WorldOptions {
  change?: Change;
  stores?: number;
  clerks?: number;
  pending?: number;
  maxStores?: number;
  maxMembers?: number | null;
}

/** Only external delivery and queue transport are controlled; all domain readers are real. */
export function entitlementHarness(prisma: PrismaClient, ledger?: LedgerHarness) {
  const h = ledger ?? createLedgerHarness(prisma);
  const providers = createFakeProviders({ clock: h.clock });
  const scopes: Array<{ close(): Promise<void> }> = [];
  function runtime(
    runner: TxRunner = h.tx,
    options: {
      base?: Assembly;
      attach?: boolean;
      afterNotify?: (tx: Tx, event: DeliveredEvent, count: number) => Promise<void>;
    } = {},
  ) {
    const base = options.base ?? assembleForTest({ entry: "worker" });
    const notifyScope = createNotifyAssembly(base);
    const scope = createTenantEntitlementAssembly(notifyScope.assembly);
    const assembly = scope.assembly;
    const notify = createRuntimeNotify({
      tx: runner,
      clock: h.clock,
      assembly,
      appEnv: "test",
      providers,
      params: createConfig({ db: prisma, clock: h.clock, redis: null }).params,
      keyring: TEST_KEYRING,
      logger: { info() {}, warn() {}, error() {} },
    });
    notifyScope.attach(notify);
    const notice: Pick<NotifyDispatcherService, "sendQuotaExceeded"> = {
      async sendQuotaExceeded(tx, event) {
        const count = await notify.sendQuotaExceeded(tx, event);
        await options.afterNotify?.(tx, event, count);
        return count;
      },
    };
    const service = createRuntimeTenantEntitlement({ clock: h.clock, assembly, notify: notice });
    if (options.attach !== false) scope.attach(service);
    const events = createEvents({ assembly, clock: h.clock, tx: runner });
    const refs: DeliveryRef[] = [];
    const dispatch: DispatchDeps = {
      tx: runner,
      subscribers: events.subscribers,
      alerts: alertsOf(assembly),
      channel: {
        async enqueue(_queue, _jobId, data) {
          const { eventId, subscriber, dispatchNo } = data;
          if (
            typeof eventId !== "string" ||
            typeof subscriber !== "string" ||
            typeof dispatchNo !== "number"
          )
            throw new TypeError("出站队列载荷缺少真实 DeliveryRef 字段");
          refs.push({ eventId, subscriber, dispatchNo });
        },
        downForMs: () => 0,
      },
    };
    const value = {
      runner,
      base,
      scope,
      assembly,
      notify,
      service,
      events,
      dispatch,
      refs,
      consume: (ref: DeliveryRef) => consumeDelivery(dispatch, ref),
      handle: (event: DeliveredEvent) =>
        runner.run((tx) => assembly.subscriber(SUBSCRIBER)!.handle(tx, event)),
      read: (id: string) =>
        runner.run((tx) => notifyReadOf(assembly).read(tx, "tenantQuotaForNotify", id)),
      async queue(eventId: string) {
        while ((await events.expand()).events > 0);
        refs.length = 0;
        await dispatchDue(dispatch);
        const target = refs.find((ref) => ref.eventId === eventId && ref.subscriber === SUBSCRIBER);
        if (!target) throw new Error("真实权益事件没有派发到已登记订阅者");
        for (const ref of refs) {
          if (ref === target) continue;
          const outcome = await consumeDelivery(dispatch, ref);
          if (outcome !== "done") {
            const delivery = await runner.run((tx) =>
              tx.outboxDelivery.findUniqueOrThrow({
                where: {
                  outboxEventId_subscriber: {
                    outboxEventId: ref.eventId,
                    subscriber: ref.subscriber,
                  },
                },
                select: {
                  status: true,
                  lastError: true,
                  outboxEvent: { select: { eventType: true } },
                },
              }),
            );
            throw new Error(
              `同轮真实出站事件没有成功消费：${JSON.stringify({ ref, outcome, delivery })}`,
            );
          }
        }
        return target;
      },
      async close() {
        scope.close();
        await notifyScope.close();
      },
    };
    scopes.push(value);
    return value;
  }
  async function invitation(
    w: Pick<Awaited<ReturnType<LedgerHarness["make"]["merchant"]>>, "entity" | "store" | "owner">,
    expiresAt: Date,
  ) {
    const id = uuidv7();
    return prisma.invitation.create({
      data: {
        id,
        entityId: w.entity.id,
        storeId: w.store.id,
        role: "clerk",
        inviterMemberId: w.owner.id,
        tokenHash: createHash("sha256").update(id).digest(),
        tokenEnc: "v1:test:entitlement",
        status: "pending",
        clientRequestId: uuidv7(),
        expiresAt,
        createdAt: new Date(expiresAt.getTime() - 86_400_000),
        updatedAt: h.clock.now(),
      },
    });
  }
  async function world(options: WorldOptions = {}) {
    h.clock.set(new Date("2026-01-05T04:00:00.000Z"));
    const own = await h.make.merchant({ verified: true });
    const first = await openTerm(h, { entityId: own.entity.id });
    const change = options.change ?? "expired";
    const next =
      change === "rolled_over"
        ? await openTerm(h, { entityId: own.entity.id, after: first.term })
        : null;
    const current = next?.term ?? first.term;
    await prisma.subscriptionTerm.update({
      where: { id: current.id },
      data: {
        maxStores: options.maxStores ?? 2,
        maxMembers: options.maxMembers === undefined ? 2 : options.maxMembers,
      },
    });
    const stores = [own.store];
    for (let index = 1; index < (options.stores ?? 3); index++)
      stores.push(await h.make.store({ entityId: own.entity.id }));
    const clerks = [];
    for (let index = 0; index < (options.clerks ?? 3); index++)
      clerks.push(await h.make.entityMember({ entityId: own.entity.id }));
    h.clock.set(first.term.endsAt);
    await h.tx.run((tx) => h.ledger.advance(tx, own.entity.id));
    const row = await prisma.outboxEvent.findFirstOrThrow({
      where: { entityId: own.entity.id, eventType: `billing.subscription.${change}` },
    });
    const invitations = [];
    for (let index = 0; index < (options.pending ?? 1); index++)
      invitations.push(await invitation(own, new Date(h.clock.now().getTime() + 86_400_000)));
    const event: DeliveredEvent = {
      id: row.id,
      type: row.eventType,
      payload: row.payload as Record<string, unknown>,
    };
    return { ...own, first, next, stores, clerks, invitations, event, row };
  }
  async function evidence(eventId: string) {
    const notifications = await prisma.notification.findMany({
      where: { sourceOutboxEventId: eventId, notifySceneKey: SCENE },
      orderBy: { merchantUserId: "asc" },
    });
    const ids = notifications.map((row) => row.id);
    const [messages, deliveries] = await Promise.all([
      prisma.merchantMessage.findMany({
        where: { notificationId: { in: ids } },
        orderBy: { merchantUserId: "asc" },
      }),
      prisma.notificationDelivery.findMany({
        where: { notificationId: { in: ids } },
        orderBy: { channel: "asc" },
      }),
    ]);
    return { notifications, messages, deliveries };
  }
  return {
    ...h,
    providers,
    runtime,
    world,
    invitation,
    evidence,
    snapshot: () => snapshotTables(prisma, TABLES),
    async quietTransport() {
      // Prior fault cases retain their business/source rows; only transport is settled between cases.
      await prisma.outboxEvent.updateMany({
        where: { publishedAt: null },
        data: { publishedAt: h.clock.now() },
      });
      await prisma.$executeRawUnsafe(
        "UPDATE outbox_delivery SET status='done', consumed_at=now(), lease_until=NULL WHERE status<>'done'",
      );
    },
    async close() {
      await Promise.all(scopes.map((scope) => scope.close()));
    },
  };
}
export type EntitlementHarness = ReturnType<typeof entitlementHarness>;
export type EntitlementRuntime = ReturnType<EntitlementHarness["runtime"]>;
export type EntitlementWorld = Awaited<ReturnType<EntitlementHarness["world"]>>;

export async function removeOwner(tx: Tx, w: EntitlementWorld, now: Date) {
  await tx.entityMember.update({
    where: { id: w.owner.id },
    data: {
      status: "removed",
      removedAt: now,
      removeReason: "owner_transfer",
      removeActorType: "system",
      removeActorId: null,
      removeClient: null,
      updatedAt: now,
    },
  });
}
export async function transferOwner(tx: Tx, w: EntitlementWorld, memberId: string, now: Date) {
  await removeOwner(tx, w, now);
  await tx.entityMember.update({
    where: { id: memberId },
    data: { role: "owner", updatedAt: now },
  });
}
