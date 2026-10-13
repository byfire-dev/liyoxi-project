import { assertNotInTransaction, lockRows, notifyReadOf, isUuid } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { Notification, NotificationDelivery, NotifyScene } from "@liyoxi/db";
import type { NotificationProviderResult } from "../providers/types.js";
import type { NotifyDispatchDeps } from "./context.js";
import { addDelivery, smsNodeAllowed, currentNotificationFact, dispatchFact } from "./dispatch.js";
import { FALLBACK_REASONS, notificationDueAt, sendVerdict, externalAllowed } from "./policy.js";
import { NotifyFactSchema, specFor, UNREACHED_SPEC } from "./registry.js";
import { renderWechat, renderSms } from "./render.js";
import { smsDayUsage } from "./sms-budget.js";
import { currentStoreArchiveNotification, lockStoreArchiveSource } from "./store-archive.js";

type Delivery = NotificationDelivery & { notification: Notification | null };
interface Prepared {
  id: string;
  attempt: number;
  identityId: string | null;
  slot: string | null;
  acceptedAt: Date | null;
  startedAt: Date;
  send(signal: AbortSignal): Promise<NotificationProviderResult<unknown>>;
}
class LostClaim extends Error {}

async function deliveryAt(tx: Tx, id: string): Promise<Delivery | null> {
  return tx.notificationDelivery.findUnique({ where: { id }, include: { notification: true } });
}

