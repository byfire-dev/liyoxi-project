import { notifyReadOf } from "../kernel/index.js";
import type { Assembly, InvariantViolation, Tx } from "../kernel/index.js";

const LIMIT = 200;
type Found = { id: string; entityId?: string | null; problem: string };
const violations = (type: string, rows: readonly Found[]): InvariantViolation[] =>
  rows.map((row) => ({
    subject: { type, id: row.id },
    ...(row.entityId ? { entityId: row.entityId } : {}),
    detail: { problem: row.problem },
  }));

/** Inbox ownership is checked against the immutable notification, including account messages. */
export async function findNotifyN1Violations(tx: Tx): Promise<InvariantViolation[]> {
  const rows = await tx.$queryRaw<Found[]>`
    SELECT n.id::text AS id, n.entity_id::text AS "entityId",
           'inbox_recipient_or_scope_mismatch' AS problem
      FROM notification n
      LEFT JOIN merchant_user u ON u.id = n.merchant_user_id
      LEFT JOIN merchant_message m ON m.notification_id = n.id
      LEFT JOIN staff_message s ON s.notification_id = n.id
     WHERE CASE WHEN n.merchant_user_id IS NOT NULL THEN
             s.id IS NOT NULL OR
             (m.id IS NULL AND u.status <> 'deleted') OR
             (m.id IS NOT NULL AND (
               m.merchant_user_id IS DISTINCT FROM n.merchant_user_id OR
               m.entity_id IS DISTINCT FROM n.entity_id OR
               m.store_id IS DISTINCT FROM n.store_id))
           ELSE m.id IS NOT NULL OR s.id IS NULL OR s.staff_id IS DISTINCT FROM n.staff_id END
     ORDER BY n.id LIMIT ${LIMIT}`;
  return violations("notification", rows);
}

/** The scheduler supplies business time; the exact five/ten minute boundaries are healthy. */
export async function findNotifyN2Violations(
  tx: Tx,
  options: { readonly now: Date },
): Promise<InvariantViolation[]> {
  const leaseBefore = new Date(options.now.getTime() - 5 * 60_000);
  const dueBefore = new Date(options.now.getTime() - 10 * 60_000);
  const rows = await tx.$queryRaw<Found[]>`
    SELECT id::text AS id,
           CASE WHEN status = 'sending' THEN 'expired_sending_lease'
                ELSE 'overdue_pending_delivery' END AS problem
      FROM notification_delivery
     WHERE (status = 'sending' AND lease_until < ${leaseBefore})
        OR (status = 'pending' AND due_at < ${dueBefore})
     ORDER BY id LIMIT ${LIMIT}`;
  return violations("notification_delivery", rows);
}

/** Current disabled/unconfigured interval only: successful deliveries before disable remain valid. */
export async function findNotifyN3Violations(tx: Tx): Promise<InvariantViolation[]> {
  const rows = await tx.$queryRaw<{ key: string; problem: string }[]>`
    SELECT slot_key AS key, 'sent_during_unavailable_slot' AS problem
      FROM wx_template_slot slot
     WHERE slot.status <> 'active' AND EXISTS (
       SELECT 1 FROM notification_delivery d
       JOIN notification n ON n.id = d.notification_id
       JOIN notify_scene scene ON scene.scene_key = n.notify_scene_key
       WHERE d.channel = 'wx_subscribe' AND d.status = 'sent'
         AND scene.wx_template_slot_key = slot.slot_key
         AND d.sent_at >= slot.updated_at
         AND (slot.provider_template_id IS NULL OR d.provider_template_id = slot.provider_template_id))
    UNION
    SELECT wx_template_slot_key AS key, 'negative_subscription_quota' AS problem
      FROM wx_subscribe_quota WHERE est_remaining < 0
    ORDER BY key, problem LIMIT ${LIMIT}`;
  return rows.map((row) => ({
    subject: { type: "wx_template_slot", key: row.key },
    detail: { problem: row.problem },
  }));
}

/** Upper business objects are checked by their owning domains through the existing keyed port. */
export async function findNotifyN15Violations(
  tx: Tx,
  assembly: Assembly,
): Promise<InvariantViolation[]> {
  const read = notifyReadOf(assembly);
  const found: InvariantViolation[] = [];
  let cursor: string | undefined;
  while (found.length < LIMIT) {
    const rows = await tx.manualReminderLog.findMany({
      ...(cursor ? { where: { id: { gt: cursor } } } : {}),
      select: { id: true, subjectType: true, subjectId: true },
      orderBy: { id: "asc" },
      take: LIMIT,
    });
    if (!rows.length) break;
    for (const row of rows) {
      const key = `manualSubjectExists.${row.subjectType}`;
      if (!read.has(key)) throw new Error(`notify.N15 缺少实际对象事实登记：${key}`);
      const exists = await read.read(tx, key, row.subjectId);
      if (typeof exists !== "boolean") throw new Error(`notify.N15 对象事实读取失败：${key}`);
      if (!exists)
        found.push({
          subject: { type: row.subjectType, id: row.subjectId },
          detail: { problem: "manual_reminder_subject_missing" },
        });
      if (found.length === LIMIT) break;
    }
    cursor = rows.at(-1)!.id;
    if (rows.length < LIMIT) break;
  }
  return found;
}
