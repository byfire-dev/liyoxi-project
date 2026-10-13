import type {
  MeUser,
  UserNoticeAckResult,
  WechatIdentityList,
  WechatIdentityRemoveResult,
} from "@liyoxi/contract";
import { record as recordAudit, recordAuthEvent } from "../audit/index.js";
import { AppError, createThreePhaseRunner, isUuid, lockRows } from "../kernel/index.js";
import type { Clock, IdempotencyContext, Tx, TxRunner } from "../kernel/index.js";
import type { Config } from "../config/index.js";
import type { WechatProvider } from "../providers/types.js";
import { assertCurrentSession } from "./current-session.js";
import { currentSessionOpenid } from "./current-openid.js";
import { revokeIdentitySessions } from "./sessions.js";
import type { RequestMeta, SessionPrincipal } from "./types.js";

export interface PersonalAccountDeps {
  tx: TxRunner;
  clock: Clock;
  appid: string;
  config: { params: Pick<Config["params"], "get"> };
  wechat: Partial<Pick<WechatProvider, "checkText">> | null;
  smsConfigured?: () => boolean;
}
type Options = { idem?: IdempotencyContext };
const DAY = 86_400_000;
const identitySelect = { id: true, merchantUserId: true, createdAt: true } as const;
const authorize = (tx: Tx, deps: PersonalAccountDeps, principal: SessionPrincipal) =>
  assertCurrentSession(tx, principal, deps.clock.now(), deps.appid);
async function beforeWrite(deps: PersonalAccountDeps, principal: SessionPrincipal) {
  await deps.tx.run((tx) => authorize(tx, deps, principal));
}
async function lockedSession(tx: Tx, deps: PersonalAccountDeps, principal: SessionPrincipal) {
  await lockRows(tx, "merchant_user", [principal.merchantUserId]);
  return authorize(tx, deps, principal);
}
async function meUser(tx: Tx, deps: PersonalAccountDeps, id: string): Promise<MeUser> {
  const row = await tx.merchantUser.findUnique({
    where: { id },
    select: { id: true, displayName: true, phoneMask: true, createdAt: true },
  });
  if (!row?.phoneMask) throw new AppError("SESSION_INVALID");
  return {
    merchantUserId: row.id,
    displayName: row.displayName,
    phoneMask: row.phoneMask,
    registeredAt: row.createdAt.toISOString(),
    actions: ["update", ...(deps.smsConfigured?.() ? ["change-phone" as const] : []), "deletion"],
  };
}
function checkedId(id: string) {
  if (!isUuid(id)) throw new AppError("VALIDATION_FAILED");
  return id;
}
async function minimumAge(deps: PersonalAccountDeps) {
  const days = await deps.config.params.get("auth.identity_remove_min_age_days");
  if (!Number.isFinite(days) || days < 0) throw new AppError("INTERNAL");
  return days * DAY;
}

export async function updateMe(
  deps: PersonalAccountDeps,
  principal: SessionPrincipal,
  _meta: RequestMeta,
  input: { displayName: string },
  options: Options = {},
): Promise<MeUser> {
  const name = typeof input.displayName === "string" ? input.displayName.trim() : "";
  if (!name || [...name].length > 20) throw new AppError("VALIDATION_FAILED");
  await beforeWrite(deps, principal);
  return createThreePhaseRunner(deps).run(
    {
      claim: async (tx) => {
        await authorize(tx, deps, principal);
        return currentSessionOpenid(tx, principal, deps.appid);
      },
      external: async (openid) => {
        if (!deps.wechat?.checkText) throw new AppError("PROVIDER_UNAVAILABLE");
        const checked = await deps.wechat
          .checkText({ openid, scene: "profile", content: name })
          .catch(() => {
            throw new AppError("PROVIDER_UNAVAILABLE");
          });
        if (!checked.ok) throw new AppError("PROVIDER_UNAVAILABLE");
        if (checked.value.verdict !== "pass")
          throw new AppError("CONTENT_REJECTED", { details: { fields: ["displayName"] } });
      },
      settle: async (tx) => {
        await lockedSession(tx, deps, principal);
        await tx.merchantUser.update({
          where: { id: principal.merchantUserId },
          data: { displayName: name, updatedAt: deps.clock.now() },
        });
        return meUser(tx, deps, principal.merchantUserId);
      },
    },
    options,
  );
}

