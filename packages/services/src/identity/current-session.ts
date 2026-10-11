import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { sessionInvalidReason } from "./session-validity.js";
import type { SessionPrincipal } from "./types.js";

/** 调用方在最后等待后给出新时钟；仅验证这一条语句的快照，不续期或锁住会话。 */
export async function assertCurrentSession(
  tx: Tx,
  principal: SessionPrincipal,
  freshNow: Date,
  expectedAppid: string,
): Promise<SessionPrincipal> {
  if (!Number.isFinite(freshNow.getTime())) throw new TypeError("会话校验需要有效时钟");
  const [row] = await tx.$queryRaw<
    {
      sessionId: string;
      merchantUserId: string;
      wechatIdentityId: string | null;
      identityOwner: string | null;
      appid: string | null;
      revokedAt: Date | null;
      absoluteExpiresAt: Date;
      idleExpiresAt: Date;
      accountStatus: string;
      consentStamp: string | null;
    }[]
  >`
    SELECT s.id AS "sessionId", s.merchant_user_id AS "merchantUserId",
      i.id AS "wechatIdentityId", i.merchant_user_id AS "identityOwner", i.appid,
      s.revoked_at AS "revokedAt", s.absolute_expires_at AS "absoluteExpiresAt",
      s.idle_expires_at AS "idleExpiresAt", u.status AS "accountStatus",
      u.consent_stamp AS "consentStamp"
    FROM user_session s JOIN merchant_user u ON u.id = s.merchant_user_id
    LEFT JOIN wechat_identity i ON i.id = s.wechat_identity_id
    WHERE s.id = ${principal.sessionId}::uuid
  `;
  if (
    !row ||
    row.merchantUserId !== principal.merchantUserId ||
    row.wechatIdentityId !== principal.wechatIdentityId ||
    row.identityOwner !== principal.merchantUserId ||
    row.appid !== expectedAppid ||
    sessionInvalidReason({ ...row, revoked: row.revokedAt !== null }, freshNow) !== undefined
  )
    throw new AppError("SESSION_INVALID");
  return {
    sessionId: row.sessionId,
    merchantUserId: row.merchantUserId,
    wechatIdentityId: principal.wechatIdentityId,
    consentStamp: row.consentStamp,
  };
}
