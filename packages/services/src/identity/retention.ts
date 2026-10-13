import type { CleanupContext, Tx } from "../kernel/index.js";

const DAY = 86_400_000;

/** 15分组§5.3：失效超过30天才删，含空闲/绝对期限和主动吊销。 */
export function purgeUserSessions(tx: Tx, { now, limit }: CleanupContext): Promise<number> {
  return tx.$executeRawUnsafe(
    `DELETE FROM user_session WHERE id IN (
       SELECT id FROM user_session
        WHERE absolute_expires_at < $1::timestamptz
           OR idle_expires_at < $1::timestamptz
           OR revoked_at < $1::timestamptz
        ORDER BY absolute_expires_at, id
        LIMIT $2::int FOR UPDATE SKIP LOCKED
     )`,
    new Date(now.getTime() - 30 * DAY),
    limit,
  );
}

export function purgePortalSessions(tx: Tx, { now, limit }: CleanupContext): Promise<number> {
  return tx.$executeRawUnsafe(
    `DELETE FROM portal_session WHERE id IN (
       SELECT id FROM portal_session
        WHERE expires_at < $1::timestamptz OR revoked_at < $1::timestamptz
        ORDER BY expires_at, id
        LIMIT $2::int FOR UPDATE SKIP LOCKED
     )`,
    new Date(now.getTime() - 30 * DAY),
    limit,
  );
}

export function purgeSmsVerifications(tx: Tx, { now, limit }: CleanupContext): Promise<number> {
  return tx.$executeRawUnsafe(
    `DELETE FROM sms_verification WHERE id IN (
       SELECT id FROM sms_verification WHERE expires_at < $1::timestamptz
        ORDER BY expires_at, id
        LIMIT $2::int FOR UPDATE SKIP LOCKED
     )`,
    new Date(now.getTime() - 7 * DAY),
    limit,
  );
}