export async function acknowledgeUserNotice(
  deps: PersonalAccountDeps,
  principal: SessionPrincipal,
  _meta: RequestMeta,
  input: { userNoticeId: string },
  options: Options = {},
): Promise<UserNoticeAckResult> {
  checkedId(input.userNoticeId);
  await beforeWrite(deps, principal);
  return deps.tx.run(async (tx) => {
    await lockedSession(tx, deps, principal);
    const row = await tx.merchantUserNotice.findFirst({
      where: { id: input.userNoticeId, merchantUserId: principal.merchantUserId },
    });
    if (!row) throw new AppError("NOT_FOUND");
    const ackedAt = row.ackedAt ?? deps.clock.now();
    if (row.ackedAt === null)
      await tx.merchantUserNotice.update({
        where: { id: row.id },
        data: { ackedAt, updatedAt: ackedAt },
      });
    return { userNoticeId: row.id, ackedAt: ackedAt.toISOString() };
  }, options);
}

type Cursor = { v: 1; user: string; current: string; pinned: boolean; at: string; id: string };
function cursorOf(text: string | undefined, principal: SessionPrincipal): Cursor | null {
  if (text === undefined) return null;
  try {
    if (text.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error();
    const decoded = Buffer.from(text, "base64url");
    if (decoded.toString("base64url") !== text) throw new Error();
    const value = JSON.parse(decoded.toString("utf8")) as Cursor;
    if (
      value.v !== 1 ||
      value.user !== principal.merchantUserId ||
      value.current !== principal.wechatIdentityId ||
      typeof value.pinned !== "boolean" ||
      !isUuid(value.id) ||
      new Date(value.at).toISOString() !== value.at
    )
      throw new Error();
    return value;
  } catch {
    throw new AppError("VALIDATION_FAILED");
  }
}
export async function listWechatIdentities(
  deps: PersonalAccountDeps,
  principal: SessionPrincipal,
  input: { cursor?: string | undefined; limit?: number | undefined } = {},
): Promise<WechatIdentityList> {
  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AppError("VALIDATION_FAILED");
  const cursor = cursorOf(input.cursor, principal),
    age = await minimumAge(deps);
  return deps.tx.run(async (tx) => {
    await authorize(tx, deps, principal);
    const current = await tx.wechatIdentity.findUnique({
      where: { id: principal.wechatIdentityId },
      select: identitySelect,
    });
    if (!current || current.merchantUserId !== principal.merchantUserId)
      throw new AppError("SESSION_INVALID");
    const rows = await tx.$queryRawUnsafe<
      Array<{
        id: string;
        boundAt: Date;
        lastLoginAt: Date;
        deviceSummary: string | null;
        isCurrent: boolean;
      }>
    >(
      `SELECT wi.id, wi.created_at AS "boundAt", wi.last_login_at AS "lastLoginAt", s.device_info AS "deviceSummary", (wi.id=$2::uuid) AS "isCurrent"
       FROM wechat_identity wi LEFT JOIN LATERAL (
         SELECT device_info FROM user_session WHERE wechat_identity_id=wi.id AND merchant_user_id=$1::uuid ORDER BY created_at DESC,id DESC LIMIT 1
       ) s ON true WHERE wi.merchant_user_id=$1::uuid AND (NOT $3::boolean OR
         ((CASE WHEN wi.id=$2::uuid THEN 1 ELSE 0 END),wi.last_login_at,wi.id)<($4::int,$5::timestamptz,$6::uuid))
       ORDER BY (wi.id=$2::uuid) DESC,wi.last_login_at DESC,wi.id DESC LIMIT $7`,
      principal.merchantUserId,
      principal.wechatIdentityId,
      cursor !== null,
      cursor?.pinned ? 1 : 0,
      cursor ? new Date(cursor.at) : new Date(0),
      cursor?.id ?? principal.wechatIdentityId,
      limit + 1,
    );
    const page = rows.slice(0, limit),
      hasMore = rows.length > limit,
      last = page.at(-1);
    const removable = deps.clock.now().getTime() >= current.createdAt.getTime() + age;
    return {
      items: page.map((row) => ({
        wechatIdentityId: row.id,
        boundAt: row.boundAt.toISOString(),
        lastLoginAt: row.lastLoginAt.toISOString(),
        deviceSummary: row.deviceSummary,
        isCurrent: row.isCurrent,
        actions: row.isCurrent || removable ? ["delete" as const] : [],
      })),
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                user: principal.merchantUserId,
                current: principal.wechatIdentityId,
                pinned: last.isCurrent,
                at: last.lastLoginAt.toISOString(),
                id: last.id,
              } satisfies Cursor),
            ).toString("base64url")
          : null,
      hasMore,
    };
  });
}

