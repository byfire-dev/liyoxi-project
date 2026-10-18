import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { MeUser } from "@liyoxi/contract";
import type { Approval } from "../approval/index.js";
import { record } from "../audit/index.js";
import type { Events } from "../events/index.js";
import type { Flow } from "../flow/index.js";
import {
  AppError,
  createIdentityContext,
  createThreePhaseRunner,
  isUniqueViolation,
  lockRows,
  uuidv7,
} from "../kernel/index.js";
import type { Clock, IdempotencyContext, IdentityContext, Tx, TxRunner } from "../kernel/index.js";
import type { NotifyDispatcherService } from "../notify/index.js";
import type { WechatProvider } from "../providers/types.js";
import { blindIndex, decryptField, sealPhone } from "../security/index.js";
import type { Keyring } from "../security/index.js";
import { assertCurrentSession } from "./current-session.js";
import { lockAccountChanges, purgeEmptyAccountIn } from "./empty-account.js";
import { mainlandMobileOf } from "./phone.js";
import type { RequestMeta, SessionPrincipal } from "./types.js";

export interface PhoneChangeDeps {
  tx: TxRunner;
  clock: Clock;
  appid: string;
  keyring: () => Keyring;
  flow: Flow;
  events: Pick<Events, "emit">;
  wechat: Pick<WechatProvider, "getPhoneNumber"> | null;
  smsConfigured?: () => boolean;
  notify?: Pick<NotifyDispatcherService, "sendDirect">;
  approval?: Pick<Approval, "withdraw">;
}
type Options = { idem?: IdempotencyContext };
type SmsCodeResult = {
  purpose: "phone_change";
  targetPhoneMask: string;
  expiresAt: string;
  resendAfterSec: number;
};
const codeHash = (code: string) => Buffer.from(createHash("sha256").update(code).digest());
const authorize = (tx: Tx, deps: PhoneChangeDeps, principal: SessionPrincipal) =>
  assertCurrentSession(tx, principal, deps.clock.now(), deps.appid);
