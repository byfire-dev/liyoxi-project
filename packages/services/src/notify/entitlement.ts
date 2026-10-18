// tenant 在所属 reader 内核真实来源与当前额度；notify 只拥有通知、消息与站内投递。
import { EVENT_PAYLOAD_SCHEMAS, IdSchema, MessageDeepLinkSchema } from "@liyoxi/contract";
import { z } from "zod";
import { notifyReadOf, uuidv7 } from "../kernel/index.js";
import type { DeliveredEvent, Tx } from "../kernel/index.js";
import type { NotifyDispatchDeps } from "./context.js";
import { addDelivery } from "./dispatch.js";
import { QUOTA_EXCEEDED_SPEC } from "./registry.js";

const NoticeSchema = z
  .strictObject({
    sourceId: IdSchema,
    sourceType: z.enum(["billing.subscription.rolled_over", "billing.subscription.expired"]),
    entityId: IdSchema,
    merchantUserId: IdSchema,
    storesOver: z.int().nonnegative(),
    seatsOver: z.int().nonnegative(),
  })
  .refine((value) => value.storesOver > 0 || value.seatsOver > 0);

/** 无自建事务、外部发送或队列：与 outbox 消费完成原子提交。 */
export async function sendQuotaExceeded(
  tx: Tx,
  deps: NotifyDispatchDeps,
  event: DeliveredEvent,
): Promise<number> {
  if (
    event.type !== "billing.subscription.rolled_over" &&
    event.type !== "billing.subscription.expired"
  )
    throw new TypeError("名额提醒只接受权益变动事件");
  const payload = EVENT_PAYLOAD_SCHEMAS[event.type].parse(event.payload);
  const stored = await tx.outboxEvent.findUnique({ where: { id: event.id } });
  if (
    !stored ||
    stored.eventType !== event.type ||
    JSON.stringify(EVENT_PAYLOAD_SCHEMAS[event.type].parse(stored.payload)) !==
      JSON.stringify(payload)
  )
    throw new TypeError("名额提醒事件与持久化来源不符");
  const read = notifyReadOf(deps.assembly);
  if (!read.has(QUOTA_EXCEEDED_SPEC.reader)) throw new TypeError("名额提醒缺少所属事实装配");
  const found = await read.read(tx, QUOTA_EXCEEDED_SPEC.reader, event.id);
  if (found === null) return 0;
  const fact = NoticeSchema.parse(found);
  if (
    fact.sourceId !== event.id ||
    fact.sourceType !== event.type ||
    fact.entityId !== payload.entityId
  )
    throw new TypeError("名额提醒与当前持久化来源不符");
  const recipients = await read.read<{ merchantUserId: string; entityId: string }[]>(
    tx,
    "merchantRecipientsForNotify",
    {
      entityId: fact.entityId,
      storeId: null,
      ownerOnly: true,
      userIds: [fact.merchantUserId],
    },
  );
  if (
    !recipients?.some(
      (row) => row.merchantUserId === fact.merchantUserId && row.entityId === fact.entityId,
    )
  )
    return 0;
  const cfg = await tx.notifyScene.findUnique({
    where: { sceneKey: QUOTA_EXCEEDED_SPEC.sceneKey },
  });
  if (!cfg?.sceneEnabled) return 0;
  if (cfg.audience !== "merchant") throw new TypeError("名额提醒场景受众不符");
  const now = deps.clock.now();
  const id = uuidv7();
  const created = await tx.notification.createMany({
    skipDuplicates: true,
    data: [
      {
        id,
        notifySceneKey: QUOTA_EXCEEDED_SPEC.sceneKey,
        dedupeKey: `${QUOTA_EXCEEDED_SPEC.sceneKey}:${event.id}:${fact.merchantUserId}`,
        sourceOutboxEventId: event.id,
        node: "N0",
        bizType: "entity",
        bizId: fact.entityId,
        merchantUserId: fact.merchantUserId,
        entityId: fact.entityId,
        storeId: null,
        vars: { ...fact },
        copyMode: await deps.purchaseMode(tx, fact.entityId, now),
        createdAt: now,
      },
    ],
  });
  if (!created.count) return 0;
  const actions = [
    ...(fact.storesOver ? [`停用${fact.storesOver}家门店`] : []),
    ...(fact.seatsOver ? [`减少${fact.seatsOver}个店员或待接受邀请名额`] : []),
  ];
  await tx.merchantMessage.create({
    data: {
      id: uuidv7(),
      notificationId: id,
      merchantUserId: fact.merchantUserId,
      entityId: fact.entityId,
      storeId: null,
      isOwnerOnly: true,
      category: QUOTA_EXCEEDED_SPEC.category,
      title: cfg.name,
      body: `名额已超出当前上限，请${actions.join("、")}。`,
      ctaText: "查看套餐",
      link: MessageDeepLinkSchema.parse({ route: "wallet.home", params: {} }),
      createdAt: now,
      updatedAt: now,
    },
  });
  await addDelivery(tx, { notificationId: id, channel: "inbox", now });
  return 1;
}