export async function removeWechatIdentity(
  deps: PersonalAccountDeps,
  principal: SessionPrincipal,
  meta: RequestMeta,
  input: { wechatIdentityId: string },
  options: Options = {},
): Promise<WechatIdentityRemoveResult> {
  checkedId(input.wechatIdentityId);
  await beforeWrite(deps, principal);
  const age = await minimumAge(deps);
  return deps.tx.run(async (tx) => {
    await lockRows(tx, "merchant_user", [principal.merchantUserId]);
    const target = await tx.wechatIdentity.findFirst({
      where: { id: input.wechatIdentityId, merchantUserId: principal.merchantUserId },
      select: identitySelect,
    });
    if (!target) throw new AppError("NOT_FOUND");
    await lockRows(
      tx,
      "wechat_identity",
      [...new Set([principal.wechatIdentityId, target.id])].sort(),
    );
    await authorize(tx, deps, principal);
    const locked = await tx.wechatIdentity.findFirst({
      where: { id: target.id, merchantUserId: principal.merchantUserId },
      select: identitySelect,
    });
    if (!locked) throw new AppError("NOT_FOUND");
    const current = await tx.wechatIdentity.findUniqueOrThrow({
      where: { id: principal.wechatIdentityId },
      select: identitySelect,
    });
    const now = deps.clock.now(),
      isCurrentSessionRevoked = target.id === principal.wechatIdentityId;
    const removableAt = new Date(current.createdAt.getTime() + age);
    if (!isCurrentSessionRevoked && now < removableAt)
      throw new AppError("IDENTITY_TOO_NEW", {
        details: { removableAt: removableAt.toISOString() },
      });
    const revokedSessionCount = await revokeIdentitySessions(
      tx,
      now,
      target.id,
      "identity_removed",
    );
    await tx.wechatIdentity.delete({ where: { id: target.id } });
    const actor = {
      type: "merchant" as const,
      id: principal.merchantUserId,
      client: "weapp" as const,
      role: null,
    };
    await recordAudit(
      tx,
      actor,
      {
        requestId: meta.requestId,
        ip: meta.ip,
        userAgent: meta.userAgent,
        authMethod: "weapp",
        sessionId: principal.sessionId,
      },
      {
        stream: "ops",
        category: "account_security",
        action: "identity.wechat_identity.remove",
        summary: "移除微信",
        target: { type: "wechat_identity", id: target.id, label: "微信身份" },
      },
    );
    await recordAuthEvent(tx, {
      space: "merchant",
      subjectId: principal.merchantUserId,
      event: "identity_removed",
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: {
        identityId: target.id,
        revokedSessions: revokedSessionCount,
        requestId: meta.requestId,
      },
      at: now,
    });
    return { wechatIdentityId: target.id, revokedSessionCount, isCurrentSessionRevoked };
  }, options);
}