async function beforeWrite(deps: PhoneChangeDeps, principal: SessionPrincipal) {
  await deps.tx.run((tx) => authorize(tx, deps, principal));
}
function smsAvailable(deps: PhoneChangeDeps) {
  if (!deps.smsConfigured?.() || !deps.notify) throw new AppError("SMS_UNAVAILABLE");
}
async function accountOf(tx: Tx, deps: PhoneChangeDeps, principal: SessionPrincipal) {
  await authorize(tx, deps, principal);
  const row = await tx.merchantUser.findUnique({ where: { id: principal.merchantUserId } });
  if (!row?.phoneEnc || !row.phoneBidx || !row.phoneMask) throw new AppError("SESSION_INVALID");
  return row as typeof row & {
    phoneEnc: string;
    phoneBidx: Buffer<ArrayBuffer>;
    phoneMask: string;
  };
}
async function latestCode(tx: Tx, principal: SessionPrincipal, phoneBidx: Uint8Array<ArrayBuffer>) {
  return tx.smsVerification.findFirst({
    where: { merchantUserId: principal.merchantUserId, purpose: "phone_change", phoneBidx },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}
function usable(row: Awaited<ReturnType<typeof latestCode>>, now: Date) {
  return row !== null && row.usedAt === null && row.expiresAt > now && row.attempts < 5;
}
const invalidCode = (attemptsLeft: number | null) =>
  new AppError("SMS_CODE_INVALID", { details: { attemptsLeft } });

export async function createSmsCode(
  deps: PhoneChangeDeps,
  principal: SessionPrincipal,
  _meta: RequestMeta,
  input: { purpose: "phone_change" },
  options: Options = {},
): Promise<SmsCodeResult> {
  if (input.purpose !== "phone_change") throw new AppError("VALIDATION_FAILED");
  await beforeWrite(deps, principal);
  return createThreePhaseRunner(deps).run(
    {
      claim: async (tx) => {
        smsAvailable(deps);
        await lockRows(tx, "merchant_user", [principal.merchantUserId]);
        const account = await accountOf(tx, deps, principal),
          now = deps.clock.now();
        const code = String(randomInt(1_000_000)).padStart(6, "0"),
          id = uuidv7();
        const expiresAt = new Date(now.getTime() + 300_000);
        await tx.smsVerification.create({
          data: {
            id,
            purpose: "phone_change",
            merchantUserId: account.id,
            phoneBidx: account.phoneBidx,
            codeHash: codeHash(code),
            expiresAt,
            attempts: 0,
            createdAt: now,
            updatedAt: now,
          },
        });
        return {
          id,
          code,
          phone: decryptField(deps.keyring(), "merchant_user.phone_enc", account.phoneEnc),
          phoneBidx: account.phoneBidx,
          result: {
            purpose: "phone_change" as const,
            targetPhoneMask: account.phoneMask,
            expiresAt: expiresAt.toISOString(),
            resendAfterSec: 60,
          },
        };
      },
      external: async (intent) => {
        const result = await deps
          .notify!.sendDirect({
            purpose: "verify_code",
            templateKey: "verify_code",
            phone: intent.phone,
            params: { code: intent.code },
            directKey: `sms_verification:${intent.id}`,
          })
          .catch((error: unknown) => {
            if (error instanceof AppError && error.error === "NOT_FOUND")
              throw new AppError("SMS_UNAVAILABLE");
            throw error;
          });
        if (result.status !== "sent") throw new AppError("SMS_UNAVAILABLE");
      },
      settle: async (tx, _result, intent) => {
        await lockRows(tx, "merchant_user", [principal.merchantUserId]);
        const account = await accountOf(tx, deps, principal);
        if (!Buffer.from(account.phoneBidx).equals(intent.phoneBidx))
          throw new AppError("SESSION_INVALID");
        return intent.result;
      },
      compensate: async (tx, intent) => {
        await tx.smsVerification.deleteMany({ where: { id: intent.id } });
      },
    },
    options,
  );
}

/** 自助/审批共用换绑事务；调用前已预锁相关审批30/申请40与账号80全集。 */
export async function changePhoneIn(
  tx: Tx,
  deps: Pick<
    PhoneChangeDeps,
    "clock" | "keyring" | "flow" | "events" | "approval" | "smsConfigured"
  >,
  input: {
    merchantUserId: string;
    phone: string;
    keepSessionId: string | null;
    via: "self_service" | "approval";
    accountChangeRequestId?: string;
    approvalRequestId?: string;
    approvalContext?: IdentityContext;
  },
  meta: RequestMeta,
  occupantId: string | null,
  changes: Awaited<ReturnType<typeof lockAccountChanges>>,
): Promise<{ user: MeUser; oldPhone: string }> {
  const current = await tx.merchantUser.findUnique({ where: { id: input.merchantUserId } });
  if (
    !current ||
    current.status !== "active" ||
    !current.phoneEnc ||
    !current.phoneBidx ||
    !current.phoneMask
  )
    throw new AppError("SESSION_INVALID");
  const sealed = sealPhone(deps.keyring(), "merchant_user.phone_enc", input.phone);
  if (Buffer.from(current.phoneBidx).equals(sealed.bidx)) throw new AppError("PHONE_UNCHANGED");
  const occupant = await tx.merchantUser.findFirst({ where: { phoneBidx: sealed.bidx } });
  if (occupant && occupant.id !== occupantId) throw new AppError("BUSY");
  if (occupant) {
    if (
      occupant.status !== "active" ||
      (await tx.entityMember.count({ where: { merchantUserId: occupant.id } }))
    )
      throw new AppError("PHONE_TAKEN");
    if (!deps.approval) throw new AppError("INTERNAL");
    await purgeEmptyAccountIn(
      tx,
      { ...deps, approval: deps.approval },
      occupant.id,
      changes,
      input.approvalRequestId,
    );
  }
  const now = deps.clock.now(),
    oldPhone = decryptField(deps.keyring(), "merchant_user.phone_enc", current.phoneEnc);
  const updated = await tx.merchantUser.update({
    where: { id: current.id },
    data: {
      phoneEnc: sealed.enc,
      phoneBidx: sealed.bidx,
      phoneMask: sealed.mask,
      phoneLast4: input.phone.slice(-4),
      updatedAt: now,
    },
  });
  await tx.userSession.updateMany({
    where: {
      merchantUserId: current.id,
      revokedAt: null,
      ...(input.keepSessionId ? { id: { not: input.keepSessionId } } : {}),
    },
    data: { revokedAt: now, revokeReason: "phone_change", updatedAt: now },
  });
  if (input.via === "approval" && (!input.approvalContext || !input.approvalRequestId))
    throw new AppError("INTERNAL");
  const ctx =
    input.approvalContext ??
    createIdentityContext({
      actor:
        input.via === "self_service"
          ? { type: "merchant", id: current.id, client: "weapp" }
          : { type: "system", job: "identity.phone_rebind" },
      ...meta,
    });
  if (input.via === "self_service")
    await record(
      tx,
      ctx.actor,
      { ...meta, authMethod: "weapp", sessionId: input.keepSessionId },
      {
        stream: "ops",
        category: "account_security",
        action: "identity.merchant_user.change_phone",
        summary: "换手机号",
        target: { type: "merchant_user", id: current.id, label: sealed.mask },
        before: { phoneMask: current.phoneMask },
        after: { phoneMask: sealed.mask },
        fields: ["phoneMask"],
      },
    );
  await deps.events.emit(tx, ctx, {
    type: "merchant_user.phone_changed",
    aggregate: { type: "merchant_user", id: current.id },
    payload: {
      v: 1,
      merchantUserId: current.id,
      via: input.via,
      ...(input.accountChangeRequestId
        ? { accountChangeRequestId: input.accountChangeRequestId }
        : {}),
    },
  });
  return {
    oldPhone,
    user: {
      merchantUserId: current.id,
      displayName: updated.displayName,
      phoneMask: sealed.mask,
      registeredAt: updated.createdAt.toISOString(),
      actions: ["update", ...(deps.smsConfigured?.() ? ["change-phone" as const] : []), "deletion"],
    },
  };
}

export async function changePhone(
  deps: PhoneChangeDeps,
  principal: SessionPrincipal,
  meta: RequestMeta,
  input: { oldSmsCode: string; newPhoneCode: string },
  options: Options = {},
): Promise<MeUser> {
  if (!/^\d{4,8}$/.test(input.oldSmsCode) || !input.newPhoneCode || input.newPhoneCode.length > 128)
    throw new AppError("VALIDATION_FAILED");
  await beforeWrite(deps, principal);
  let notice: { phone: string; key: string } | null = null;
  const user = await createThreePhaseRunner(deps).run(
    {
      claim: async (tx) => {
        smsAvailable(deps);
        await lockRows(tx, "merchant_user", [principal.merchantUserId]);
        const account = await accountOf(tx, deps, principal),
          row = await latestCode(tx, principal, account.phoneBidx);
        if (!usable(row, deps.clock.now())) return { valid: false as const, attemptsLeft: null };
        if (!timingSafeEqual(codeHash(input.oldSmsCode), Buffer.from(row!.codeHash))) {
          const attempts = row!.attempts + 1;
          await tx.smsVerification.update({
            where: { id: row!.id },
            data: { attempts, updatedAt: deps.clock.now() },
          });
          return { valid: false as const, attemptsLeft: 5 - attempts };
        }
        return { valid: true as const, codeId: row!.id, phoneBidx: account.phoneBidx };
      },
      external: async (intent) => {
        if (!intent.valid) throw invalidCode(intent.attemptsLeft);
        if (!deps.wechat) throw new AppError("WECHAT_UNAVAILABLE");
        const response = await deps.wechat
          .getPhoneNumber({ code: input.newPhoneCode })
          .catch(() => {
            throw new AppError("WECHAT_UNAVAILABLE");
          });
        if (!response.ok)
          throw new AppError(
            response.reason === "rejected" ? "WECHAT_CODE_INVALID" : "WECHAT_UNAVAILABLE",
          );
        const phone = mainlandMobileOf(
          response.value.phone,
          response.value.countryCode,
          response.value.purePhoneNumber,
        );
        if (!phone) throw new AppError("PHONE_REGION_UNSUPPORTED");
        return phone;
      },
      settle: async (tx, phone, intent) => {
        if (!intent.valid) throw invalidCode(null);
        const bidx = blindIndex(deps.keyring(), "phone", phone);
        const planned = await tx.merchantUser.findFirst({
          where: { phoneBidx: bidx },
          select: { id: true },
        });
        const changes =
          planned && planned.id !== principal.merchantUserId
            ? await lockAccountChanges(tx, planned.id)
            : [];
        await lockRows(
          tx,
          "merchant_user",
          [...new Set([principal.merchantUserId, ...(planned ? [planned.id] : [])])].sort(),
        );
        const current = await accountOf(tx, deps, principal);
        const row = await latestCode(tx, principal, current.phoneBidx);
        if (
          !Buffer.from(current.phoneBidx).equals(intent.phoneBidx) ||
          row?.id !== intent.codeId ||
          !usable(row, deps.clock.now())
        )
          throw invalidCode(null);
        const used = await tx.smsVerification.updateMany({
          where: {
            id: row!.id,
            usedAt: null,
            attempts: { lt: 5 },
            expiresAt: { gt: deps.clock.now() },
          },
          data: { usedAt: deps.clock.now(), updatedAt: deps.clock.now() },
        });
        if (used.count !== 1) throw invalidCode(null);
        try {
          const result = await changePhoneIn(
            tx,
            deps,
            {
              merchantUserId: principal.merchantUserId,
              phone,
              keepSessionId: principal.sessionId,
              via: "self_service",
            },
            meta,
            planned?.id ?? null,
            changes,
          );
          notice = { phone: result.oldPhone, key: `phone_changed:${row!.id}` };
          return result.user;
        } catch (error) {
          if (isUniqueViolation(error, ["uq_merchant_user_phone_bidx"]))
            throw new AppError("PHONE_TAKEN");
          throw error;
        }
      },
    },
    options,
  );
  // 只保留内存中的旧号码；重放不重发，通知失败也不能回滚已完成的换绑。
  if (notice) {
    const value = notice as { phone: string; key: string };
    await deps
      .notify!.sendDirect({
        purpose: "account_notice",
        templateKey: "account_notice",
        phone: value.phone,
        params: {},
        directKey: value.key,
      })
      .catch(() => undefined);
  }
  return user;
}
