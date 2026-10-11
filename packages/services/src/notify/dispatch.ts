import {
  IdSchema,
  MessageDeepLinkSchema,
  eventPayloadSchema,
  EVENT_PAYLOAD_SCHEMAS,
} from "@liyoxi/contract";
import { formatMoney } from "@liyoxi/shared/format/money";
import { notifyReadOf, uuidv7 } from "../kernel/index.js";
import type { DeliveredEvent, Tx } from "../kernel/index.js";
import type {
  NotifyDispatchDeps,
  NotifyFact,
  NotificationSpec,
  NoticeRecipient,
} from "./context.js";
import { EVENT_SCENES, NotifyFactSchema, specFor } from "./registry.js";
import { notificationDueAt, textLimit, externalAllowed } from "./policy.js";

export async function addDelivery(
  tx: Tx,
  input: {
    notificationId: string;
    channel: "inbox" | "wx_subscribe" | "sms" | "wecom" | "mail";
    origin?: "primary" | "fallback";
    now: Date;
    dueAt?: Date;
    smsTemplateKey?: string | null;
  },
) {
  const sent = input.channel === "inbox";
  return tx.notificationDelivery.createMany({
    skipDuplicates: true,
    data: [
      {
        id: uuidv7(),
        notificationId: input.notificationId,
        channel: input.channel,
        origin: input.origin ?? "primary",
        status: sent ? "sent" : "pending",
        dueAt: input.dueAt ?? input.now,
        smsTemplateKey: input.channel === "sms" ? input.smsTemplateKey : null,
        sentAt: sent ? input.now : null,
        finishedAt: sent ? input.now : null,
        createdAt: input.now,
        updatedAt: input.now,
      },
    ],
  });
}

export async function currentNotificationFact(
  tx: Tx,
  deps: NotifyDispatchDeps,
  spec: NotificationSpec,
  id: string,
): Promise<NotifyFact | null> {
  if (spec.sceneKey === "s.copyright_expiring") {
    const active = await notifyReadOf(deps.assembly).read<string[]>(tx, "activeStaffForNotify", {
      ids: [id],
    });
    return active?.includes(id)
      ? {
          bizType: "staff",
          bizId: id,
          entityId: null,
          storeId: null,
          status: "copyright_expiring",
          version: 0,
          name: "版权到期提醒",
          staffIds: [id],
        }
      : null;
  }
  if (spec.sceneKey === "s.merchant_unreached") {
    const original = await tx.notification.findUnique({
      where: { id },
      include: { notificationDeliveries: true },
    });
    if (!original?.entityId || !original.bizId || !original.merchantUserId) return null;
    const source = specFor(original.notifySceneKey);
    if (!source || source.sceneKey === "s.merchant_unreached") return null;
    const cfg = await tx.notifyScene.findUnique({ where: { sceneKey: source.sceneKey } });
    if (
      !cfg?.managerEscalationEnabled ||
      !original.notificationDeliveries.some(
        (d) =>
          d.channel === "sms" && d.origin !== "manual" && ["failed", "skipped"].includes(d.status),
      ) ||
      original.notificationDeliveries.some(
        (d) =>
          ["wx_subscribe", "sms"].includes(d.channel) &&
          ["sent", "pending", "sending"].includes(d.status),
      )
    )
      return null;
    const fact = await currentNotificationFact(tx, deps, source, original.bizId);
    if (!fact || (source.pendingStatus && !source.pendingStatus.includes(fact.status))) return null;
    const guarded = NotifyFactSchema.shape.guardBizType.safeParse(fact.bizType);
    if (
      !guarded.success ||
      guarded.data === undefined ||
      fact.entityId !== original.entityId ||
      fact.storeId !== original.storeId
    )
      return null;
    const recipients = await notifyReadOf(deps.assembly).read<{ merchantUserId: string }[]>(
      tx,
      "merchantRecipientsForNotify",
      {
        entityId: original.entityId,
        storeId: original.storeId,
        ownerOnly: source.ownerOnly,
        userIds: [original.merchantUserId],
      },
    );
    if (
      !original.merchantUserId ||
      !recipients?.some((row) => row.merchantUserId === original.merchantUserId)
    )
      return null;
    const staffIds = await notifyReadOf(deps.assembly).read<string[]>(tx, "managerIdsForNotify", {
      entityId: original.entityId,
      storeId: original.storeId,
    });
    if (!staffIds?.length) return null;
    return {
      ...fact,
      bizType: "notification",
      bizId: original.id,
      entityId: original.entityId,
      storeId: original.storeId,
      guardBizType: guarded.data,
      guardBizId: fact.bizId,
      status: "unreached",
      version: 0,
      name: "商家通知未触达",
      staffIds,
    };
  }
  const found = await notifyReadOf(deps.assembly).read(tx, spec.reader, id);
  if (found === null) return null;
  const fact = NotifyFactSchema.parse(found);
  if (["s.approval_pending", "s.approval_overdue"].includes(spec.sceneKey))
    fact.staffIds = await deps.approvalRecipients(tx, id);
  if (["s.receipt_pending", "s.payment_exception"].includes(spec.sceneKey))
    fact.staffIds =
      (await notifyReadOf(deps.assembly).read<string[]>(tx, "activeStaffForNotify", {
        roleKey: "finance",
      })) ?? [];
  if (spec.sceneKey === "s.work_ticket_assigned" && !fact.staffIds?.length)
    fact.staffIds =
      (await notifyReadOf(deps.assembly).read<string[]>(tx, "activeStaffForNotify", {
        roleKey: "delivery_manager",
        isLead: true,
      })) ?? [];
  if (spec.sceneKey === "m.delivered" && fact.orderItemId) {
    const link = await notifyReadOf(deps.assembly).read(tx, "launchLinkForItem", fact.orderItemId);
    const parsed = MessageDeepLinkSchema.safeParse(link);
    if (!parsed.success) return null;
    fact.link = parsed.data;
  }
  return fact;
}

