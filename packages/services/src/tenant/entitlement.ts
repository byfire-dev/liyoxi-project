// 权益变动只提示当前超额；唯一额度公式、真实来源与当前老板均在 caller Tx 读取。
import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { AppError, lockRows, merchantFactsOf, notifyReadOf } from "../kernel/index.js";
import type { Assembly, Clock, DeliveredEvent, Tx } from "../kernel/index.js";
import { getQuotaUsage } from "./quota.js";

export const TENANT_ENTITLEMENT_EVENTS = [
  "billing.subscription.rolled_over",
  "billing.subscription.expired",
] as const;
export interface EntitlementNotice {
  sourceId: string;
  sourceType: (typeof TENANT_ENTITLEMENT_EVENTS)[number];
  entityId: string;
  merchantUserId: string;
  storesOver: number;
  seatsOver: number;
}
function payload(event: Pick<DeliveredEvent, "type" | "payload">) {
  switch (event.type) {
    case "billing.subscription.rolled_over":
    case "billing.subscription.expired":
      return EVENT_PAYLOAD_SCHEMAS[event.type].parse(event.payload);
    default:
      throw new TypeError("权益变动订阅收到未登记事件");
  }
}
export function createTenantEntitlement(deps: {
  clock: Clock;
  assembly: Assembly;
  notify(tx: Tx, event: DeliveredEvent): Promise<number>;
}) {
  const read = notifyReadOf(deps.assembly);
  const facts = merchantFactsOf(deps.assembly);
  if (!facts.has("billing")) throw new TypeError("权益变动缺少真实计费额度事实装配");
  async function source(tx: Tx, id: string) {
    if (!read.has("termForNotify")) throw new TypeError("权益变动缺少真实周期事实装配");
    const row = await tx.outboxEvent.findUnique({ where: { id } });
    if (!row || !TENANT_ENTITLEMENT_EVENTS.some((type) => type === row.eventType)) return null;
    const input = payload({ type: row.eventType, payload: row.payload as Record<string, unknown> });
    if (
      row.entityId !== input.entityId ||
      row.storeId !== null ||
      row.aggregateType !== "subscription_term" ||
      row.aggregateId !== input.termId ||
      row.actorType !== "system" ||
      row.actorId !== null
    )
      return null;
    const term = await read.read<{ bizType: string; bizId: string; entityId: string }>(
      tx,
      "termForNotify",
      input.termId,
    );
    if (
      term?.bizType !== "subscription_term" ||
      term.bizId !== input.termId ||
      term.entityId !== input.entityId
    )
      return null;
    if ("prevTermId" in input && input.prevTermId !== null) {
      const prev = await read.read<{ bizType: string; bizId: string; entityId: string }>(
        tx,
        "termForNotify",
        input.prevTermId,
      );
      if (
        prev?.bizType !== "subscription_term" ||
        prev.bizId !== input.prevTermId ||
        prev.entityId !== input.entityId
      )
        return null;
    }
    return { row, input };
  }
  return {
    async onEntitlementChanged(tx: Tx, event: DeliveredEvent): Promise<void> {
      const input = payload(event);
      const stored = await source(tx, event.id);
      if (
        !stored ||
        stored.row.eventType !== event.type ||
        JSON.stringify(stored.input) !== JSON.stringify(input)
      )
        throw new TypeError("权益变动事件与持久化来源不符");
      await deps.notify(tx, event);
    },
    async readForNotify(tx: Tx, eventId: string): Promise<EntitlementNotice | null> {
      const stored = await source(tx, eventId);
      if (!stored) return null;
      const { entityId } = stored.input;
      const candidate = await tx.entityMember.findFirst({
        where: { entityId, role: "owner", status: "active" },
        select: { id: true, merchantUserId: true },
      });
      if (!candidate) return null;
      await lockRows(tx, "merchant_user", [candidate.merchantUserId], "share");
      await lockRows(tx, "entity", [entityId], "share");
      const entity = await tx.entity.findUnique({
        where: { id: entityId },
        select: { lifecycle: true },
      });
      if (!entity || entity.lifecycle !== "active") return null;
      const currentOwner = await tx.entityMember.findFirst({
        where: { entityId, role: "owner", status: "active" },
        select: { id: true, merchantUserId: true },
      });
      if (!currentOwner) return null;
      if (
        currentOwner.id !== candidate.id ||
        currentOwner.merchantUserId !== candidate.merchantUserId
      )
        throw new AppError("PRECONDITION_CHANGED");
      await lockRows(tx, "entity_member", [candidate.id], "share");
      if (
        !(await tx.entityMember.findFirst({
          where: {
            id: candidate.id,
            entityId,
            merchantUserId: candidate.merchantUserId,
            role: "owner",
            status: "active",
            merchantUser: { status: "active" },
          },
          select: { id: true },
        }))
      )
        return null;
      const usage = await getQuotaUsage(tx, { facts }, deps.clock.now(), entityId);
      if (usage.storesOver === 0 && usage.seatsOver === 0) return null;
      return {
        sourceId: stored.row.id,
        sourceType: stored.row.eventType as EntitlementNotice["sourceType"],
        entityId,
        merchantUserId: candidate.merchantUserId,
        storesOver: usage.storesOver,
        seatsOver: usage.seatsOver,
      };
    },
  };
}
export type TenantEntitlement = ReturnType<typeof createTenantEntitlement>;