/** T2/T3/recovery share: recipient → identity90 → domain guards → anchors → delivery → quota. */
async function anchors(tx: Tx, deps: NotifyDispatchDeps, d: Delivery, identity?: string | null) {
  const n = d.notification;
  const target = n?.merchantUserId
    ? await deps.merchantTarget(tx, n.merchantUserId)
    : n?.staffId
      ? await deps.staffTarget(tx, n.staffId)
      : null;
  const guardUserId =
    n?.notifySceneKey === "s.merchant_unreached" && n.bizId
      ? ((
          await tx.notification.findUnique({
            where: { id: n.bizId },
            select: { merchantUserId: true },
          })
        )?.merchantUserId ?? null)
      : (n?.merchantUserId ?? null);
  if (guardUserId && !n?.merchantUserId)
    await lockRows(tx, "merchant_user", [guardUserId], "share");
  const cfg = n ? await tx.notifyScene.findUnique({ where: { sceneKey: n.notifySceneKey } }) : null;
  const vars = n ? NotifyFactSchema.safeParse(n.vars) : null;
  let identityId = identity ?? (d.targetRef && isUuid(d.targetRef) ? d.targetRef : null);
  if (
    d.channel === "wx_subscribe" &&
    n?.merchantUserId &&
    !identityId &&
    cfg?.wxTemplateSlotKey &&
    deps.appid
  ) {
    const candidate = await tx.wxSubscribeQuota.findFirst({
      where: {
        merchantUserId: n.merchantUserId,
        wxTemplateSlotKey: cfg.wxTemplateSlotKey,
        state: "ok",
        estRemaining: { gt: 0 },
        wechatIdentity: {
          appid: deps.appid,
          merchantUserId: n.merchantUserId,
          ...(vars?.success && vars.data.excludeWechatIdentityId
            ? { id: { not: vars.data.excludeWechatIdentityId } }
            : {}),
        },
      },
      orderBy: [{ lastAcceptAt: { sort: "desc", nulls: "last" } }, { wechatIdentityId: "asc" }],
    });
    identityId = candidate?.wechatIdentityId ?? null;
  }
  if (vars?.success && vars.data.bizType === "follow_up")
    await tx.$queryRaw`SELECT id FROM follow_up WHERE id = ${vars.data.bizId}::uuid FOR SHARE`;
  if (vars?.success && vars.data.bizType === "approval_request")
    await lockRows(tx, "approval_request", [vars.data.bizId], "share");
  if (identityId) await lockRows(tx, "wechat_identity", [identityId], "share");
  if (n) await lockStoreArchiveSource(tx, n);
  if (n?.entityId) {
    await lockRows(tx, "entity", [n.entityId], "share");
    const members = guardUserId
      ? await tx.entityMember.findMany({
          where: {
            entityId: n.entityId,
            merchantUserId: guardUserId,
          },
          select: { id: true },
        })
      : [];
    await lockRows(
      tx,
      "entity_member",
      members.map((row) => row.id),
      "share",
    );
  }
  if (n?.storeId) await lockRows(tx, "store", [n.storeId], "share");
  if (vars?.success) {
    const f = vars.data;
    const type = f.guardBizType ?? f.bizType,
      bizId = f.guardBizId ?? f.bizId;
    if (f.orderId) await lockRows(tx, "drama_order", [f.orderId], "share");
    else if (type === "drama_order") await lockRows(tx, "drama_order", [bizId], "share");
    if (f.orderItemId) await lockRows(tx, "order_item", [f.orderItemId], "share");
    if (f.deliveryTicketId) await lockRows(tx, "delivery_ticket", [f.deliveryTicketId], "share");
    if (type === "channel_account") await lockRows(tx, "channel_account", [bizId], "share");
    if (type === "delivery_plan") await lockRows(tx, "delivery_plan", [bizId], "share");
    if (type === "delivery_release") await lockRows(tx, "delivery_release", [bizId], "share");
    if (type === "launch_task") await lockRows(tx, "launch_task", [bizId], "share");
    if (type === "sample") await lockRows(tx, "sample", [bizId], "share");
    if (type === "billing_order") await lockRows(tx, "billing_order", [bizId], "share");
    if (type === "transfer_proof") await lockRows(tx, "transfer_proof", [bizId], "share");
    if (type === "payment_exception") await lockRows(tx, "payment_exception", [bizId], "share");
    if (type === "store_asset") await lockRows(tx, "store_asset", [bizId], "share");
    if (type === "billing_account") await lockRows(tx, "billing_account", [bizId], "share");
  }
  // The fallback template is acquired before the primary delivery, never during fallback after it.
  const keys = [
    ...new Set(
      ["verify_code", cfg?.smsTemplateKey, d.smsTemplateKey].filter(
        (key): key is string => typeof key === "string",
      ),
    ),
  ].sort();
  let available = true;
  for (const key of keys) {
    const rows = await tx.$queryRaw<{ templateKey: string }[]>`SELECT template_key AS "templateKey"
      FROM sms_template WHERE template_key = ${key} FOR UPDATE`;
    if (!rows.length) available = false;
  }
  if (cfg?.wxTemplateSlotKey) {
    const slots = await tx.$queryRaw`SELECT slot_key FROM wx_template_slot
      WHERE slot_key = ${cfg.wxTemplateSlotKey} FOR UPDATE`;
    if (!Array.isArray(slots) || !slots.length) available = false;
  }
  await tx.$queryRaw`SELECT id FROM notification_delivery WHERE id = ${d.id}::uuid FOR UPDATE`;
  return { target, identityId, available };
}

async function fallback(tx: Tx, deps: NotifyDispatchDeps, d: Delivery, reason: string) {
  const n = d.notification;
  if (!n || d.isDirect || !FALLBACK_REASONS.has(reason)) return;
  const cfg = await tx.notifyScene.findUnique({ where: { sceneKey: n.notifySceneKey } });
  if (d.channel === "sms" && d.origin !== "manual" && cfg?.managerEscalationEnabled) {
    const fact = await currentNotificationFact(tx, deps, UNREACHED_SPEC, n.id);
    if (fact)
      await dispatchFact(tx, deps, UNREACHED_SPEC, fact, {
        node: "N0",
        rule: "merchant_unreached",
      });
    return;
  }
  if (
    d.channel !== "wx_subscribe" ||
    !cfg?.extEnabled ||
    cfg.smsPolicy !== "fallback" ||
    !cfg.smsTemplateKey ||
    !smsNodeAllowed(cfg.smsNodes, n.node)
  )
    return;
  const mode = n.entityId ? await deps.purchaseMode(tx, n.entityId, deps.clock.now()) : null;
  if (!externalAllowed(n.notifySceneKey, "sms", mode)) return;
  const now = deps.clock.now();
  await addDelivery(tx, {
    notificationId: n.id,
    channel: "sms",
    origin: "fallback",
    now,
    smsTemplateKey: cfg.smsTemplateKey,
    dueAt: notificationDueAt(
      now,
      n.id,
      true,
      await deps.params.get("notify.window.start"),
      await deps.params.get("notify.window.end"),
    ),
  });
}