export const smsNodeAllowed = (nodes: unknown, node: string): boolean =>
  nodes === null || (Array.isArray(nodes) && nodes.includes(node));

// These producers can recur while the account/store and current status stay the same.
// A stable outbox ID preserves each occurrence, including replay after a later review round.
const occurrenceEvents = new Set([
  "entity_member.stores_changed",
  "merchant_user.wechat_bound",
  "store.qualification.submitted",
  "store.qualification.approved",
  "store.qualification.rejected",
  "account.verified",
  "account.abnormal",
]);

/** Caller transaction is the only transaction: consumer status, inbox and deliveries roll back together. */
export async function dispatchFact(
  tx: Tx,
  deps: NotifyDispatchDeps,
  spec: NotificationSpec,
  fact: NotifyFact,
  source: { event?: DeliveredEvent; node: string; rule?: string; recipients?: NoticeRecipient[] },
): Promise<number> {
  const cfg = await tx.notifyScene.findUnique({ where: { sceneKey: spec.sceneKey } });
  const mandatory =
    spec.sceneKey === "m.rule_change_notice" || spec.sceneKey === "m.rule_change_withdrawn";
  if (!cfg || (!cfg.sceneEnabled && !mandatory)) return 0;
  if (spec.pendingStatus && !spec.pendingStatus.includes(fact.status)) return 0;
  const read = notifyReadOf(deps.assembly);
  if (cfg.audience === "staff") {
    const now = deps.clock.now();
    let made = 0;
    for (const staffId of fact.staffIds ?? []) {
      const active = await read.read<string[]>(tx, "activeStaffForNotify", { ids: [staffId] });
      if (!active?.includes(staffId)) continue;
      const id = uuidv7();
      const key =
        spec.sceneKey === "s.copyright_expiring"
          ? `copyright:${staffId}:${fact.targetDate}`
          : `${spec.sceneKey}:${fact.bizId}:v${fact.version}:${source.node}:${fact.status}:${fact.targetDate ?? ""}:${staffId}`;
      const created = await tx.notification.createMany({
        skipDuplicates: true,
        data: [
          {
            id,
            notifySceneKey: spec.sceneKey,
            dedupeKey: key,
            sourceOutboxEventId: source.event?.id ?? null,
            sourceRule: source.rule ?? null,
            node: source.node,
            bizType: fact.bizType,
            bizId: fact.bizId,
            staffId,
            entityId: fact.entityId,
            storeId: fact.storeId,
            vars: { ...fact },
            copyMode: null,
            createdAt: now,
          },
        ],
      });
      if (!created.count) continue;
      if (!spec.staffLink) throw new TypeError("员工通知缺少固定深链");
      await tx.staffMessage.create({
        data: {
          id: uuidv7(),
          notificationId: id,
          staffId,
          kind: fact.bizType === "approval_request" ? "approval" : "todo",
          title: textLimit(cfg.name, 40),
          body: textLimit(fact.summary ?? `${fact.name}：${cfg.name}，请查看当前业务详情。`, 200),
          link: spec.staffLink(fact),
          createdAt: now,
          updatedAt: now,
        },
      });
      await addDelivery(tx, { notificationId: id, channel: "inbox", now });
      made++;
      if (cfg.extEnabled)
        await addDelivery(tx, {
          notificationId: id,
          channel: "wecom",
          now,
          dueAt: spec.sceneKey === "s.kf_response_overdue" ? now : await deps.staffWorkAt(tx, now),
        });
    }
    return made;
  }
  let recipients: { merchantUserId: string; entityId: string | null }[];
  if (mandatory && source.recipients) {
    recipients = source.recipients;
  } else if (fact.bizType === "merchant_user") {
    recipients =
      fact.merchantUserIds?.map((merchantUserId) => ({ merchantUserId, entityId: null })) ?? [];
  } else {
    recipients =
      (await read.read(tx, "merchantRecipientsForNotify", {
        entityId: fact.entityId,
        storeId: fact.storeId,
        ownerOnly: spec.ownerOnly,
        ...(fact.merchantUserIds ? { userIds: fact.merchantUserIds } : {}),
        allEntities: mandatory,
      })) ?? [];
  }
  const now = deps.clock.now();
  const start = await deps.params.get("notify.window.start");
  const end = await deps.params.get("notify.window.end");
  let made = 0;
  for (const recipient of recipients) {
    const entityId = recipient.entityId;
    const mode = entityId === null ? null : await deps.purchaseMode(tx, entityId, now);
    const id = uuidv7();
    const key = `${spec.sceneKey}:${fact.bizId}:v${fact.version}:${source.node}:${
      spec.sceneKey.startsWith("m.points_") || occurrenceEvents.has(source.event?.type ?? "")
        ? (source.event?.id ?? "rule")
        : fact.status
    }:${recipient.merchantUserId}${mandatory ? `:${entityId}` : ""}`;
    const vars = {
      ...fact,
      entityId,
      ...(spec.sceneKey === "m.account_security" &&
      typeof source.event?.payload.wechatIdentityId === "string"
        ? { excludeWechatIdentityId: source.event.payload.wechatIdentityId }
        : {}),
    };
    const inserted = await tx.notification.createMany({
      skipDuplicates: true,
      data: [
        {
          id,
          notifySceneKey: spec.sceneKey,
          dedupeKey: key,
          sourceOutboxEventId: source.event?.id ?? null,
          sourceRule: source.rule ?? null,
          bizType: fact.bizType,
          bizId: fact.bizId,
          node: source.node,
          merchantUserId: recipient.merchantUserId,
          entityId,
          storeId: fact.storeId,
          vars,
          copyMode: mode,
          createdAt: now,
        },
      ],
    });
    if (!inserted.count) continue;
    const link = MessageDeepLinkSchema.parse(
      mode !== "in_app" && spec.sceneKey === "m.pay_success"
        ? { route: "wallet.home", params: {} }
        : spec.link(fact),
    );
    const summary =
      mandatory && mode !== "in_app" ? (fact.summaryNoPrice ?? fact.summary) : fact.summary;
    const pay = spec.sceneKey === "m.pay_success";
    const title = pay && mode !== "in_app" ? (fact.detail ?? "服务已开通") : cfg.name;
    const body = pay
      ? mode === "in_app" && fact.amountFen !== undefined
        ? `${fact.name}付款成功，金额${formatMoney(fact.amountFen)}。`
        : `${title}，请查看服务详情。`
      : (summary ?? `${fact.name}：${cfg.name}，请查看当前业务详情。`);
    await tx.merchantMessage.create({
      data: {
        id: uuidv7(),
        notificationId: id,
        merchantUserId: recipient.merchantUserId,
        entityId,
        storeId: fact.storeId,
        isOwnerOnly: spec.ownerOnly,
        category: spec.category,
        title: textLimit(title, 40),
        body: textLimit(body, 200),
        ctaText: "查看",
        link,
        createdAt: now,
        updatedAt: now,
      },
    });
    await addDelivery(tx, { notificationId: id, channel: "inbox", now });
    made++;
    if (
      !cfg.extEnabled ||
      mandatory ||
      (spec.sceneKey === "m.account_security" &&
        source.event?.type === "merchant_user.phone_changed")
    )
      continue;
    const wx =
      cfg.wxTemplateSlotKey !== null && externalAllowed(spec.sceneKey, "wx_subscribe", mode);
    const dueAt = notificationDueAt(now, id, cfg.sendWindow === "window", start, end);
    if (wx) await addDelivery(tx, { notificationId: id, channel: "wx_subscribe", now, dueAt });
    if (
      externalAllowed(spec.sceneKey, "sms", mode) &&
      smsNodeAllowed(cfg.smsNodes, source.node) &&
      cfg.smsTemplateKey &&
      (cfg.smsPolicy === "always" || (cfg.smsPolicy === "fallback" && !wx))
    )
      await addDelivery(tx, {
        notificationId: id,
        channel: "sms",
        now,
        origin: cfg.smsPolicy === "fallback" ? "fallback" : "primary",
        smsTemplateKey: cfg.smsTemplateKey,
        dueAt: notificationDueAt(now, id, true, start, end),
      });
  }
  return made;
}

