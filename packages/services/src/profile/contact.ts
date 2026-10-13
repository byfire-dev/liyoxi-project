import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { ContactPatch } from "@liyoxi/contract";
import { AppError, createThreePhaseRunner, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { blindIndex, decryptField } from "../security/index.js";
import type { ProfileDeps, ProfileViewer, WriteOptions } from "./context.js";
import { assertOwner, assertVersion, checkContent } from "./validate.js";
import { snapshot } from "./repo.js";
import { contactView } from "./views.js";
import { saveContact } from "./write.js";

const hash = (code: string) => createHash("sha256").update(code).digest();
const invalid = (attemptsLeft = 0) =>
  new AppError("SMS_CODE_INVALID", { details: { attemptsLeft } });
export async function authorizeContact(tx: Tx, deps: ProfileDeps, viewer: ProfileViewer) {
  assertOwner(viewer);
  await deps.contactSms?.assertSession(tx, viewer.principal, deps.clock.now());
  const member = await deps.tenant.resolveMembership(tx, {
    merchantUserId: viewer.principal.merchantUserId,
    storeId: viewer.membership.storeId,
  });
  if (
    !member ||
    member.entityId !== viewer.membership.entityId ||
    member.memberId !== viewer.membership.memberId
  )
    throw new AppError("NOT_A_MEMBER");
  assertOwner({ ...viewer, membership: member });
  const user = await tx.merchantUser.findUniqueOrThrow({
    where: { id: viewer.principal.merchantUserId },
  });
  if (user.status !== "active" || !user.phoneEnc) throw new AppError("SESSION_INVALID");
  return decryptField(deps.keyring(), "merchant_user.phone_enc", user.phoneEnc);
}
export async function contactAvailable(tx: Tx, deps: ProfileDeps) {
  return deps.contactSms ? deps.contactSms.available(tx) : false;
}
async function lockContact(tx: Tx, deps: ProfileDeps, viewer: ProfileViewer) {
  await lockRows(tx, "merchant_user", [viewer.principal.merchantUserId]);
  await lockRows(tx, "entity", [viewer.membership.entityId], "share");
  await lockRows(tx, "entity_member", [viewer.membership.memberId], "share");
  await lockRows(tx, "store", [viewer.membership.storeId]);
  return authorizeContact(tx, deps, viewer);
}
const phoneIndex = (deps: ProfileDeps, phone: string) =>
  new Uint8Array(blindIndex(deps.keyring(), "phone", phone));
async function latest(tx: Tx, deps: ProfileDeps, viewer: ProfileViewer, phone: string) {
  return tx.smsVerification.findFirst({
    where: {
      purpose: "contact_phone",
      merchantUserId: viewer.principal.merchantUserId,
      phoneBidx: phoneIndex(deps, phone),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}
const usable = (row: Awaited<ReturnType<typeof latest>>, at: Date) =>
  !!row && !row.usedAt && row.expiresAt > at && row.attempts < 5;
export function createContactCode(
  deps: ProfileDeps,
  viewer: ProfileViewer,
  phone: string,
  options: WriteOptions = {},
) {
  if (!/^1\d{10}$/.test(phone)) throw new AppError("VALIDATION_FAILED");
  return createThreePhaseRunner(deps).run(
    {
      claim: async (tx) => {
        const login = await lockContact(tx, deps, viewer);
        if (phone === login) return { id: null, code: null, expiresAt: null };
        if (!(await contactAvailable(tx, deps))) throw new AppError("SMS_UNAVAILABLE");
        const id = uuidv7(),
          code = String(randomInt(1_000_000)).padStart(6, "0");
        const now = deps.clock.now(),
          expiresAt = new Date(now.getTime() + 300_000);
        await tx.smsVerification.create({
          data: {
            id,
            purpose: "contact_phone",
            merchantUserId: viewer.principal.merchantUserId,
            phoneBidx: phoneIndex(deps, phone),
            codeHash: hash(code),
            expiresAt,
            attempts: 0,
            createdAt: now,
            updatedAt: now,
          },
        });
        return { id, code, expiresAt: expiresAt.toISOString() };
      },
      external: async (intent) => {
        if (!intent.id) return;
        try {
          const result = await deps.contactSms!.send(
            phone,
            intent.code!,
            `sms_verification:${intent.id}`,
          );
          if (result.status !== "sent") throw new AppError("SMS_UNAVAILABLE");
        } catch (error) {
          if (error instanceof AppError && error.error === "RATE_LIMITED") throw error;
          throw new AppError("SMS_UNAVAILABLE");
        }
      },
      settle: async (tx, _result, intent) => {
        const login = await lockContact(tx, deps, viewer);
        if (!intent.id && phone !== login) throw new AppError("PRECONDITION_CHANGED");
        return {
          isLoginPhone: !intent.id,
          expiresAt: intent.expiresAt,
          resendAfterSec: intent.id ? 60 : null,
        };
      },
      compensate: async (tx, intent) => {
        if (intent.id) await tx.smsVerification.deleteMany({ where: { id: intent.id } });
      },
    },
    options,
  );
}
export function updateContact(
  deps: ProfileDeps,
  viewer: ProfileViewer,
  input: ContactPatch,
  options: WriteOptions = {},
) {
  assertOwner(viewer);
  return createThreePhaseRunner(deps).run(
    {
      claim: async (tx) => {
        await authorizeContact(tx, deps, viewer);
        const s = await snapshot(tx, viewer.membership.storeId);
        if (s.store.lifecycle !== "active" || s.store.entity.lifecycle !== "active")
          throw new AppError("STORE_ARCHIVED");
        assertVersion(s.profile?.lockVersion ?? 0, input.lockVersion);
      },
      external: async () => {
        await checkContent(deps, viewer, { name: input.name });
        const checked = await deps.tx.run(async (tx) => {
          const login = await lockContact(tx, deps, viewer),
            phone = input.phoneSource === "login" ? login : input.phone!;
          if (phone === login || !(await contactAvailable(tx, deps))) return { codeId: null };
          if (!input.smsCode) throw new AppError("VALIDATION_FAILED");
          const row = await latest(tx, deps, viewer, phone),
            now = deps.clock.now();
          if (!usable(row, now)) return { error: 0 };
          if (!timingSafeEqual(hash(input.smsCode), Buffer.from(row!.codeHash))) {
            const attempts = row!.attempts + 1;
            await tx.smsVerification.update({
              where: { id: row!.id },
              data: { attempts, updatedAt: now },
            });
            return { error: 5 - attempts };
          }
          return { codeId: row!.id };
        });
        if ("error" in checked) throw invalid(checked.error);
        return checked;
      },
      settle: async (tx, checked) => {
        const login = await lockContact(tx, deps, viewer),
          phone = input.phoneSource === "login" ? login : input.phone!;
        let verified = false;
        if (phone !== login && (await contactAvailable(tx, deps))) {
          const row = await latest(tx, deps, viewer, phone);
          if (
            !checked.codeId ||
            row?.id !== checked.codeId ||
            !usable(row, deps.clock.now()) ||
            !timingSafeEqual(hash(input.smsCode ?? ""), Buffer.from(row!.codeHash))
          )
            throw invalid();
          await tx.smsVerification.update({
            where: { id: row!.id },
            data: { usedAt: deps.clock.now(), updatedAt: deps.clock.now() },
          });
          verified = true;
        }
        return contactView(
          tx,
          await saveContact(tx, deps, viewer, input, verified),
          viewer.principal.merchantUserId,
          await contactAvailable(tx, deps),
        );
      },
    },
    options,
  );
}