async function terminal(
  tx: Tx,
  deps: NotifyDispatchDeps,
  d: Delivery,
  status: "failed" | "skipped" | "cancelled",
  reason: string,
) {
  const now = deps.clock.now();
  const changed = await tx.notificationDelivery.updateMany({
    where: {
      id: d.id,
      status: "sending",
      attemptNo: d.attemptNo,
    },
    data: { status, reason, leaseUntil: null, finishedAt: now, updatedAt: now },
  });
  if (changed.count && status !== "cancelled") await fallback(tx, deps, d, reason);
  return changed.count;
}

async function currentGuard(
  tx: Tx,
  deps: NotifyDispatchDeps,
  d: Delivery,
): Promise<NotifyScene | null> {
  const n = d.notification;
  if (!n) return null;
  const cfg = await tx.notifyScene.findUnique({ where: { sceneKey: n.notifySceneKey } });
  const archive = await currentStoreArchiveNotification(tx, deps, n);
  const spec = archive === undefined ? specFor(n.notifySceneKey, n.bizType) : archive?.spec;
  if (!cfg?.sceneEnabled || !cfg.extEnabled || !spec || !n.bizId) return null;
  const fact =
    archive === undefined ? await currentNotificationFact(tx, deps, spec, n.bizId) : archive?.fact;
  if (!fact || (n.staffId && !fact.staffIds?.includes(n.staffId))) return null;
  if (spec.pendingStatus && !spec.pendingStatus.includes(fact.status)) return null;
  const stored = NotifyFactSchema.safeParse(n.vars);
  // Versioned pending actions never send the old request after a replacement version.
  if (spec.pendingStatus && (!stored.success || stored.data.version !== fact.version)) return null;
  if (n.merchantUserId && n.entityId) {
    const recipients = await notifyReadOf(deps.assembly).read<{ merchantUserId: string }[]>(
      tx,
      "merchantRecipientsForNotify",
      {
        entityId: n.entityId,
        storeId: n.storeId,
        ownerOnly: spec.ownerOnly,
        userIds: [n.merchantUserId],
      },
    );
    if (!recipients?.some((row) => row.merchantUserId === n.merchantUserId)) return null;
  }
  return cfg;
}

