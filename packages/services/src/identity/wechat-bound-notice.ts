import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { lockRows } from "../kernel/index.js";
import type { DeliveredEvent, Tx } from "../kernel/index.js";

const TYPE = "merchant_user.wechat_bound";
/** 与outbox_delivery完成同Tx；事件ID作为提示ID，关闭后重投也不重新创建。 */
export async function onWechatBound(tx: Tx, event: DeliveredEvent): Promise<void> {
  if (event.type !== TYPE) throw new TypeError("微信绑定提示收到未登记事件");
  const payload = EVENT_PAYLOAD_SCHEMAS[TYPE].parse(event.payload);
  const source = await tx.outboxEvent.findUnique({ where: { id: event.id } });
  if (
    !source ||
    source.eventType !== TYPE ||
    source.aggregateType !== "merchant_user" ||
    source.aggregateId !== payload.merchantUserId ||
    source.actorType !== "merchant" ||
    source.actorId !== payload.merchantUserId ||
    source.client !== "weapp"
  )
    throw new TypeError("微信绑定提示与持久化来源不符");
  const original = EVENT_PAYLOAD_SCHEMAS[TYPE].parse(source.payload);
  if (
    original.merchantUserId !== payload.merchantUserId ||
    original.wechatIdentityId !== payload.wechatIdentityId
  )
    throw new TypeError("微信绑定提示与持久化载荷不符");
  // 注销和消费共享账号80；停用保留安全事件，延迟投递不能恢复已注销账号的提示。
  await lockRows(tx, "merchant_user", [payload.merchantUserId]);
  const user = await tx.merchantUser.findUnique({
    where: { id: payload.merchantUserId },
    select: { status: true },
  });
  if (!user || user.status === "deleted") return;
  await tx.merchantUserNotice.createMany({
    skipDuplicates: true,
    data: [
      {
        id: event.id,
        merchantUserId: payload.merchantUserId,
        kind: "new_wechat_bound",
        occurredAt: source.occurredAt,
        createdAt: source.occurredAt,
        updatedAt: source.occurredAt,
      },
    ],
  });
}
