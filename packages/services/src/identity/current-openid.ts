import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { SessionPrincipal } from "./types.js";
/** 仅本请求的内容检测使用，不进响应、审计与日志；不可换成同意记录的 HMAC。 */
export async function currentSessionOpenid(tx: Tx, principal: SessionPrincipal): Promise<string> {
  const session = await tx.userSession.findUnique({
    where: { id: principal.sessionId },
    select: { merchantUserId: true, wechatIdentityId: true, revokedAt: true },
  });
  if (
    !session ||
    session.revokedAt !== null ||
    session.merchantUserId !== principal.merchantUserId ||
    session.wechatIdentityId !== principal.wechatIdentityId
  )
    throw new AppError("SESSION_INVALID");
  const identity = await tx.wechatIdentity.findUnique({
    where: { id: principal.wechatIdentityId },
    select: { merchantUserId: true, openid: true },
  });
  if (!identity || identity.merchantUserId !== principal.merchantUserId)
    throw new AppError("SESSION_INVALID");
  return identity.openid;
}