async function prepare(tx: Tx, deps: NotifyDispatchDeps, id: string): Promise<Prepared | null> {
  let d = await deliveryAt(tx, id);
  if (!d?.notification || d.status !== "sending" || d.callStartedAt !== null) return null;
  const n = d.notification;
  const anchored = await anchors(tx, deps, d);
  const target = anchored.target;
  d = await deliveryAt(tx, id);
  if (!d || d.status !== "sending" || d.callStartedAt !== null) return null;
  const cfg = await currentGuard(tx, deps, d);
  if (!target?.active || !cfg) {
    await terminal(tx, deps, d, "cancelled", "guard_invalid");
    return null;
  }
  if (!anchored.available) {
    await terminal(tx, deps, d, "skipped", "unconfigured");
    return null;
  }
  const now = deps.clock.now();
  const mode = n.entityId ? await deps.purchaseMode(tx, n.entityId, now) : null;
  if (!externalAllowed(n.notifySceneKey, d.channel, mode)) {
    await terminal(tx, deps, d, "skipped", "policy_suppressed");
    return null;
  }
  if (!d.leaseUntil || d.leaseUntil <= now) return null;
  const collapsed =
    cfg.collapseWindowSec > 0 &&
    (await tx.notificationDelivery.count({
      where: {
        notificationId: { not: n.id },
        callStartedAt: { gte: new Date(now.getTime() - cfg.collapseWindowSec * 1000) },
        notification: {
          notifySceneKey: n.notifySceneKey,
          merchantUserId: n.merchantUserId,
          staffId: n.staffId,
        },
      },
    }));
  if (collapsed) {
    await terminal(tx, deps, d, "skipped", "collapsed");
    return null;
  }
  let send: Prepared["send"];
  let identityId: string | null = null;
  let slot: string | null = null;
  let acceptedAt: Date | null = null;
  let ref: string;
  let mask: string | null = null;
  let templateId: string | null = null;
  if (d.channel === "wx_subscribe") {
    slot = cfg.wxTemplateSlotKey;
    const template = slot ? await tx.wxTemplateSlot.findUnique({ where: { slotKey: slot } }) : null;
    if (
      !(await deps.wxEnabled(tx, n.entityId)) ||
      !template?.providerTemplateId ||
      template.status !== "active" ||
      !deps.providers.wechat.configured
    ) {
      await terminal(
        tx,
        deps,
        d,
        "skipped",
        template?.status === "disabled" ? "slot_disabled" : "unconfigured",
      );
      return null;
    }
    const openid = anchored.identityId
      ? await deps.wechatTarget(tx, anchored.identityId, n.merchantUserId!)
      : null;
    if (anchored.identityId && !openid) {
      await terminal(tx, deps, d, "skipped", "no_target");
      return null;
    }
    const quota = anchored.identityId
      ? await tx.wxSubscribeQuota.findFirst({
          where: {
            wechatIdentityId: anchored.identityId,
            merchantUserId: n.merchantUserId!,
            wxTemplateSlotKey: slot!,
            state: "ok",
            estRemaining: { gt: 0 },
          },
        })
      : null;
    if (!quota) {
      await terminal(tx, deps, d, "skipped", "no_quota");
      return null;
    }
    const stored = NotifyFactSchema.parse(n.vars);
    const archive = await currentStoreArchiveNotification(tx, deps, n);
    const current =
      archive === undefined
        ? await currentNotificationFact(tx, deps, specFor(n.notifySceneKey, n.bizType)!, n.bizId!)
        : archive?.fact;
    const fields = current
      ? renderWechat(slot!, template.fields, {
          ...stored,
          ...current,
          ...(stored.quantity === undefined
            ? {}
            : { quantity: stored.quantity, detail: stored.detail }),
        })
      : null;
    if (!openid || !fields) {
      await terminal(tx, deps, d, "skipped", openid ? "unconfigured" : "no_target");
      return null;
    }
    const reserved = await tx.wxSubscribeQuota.updateMany({
      where: {
        wechatIdentityId: quota.wechatIdentityId,
        wxTemplateSlotKey: slot!,
        merchantUserId: n.merchantUserId!,
        state: "ok",
        estRemaining: { gt: 0 },
      },
      data: { estRemaining: { decrement: 1 }, lastSendAt: now, updatedAt: now },
    });
    if (!reserved.count) {
      await terminal(tx, deps, d, "skipped", "no_quota");
      return null;
    }
    identityId = quota.wechatIdentityId;
    acceptedAt = quota.lastAcceptAt;
    ref = identityId;
    templateId = template.providerTemplateId;
    send = (signal) =>
      deps.providers.wechat.sendSubscribeMessage({
        openid,
        templateId: template.providerTemplateId!,
        data: fields,
        signal,
      });
  } else if (d.channel === "sms") {
    const template = d.smsTemplateKey
      ? await tx.smsTemplate.findUnique({ where: { templateKey: d.smsTemplateKey } })
      : null;
    if (
      !(await deps.smsEnabled(tx, n.entityId)) ||
      !template?.providerTemplateId ||
      !template.signName ||
      !["active", "suspect"].includes(template.status) ||
      !deps.providers.sms.configured
    ) {
      await terminal(tx, deps, d, "skipped", "unconfigured");
      return null;
    }
    if (!target.phone || !target.phoneRef) {
      await terminal(tx, deps, d, "skipped", "no_target");
      return null;
    }
    const used = await smsDayUsage(tx, { targetRef: target.phoneRef, now });
    if (used >= (await deps.params.get("notify.sms.daily_cap"))) {
      await terminal(tx, deps, d, "skipped", "rate_limited");
      return null;
    }
    const due = notificationDueAt(
      now,
      d.id,
      true,
      await deps.params.get("notify.window.start"),
      await deps.params.get("notify.window.end"),
    );
    if (due > now) {
      await tx.notificationDelivery.updateMany({
        where: { id, status: "sending", attemptNo: d.attemptNo },
        data: {
          status: "pending",
          attemptNo: { decrement: 1 },
          dueAt: due,
          leaseUntil: null,
          updatedAt: now,
        },
      });
      return null;
    }
    const params = renderSms(
      template.templateKey,
      template.params,
      NotifyFactSchema.parse(n.vars),
      cfg.name,
      n.notifySceneKey,
    );
    if (params === null) {
      await terminal(tx, deps, d, "skipped", "unconfigured");
      return null;
    }
    ref = target.phoneRef;
    mask = target.phoneMask ?? null;
    templateId = template.providerTemplateId;
    send = (signal) =>
      deps.providers.sms.sendSubscribeFallback({
        phone: target.phone!,
        templateKey: template.templateKey,
        params,
        signal,
      });
  } else if (d.channel === "wecom") {
    if (!target.wecomUserid || !deps.providers.wecom.configured) {
      await terminal(tx, deps, d, "skipped", target.wecomUserid ? "unconfigured" : "no_target");
      return null;
    }
    const workAt =
      n.notifySceneKey === "s.kf_response_overdue" ? now : await deps.staffWorkAt(tx, now);
    if (workAt > now) {
      await tx.notificationDelivery.updateMany({
        where: { id, status: "sending", attemptNo: d.attemptNo, callStartedAt: null },
        data: {
          status: "pending",
          attemptNo: { decrement: 1 },
          dueAt: workAt,
          leaseUntil: null,
          updatedAt: now,
        },
      });
      return null;
    }
    const used = await tx.notificationDelivery.count({
      where: {
        channel: "wecom",
        targetRef: target.wecomUserid,
        callStartedAt: { gte: new Date(now.getTime() - 60_000) },
      },
    });
    if (used >= 10) {
      await tx.notificationDelivery.updateMany({
        where: { id, status: "sending", attemptNo: d.attemptNo },
        data: {
          status: "pending",
          attemptNo: { decrement: 1 },
          dueAt: new Date(now.getTime() + 60_000),
          leaseUntil: null,
          updatedAt: now,
        },
      });
      return null;
    }
    ref = target.wecomUserid;
    send = (signal) =>
      deps.providers.wecom.sendAppMessage({
        toUser: target.wecomUserid!,
        title: cfg.name,
        description: cfg.name,
        signal,
      });
  } else {
    await terminal(tx, deps, d, "skipped", "unconfigured");
    return null;
  }
  const startedAt = deps.clock.now();
  const started = await tx.notificationDelivery.updateMany({
    where: {
      id,
      status: "sending",
      attemptNo: d.attemptNo,
      callStartedAt: null,
      leaseUntil: { gt: startedAt },
    },
    data: {
      callStartedAt: startedAt,
      leaseUntil: new Date(startedAt.getTime() + 30_000),
      targetRef: ref,
      targetMasked: mask,
      providerTemplateId: templateId,
      updatedAt: startedAt,
    },
  });
  if (!started.count) throw new LostClaim(); // Whole T2 rolls quota deduction back.
  return { id, attempt: d.attemptNo, identityId, slot, acceptedAt, startedAt, send };
}