export async function dispatchEvent(tx: Tx, deps: NotifyDispatchDeps, event: DeliveredEvent) {
  const memberChange =
    event.type === "entity_member.stores_changed"
      ? EVENT_PAYLOAD_SCHEMAS["entity_member.stores_changed"].parse(event.payload)
      : undefined;
  // 邀请接受的通知老板分支还没有 producer，不能把该分支误发给店员。
  if (memberChange?.invitationId != null) return 0;
  let made = 0;
  for (const spec of EVENT_SCENES[event.type] ?? []) {
    const parsedId = IdSchema.safeParse(event.payload[spec.refField]);
    if (!parsedId.success) throw new TypeError(`通知对象标识不符合契约：${event.type}`);
    const fact = await currentNotificationFact(tx, deps, spec, parsedId.data);
    if (fact === null) continue;
    if (
      memberChange &&
      (fact.bizId !== memberChange.entityMemberId ||
        fact.entityId !== memberChange.entityId ||
        fact.merchantUserIds?.length !== 1 ||
        fact.merchantUserIds[0] !== memberChange.merchantUserId)
    )
      throw new TypeError("成员范围事件与当前归属不符");
    if (spec.sceneKey === "m.rule_change_notice" || spec.sceneKey === "m.rule_change_withdrawn") {
      if (spec.pendingStatus && !spec.pendingStatus.includes(fact.status)) continue;
      const batch = await deps.params.get("notify.fanout.batch");
      const recipients = await notifyReadOf(deps.assembly).read<NoticeRecipient[]>(
        tx,
        "noticeRecipientsPageForNotify",
        { after: null, take: batch + 1 },
      );
      if (recipients === null) throw new TypeError("公告接收人事实未配置");
      if (recipients.length > batch) {
        const now = deps.clock.now();
        await tx.notificationFanout.createMany({
          skipDuplicates: true,
          data: [
            {
              id: uuidv7(),
              sourceOutboxEventId: event.id,
              notifySceneKey: spec.sceneKey,
              siteNoticeId: fact.bizId,
              dueAt: now,
              createdAt: now,
              updatedAt: now,
            },
          ],
        });
      } else {
        made += await dispatchFact(tx, deps, spec, fact, { event, node: "N0", recipients });
      }
      continue;
    }
    if (event.type.startsWith("billing.points.")) {
      const payload = eventPayloadSchema(event.type)?.parse(event.payload);
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new TypeError("积分通知缺少正式事件字段");
      const values = payload as Record<string, unknown>;
      const quantity =
        typeof values.points === "number"
          ? values.points
          : typeof values.deltaPoints === "number"
            ? values.deltaPoints
            : typeof values.expiredPoints === "number"
              ? values.expiredPoints
              : typeof values.returnedPoints === "number" &&
                  typeof values.convertedPoints === "number"
                ? values.returnedPoints + values.convertedPoints
                : undefined;
      if (quantity === undefined) throw new TypeError("积分通知缺少变动数量");
      fact.quantity = quantity;
      fact.detail =
        spec.sceneKey === "m.points_captured"
          ? "已扣减"
          : spec.sceneKey === "m.points_expired"
            ? "已清零"
            : quantity < 0
              ? "积分减少"
              : "积分增加";
      NotifyFactSchema.parse(fact);
    }
    made += await dispatchFact(tx, deps, spec, fact, { event, node: "N0" });
  }
  return made;
}