async function settle(
  tx: Tx,
  deps: NotifyDispatchDeps,
  prepared: Prepared,
  result: NotificationProviderResult<unknown>,
) {
  let d = await deliveryAt(tx, prepared.id);
  if (!d) return;
  await anchors(tx, deps, d, prepared.identityId);
  d = await deliveryAt(tx, prepared.id);
  if (!d) return;
  const verdict = sendVerdict(result);
  const now = deps.clock.now();
  const late = d.status === "failed" && d.reason === "unknown_outcome" && verdict.success;
  if (d.attemptNo !== prepared.attempt || (d.status !== "sending" && !late)) return;
  const retry = !verdict.success && verdict.retry && d.attemptNo < d.maxAttempts;
  const status = verdict.success ? "sent" : retry ? "pending" : "failed";
  const reason =
    verdict.success || retry ? null : verdict.retry ? "retry_exhausted" : verdict.reason;
  const changed = await tx.notificationDelivery.updateMany({
    where: { id: d.id, attemptNo: prepared.attempt, status: d.status },
    data: {
      status,
      reason,
      leaseUntil: null,
      providerMsgId: verdict.providerMsgId,
      errorCode: verdict.code,
      finishedAt: retry ? null : now,
      sentAt: verdict.success ? now : null,
      dueAt: retry ? new Date(now.getTime() + (d.attemptNo === 1 ? 30_000 : 120_000)) : d.dueAt,
      updatedAt: now,
    },
  });
  if (!changed.count) return;
  if (
    prepared.identityId &&
    prepared.slot &&
    !late &&
    !verdict.success &&
    verdict.reason !== "unknown_outcome"
  ) {
    if (verdict.reason === "user_refused" || verdict.code === "invalid_openid") {
      await tx.wxSubscribeQuota.updateMany({
        where: {
          wechatIdentityId: prepared.identityId,
          ...(verdict.code === "invalid_openid" ? {} : { wxTemplateSlotKey: prepared.slot }),
        },
        data: { estRemaining: 0, updatedAt: now },
      });
    } else {
      const cap = await deps.params.get("notify.wx.quota_cap");
      await tx.$executeRaw`UPDATE wx_subscribe_quota SET est_remaining = LEAST(est_remaining + 1, ${cap}), updated_at = ${now}::timestamptz
        WHERE wechat_identity_id = ${prepared.identityId}::uuid AND wx_template_slot_key = ${prepared.slot}
          AND state = 'ok' AND last_accept_at IS NOT DISTINCT FROM ${prepared.acceptedAt}::timestamptz`;
    }
  }
  if (d.channel === "wx_subscribe" && prepared.slot && !late) {
    if (verdict.success)
      await tx.wxTemplateSlot.updateMany({
        where: { slotKey: prepared.slot },
        data: { failStreak: 0, updatedAt: now },
      });
    else if (verdict.code === "template_invalid" || verdict.code === "field_mismatch") {
      const slotRow = await tx.wxTemplateSlot.findUnique({ where: { slotKey: prepared.slot } });
      if (slotRow) {
        const streak =
          verdict.code === "field_mismatch" ? slotRow.failStreak + 1 : slotRow.failStreak;
        const disabled =
          verdict.code === "template_invalid" ||
          streak >= (await deps.params.get("notify.wx.field_fail_streak"));
        await tx.wxTemplateSlot.update({
          where: { slotKey: prepared.slot },
          data: {
            failStreak: streak,
            ...(disabled
              ? {
                  status: "disabled",
                  disabledReason:
                    verdict.code === "template_invalid"
                      ? "template_invalid"
                      : "field_mismatch_streak",
                }
              : {}),
            updatedAt: now,
          },
        });
      }
    }
  }
  if (d.channel === "sms" && verdict.success && d.smsTemplateKey)
    await tx.smsTemplate.update({
      where: { templateKey: d.smsTemplateKey },
      data: { lastOkAt: now, updatedAt: now },
    });
  if (late && d.notificationId)
    await tx.notificationDelivery.updateMany({
      where: {
        notificationId: d.notificationId,
        channel: "sms",
        origin: "fallback",
        status: { in: ["pending", "sending"] },
        callStartedAt: null,
      },
      data: {
        status: "cancelled",
        reason: "primary_late_success",
        finishedAt: now,
        leaseUntil: null,
        updatedAt: now,
      },
    });
  if (reason) await fallback(tx, deps, d, reason);
  return verdict.code === "template_invalid" || verdict.code === "field_mismatch"
    ? { slot: prepared.slot, code: verdict.code }
    : null;
}

export function deliveryRunner(deps: NotifyDispatchDeps) {
  const calls = new Set<{ controller: AbortController; done: Promise<void> }>();
  let closed = false;
  const pending = new Set<Promise<void>>();
  async function deliver(ref: { deliveryId: string }) {
    assertNotInTransaction("notify.deliver");
    if (closed) return;
    const job = execute(ref).finally(() => pending.delete(job));
    pending.add(job);
    await job;
  }
  async function execute(ref: { deliveryId: string }) {
    const id = ref.deliveryId;
    const claim = await deps.tx.run(async (tx) => {
      const now = deps.clock.now();
      return tx.$executeRaw`UPDATE notification_delivery SET status = 'sending', attempt_no = attempt_no + 1,
        lease_until = ${now}::timestamptz + interval '60 seconds',
        call_started_at = NULL, updated_at = ${now}::timestamptz
        WHERE id = ${id}::uuid AND status = 'pending' AND due_at <= ${now}::timestamptz
          AND channel <> 'inbox' AND attempt_no < max_attempts`;
    });
    if (!claim) return;
    let prepared: Prepared | null;
    try {
      prepared = await deps.tx.run((tx) => prepare(tx, deps, id));
    } catch (error) {
      if (error instanceof LostClaim) return;
      throw error;
    }
    if (!prepared) return;
    const controller = new AbortController();
    if (closed) controller.abort();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const call = { controller, done: Promise.resolve() };
    call.done = (async () => {
      let result: NotificationProviderResult<unknown>;
      if (closed) {
        result = {
          ok: false,
          reason: "unavailable",
          message: "通知在外呼前已取消",
          notification: { acceptance: "not_accepted", code: "aborted" },
        };
      } else {
        try {
          result = await prepared.send(controller.signal);
        } catch {
          result = { ok: false, reason: "unavailable", message: "通知发送结果未知" };
        }
      }
      const alert = await deps.tx.run((tx) => settle(tx, deps, prepared, result));
      if (alert?.slot)
        await deps.alerts.raise({
          rule: "notify.wx_template_failure",
          dimension: alert.slot,
          severity: "P2",
          detail: { slotKey: alert.slot, code: alert.code },
        });
    })().finally(() => {
      clearTimeout(timer);
      calls.delete(call);
    });
    calls.add(call);
    await call.done;
  }
  async function scan(enqueue: (ref: { deliveryId: string; attemptNo: number }) => Promise<void>) {
    if (closed) return 0;
    const now = deps.clock.now();
    const expired = await deps.tx.run((tx) =>
      tx.notificationDelivery.findMany({
        where: { status: "sending", leaseUntil: { lte: now } },
        select: { id: true },
        orderBy: { id: "asc" },
        take: 200,
      }),
    );
    for (const row of expired)
      await deps.tx.run(async (tx) => {
        let d = await deliveryAt(tx, row.id);
        if (!d) return;
        await anchors(tx, deps, d);
        d = await deliveryAt(tx, row.id);
        if (!d || d.status !== "sending" || !d.leaseUntil || d.leaseUntil > deps.clock.now())
          return;
        if (d.callStartedAt !== null) await terminal(tx, deps, d, "failed", "unknown_outcome");
        else if (d.attemptNo >= d.maxAttempts)
          await terminal(tx, deps, d, "failed", "claim_exhausted");
        else
          await tx.notificationDelivery.updateMany({
            where: { id: d.id, status: "sending", attemptNo: d.attemptNo, callStartedAt: null },
            data: {
              status: "pending",
              leaseUntil: null,
              dueAt: deps.clock.now(),
              updatedAt: deps.clock.now(),
            },
          });
      });
    const due = await deps.tx.run((tx) =>
      tx.notificationDelivery.findMany({
        where: { status: "pending", dueAt: { lte: deps.clock.now() } },
        select: { id: true, attemptNo: true },
        orderBy: [{ dueAt: "asc" }, { id: "asc" }],
        take: 200,
      }),
    );
    for (let offset = 0; offset < due.length && !closed; offset += 2) {
      await Promise.all(
        due.slice(offset, offset + 2).map(async (row) => {
          try {
            await enqueue({ deliveryId: row.id, attemptNo: row.attemptNo + 1 });
          } catch {
            await deliver({ deliveryId: row.id });
          }
        }),
      );
    }
    return due.length;
  }
  return {
    deliver,
    scan,
    async close() {
      closed = true;
      for (const call of calls) call.controller.abort();
      await Promise.allSettled([...pending]);
    },
  };
}
