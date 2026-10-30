import { createHash, randomInt } from "node:crypto";
import type { LicenseLetter, Prisma } from "@liyoxi/db";
import { AppError, createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import { recordLicenseRenderResult } from "./license-render-result.js";
import { record } from "../audit/index.js";
import type {
  LicenseAccountFact,
  LicenseConvergenceDeps,
  LicenseFacts,
  LicenseLetterSnapshot,
} from "./license-facts.js";
import { versionLabel } from "./versions.js";
import { parseLicenseLetterSnapshot } from "./license-facts.js";

const checked = Symbol("docs.license_facts_checked");
export const isLicenseFactsChecked = (args: unknown) => args === checked;
export const LICENSE_TEMPLATE_VERSION = "v1";
export const licenseEligible = (phase: string) =>
  ["producing", "to_launch", "live", "ended"].includes(phase);
const day = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
const code = () =>
  Array.from(
    { length: 16 },
    () => "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"[randomInt(62)],
  ).join("");
export const canonicalLicenseJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalLicenseJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new AppError("VALIDATION_FAILED", { message: "授权指纹只接受JSON值" });
    const entries = Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalLicenseJson(item)}`);
    return "{" + entries.join(",") + "}";
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return JSON.stringify(value);
  throw new AppError("VALIDATION_FAILED", { message: "授权指纹只接受JSON值" });
};
export const licenseContentFingerprint = (snapshot: LicenseLetterSnapshot) =>
  createHash("sha256")
    .update(canonicalLicenseJson(parseLicenseLetterSnapshot(snapshot)), "utf8")
    .digest("hex");

async function snapshot(
  tx: Tx,
  deps: LicenseConvergenceDeps,
  facts: LicenseFacts,
  account: LicenseAccountFact,
  letter: { letterNo: string; verifyCode: string },
  revNo: number,
  metadata?: Pick<LicenseLetterSnapshot, "issuedAt" | "verifyUrl">,
): Promise<LicenseLetterSnapshot> {
  const origin = deps.snapshot.portalOrigin;
  if (!origin) throw new AppError("PROVIDER_UNAVAILABLE", { message: "授权快照缺少验真地址配置" });
  const now = deps.clock.now();
  const licensor = await deps.snapshot.licensor(tx, now);
  const licensee = await deps.snapshot.licensee(tx, facts);
  const scope = await deps.snapshot.scope(tx, facts.dramaId, account.platform);
  const consent = await tx.agreementConsent.findUnique({
    where: { id: facts.consentId },
    include: { agreementVersion: { include: { agreement: true } } },
  });
  if (
    !consent ||
    consent.agreementKey !== "custom_license" ||
    consent.entityId !== facts.entityId ||
    consent.storeId !== facts.storeId ||
    consent.bizType !== "drama_order" ||
    consent.bizId !== facts.orderId ||
    consent.bizNo !== facts.orderNo ||
    consent.scene !== "order_submit" ||
    !consent.agreementVersion.effectiveAt ||
    consent.agreementVersion.effectiveAt > consent.consentedAt ||
    !["pending", "active", "superseded"].includes(consent.agreementVersion.status) ||
    consent.agreementVersion.contentSha256 !== consent.contentSha256
  )
    throw new AppError("PRECONDITION_CHANGED", { message: "授权快照缺少有效的历史交易同意" });
  const url = new URL("/v", origin);
  url.searchParams.set("code", letter.verifyCode);
  url.searchParams.set("rev", String(revNo));
  deps.assertOpen?.();
  return parseLicenseLetterSnapshot({
    licensor,
    licensee,
    drama: {
      name: scope.name,
      episodes: scope.episodes,
      permits: scope.permits.map((permit) => ({ ...permit })),
    },
    account: { platform: account.platform, name: account.name, accountId: account.accountNo },
    period: {
      start: facts.usageStartDate,
      startText: facts.usageStartDate ?? "自上线首日起",
      end: facts.usageEndDate,
      territory: scope.territory,
    },
    rightsClauseKey: "v1.rights",
    exclusiveClauseKey: "v1.exclusive",
    obligationClauseKey: "v1.offline",
    consent: {
      consentNo: String(consent.seq),
      agreement: `${consent.agreementVersion.agreement.name} ${versionLabel(consent.agreementVersion)}`,
      at: consent.consentedAt.toISOString(),
      by: `${consent.operatorNameMask ?? ""}（${consent.phoneMask}）`,
    },
    orderNo: facts.orderNo,
    letterNo: letter.letterNo,
    revNo,
    issuedAt: metadata?.issuedAt ?? now.toISOString(),
    verifyUrl: metadata?.verifyUrl ?? url.toString(),
  });
}

/** All callers share this batch writer. Acquire every item before any letter; no snapshot config is needed to void. */
export async function reconcileLetters(
  tx: Tx,
  deps: LicenseConvergenceDeps,
  orderItemIds: readonly string[],
  triggerRef: string,
) {
  deps.assertOpen?.();
  if (!triggerRef || triggerRef.length > 80) throw new AppError("VALIDATION_FAILED");
  const ids = [...new Set(orderItemIds.map((id) => id.toLowerCase()))].sort();
  if (!ids.length) return { created: 0, revised: 0, voided: 0, complete: true };
  const facts = await deps.facts.getLicenseFacts(tx, ids);
  if (facts.length !== ids.length) throw new AppError("NOT_FOUND");
  const first = await tx.licenseLetter.findMany({
    where: { orderItemId: { in: ids } },
    orderBy: { id: "asc" },
  });
  await lockRows(
    tx,
    "license_letter",
    first.map((letter) => letter.id),
  );
  const letters = await tx.licenseLetter.findMany({
    where: { orderItemId: { in: ids } },
    orderBy: { id: "asc" },
  });
  return reconcileLockedLetters(tx, deps, facts, letters, triggerRef);
}

async function reconcileLockedLetters(
  tx: Tx,
  deps: LicenseConvergenceDeps,
  facts: readonly LicenseFacts[],
  letters: LicenseLetter[],
  triggerRef: string,
) {
  deps.assertOpen?.();
  let created = 0,
    revised = 0,
    voided = 0;
  const now = deps.clock.now();
  const ctx = createIdentityContext({ actor: { type: "system", job: "docs.license_facts" } });
  for (const item of facts) {
    const wanted = licenseEligible(item.phase) ? item.accounts : [];
    const current = letters.filter(
      (letter) => letter.orderItemId === item.orderItemId && letter.status !== "voided",
    );
    for (const letter of current) {
      if (
        letter.entityId !== item.entityId ||
        letter.storeId !== item.storeId ||
        letter.dramaId !== item.dramaId ||
        letter.dramaOrderId !== item.orderId
      )
        throw new AppError("PRECONDITION_CHANGED", { message: "授权书归属与当前事实不一致" });
      if (wanted.some((account) => account.channelAccountId === letter.channelAccountId)) continue;
      const voidReason =
        item.phase === "terminated"
          ? "terminated"
          : licenseEligible(item.phase)
            ? "account_removed"
            : "cancelled";
      await deps.flow.transition(tx, ctx, {
        machine: "license_letter",
        stateField: "status",
        id: letter.id,
        event: "license_letter.void",
        to: "voided",
        ref: voidReason === "account_removed" ? "13:947" : "13:948",
        args: checked,
        entityId: item.entityId,
        storeId: item.storeId,
        set: { voided_at: now, void_reason: voidReason },
        emit: {
          type: "license_letter.voided",
          payload: { v: 1, licenseLetterId: letter.id, voidReason },
        },
      });
      await clearVoidedIssue(tx, ctx, letter);
      voided++;
    }
    for (const account of [...wanted].sort((a, b) =>
      a.channelAccountId.localeCompare(b.channelAccountId),
    )) {
      const old = current.find((letter) => letter.channelAccountId === account.channelAccountId);
      const status = item.usageStartDate ? "effective" : "pending_effective";
      if (
        old &&
        old.status === status &&
        day(old.periodStart) === item.usageStartDate &&
        day(old.periodEnd) === item.usageEndDate
      )
        continue;
      if (!["douyin", "wechat_channels"].includes(account.platform))
        throw new AppError("PRECONDITION_CHANGED");
      const count =
        letters.filter(
          (letter) =>
            letter.orderItemId === item.orderItemId && letter.platform === account.platform,
        ).length + 1;
      const numeric = /^(T)?LYX(\d+)$/.exec(item.orderNo);
      if (!numeric)
        throw new AppError("PRECONDITION_CHANGED", { message: "授权书编号缺少合法订单编号" });
      const letter = old ?? {
        id: uuidv7(),
        letterNo: `${numeric[1] ?? ""}SQ${numeric[2]}-${item.itemNo}-${account.platform === "douyin" ? "DY" : "SPH"}${count > 1 ? `-${count}` : ""}`,
        verifyCode: code(),
      };
      const previous = old
        ? await tx.licenseLetterRevision.aggregate({
            where: { licenseLetterId: old.id },
            _max: { revNo: true },
          })
        : null;
      const revNo = (previous?._max.revNo ?? 0) + 1;
      const reason = !old
        ? "initial"
        : old.periodStart === null && item.usageStartDate !== null
          ? "go_live"
          : "period_changed";
      const value = await snapshot(tx, deps, item, account, letter, revNo);
      const revisionId = uuidv7();
      if (!old) {
        const inserted = await tx.licenseLetter.create({
          data: {
            id: letter.id,
            letterNo: letter.letterNo,
            verifyCode: letter.verifyCode,
            dramaOrderId: item.orderId,
            orderItemId: item.orderItemId,
            channelAccountId: account.channelAccountId,
            entityId: item.entityId,
            storeId: item.storeId,
            dramaId: item.dramaId,
            platform: account.platform,
            status,
            periodStart: item.usageStartDate ? new Date(item.usageStartDate) : null,
            periodEnd: new Date(item.usageEndDate),
            createdAt: now,
            updatedAt: now,
          },
        });
        letters.push(inserted);
        await deps.flow.transition(tx, ctx, {
          machine: "license_letter",
          stateField: "status",
          id: letter.id,
          event: "license_letter.create",
          to: status,
          ref: "13:942",
          created: true,
          args: checked,
          entityId: item.entityId,
          storeId: item.storeId,
          emit: { none: true, primary: "license_letter.revision_queued" },
        });
        created++;
      } else if (old.status !== status) {
        await deps.flow.transition(tx, ctx, {
          machine: "license_letter",
          stateField: "status",
          id: old.id,
          event: status === "effective" ? "license_letter.go_live" : "license_letter.revoke_live",
          ref: status === "effective" ? "13:944" : "13:946",
          args: checked,
          entityId: item.entityId,
          storeId: item.storeId,
          set: {
            period_start: item.usageStartDate ? new Date(item.usageStartDate) : null,
            period_end: new Date(item.usageEndDate),
          },
          emit: { none: true, primary: "license_letter.revision_queued" },
        });
        revised++;
      } else {
        await tx.licenseLetter.update({
          where: { id: old.id },
          data: {
            periodStart: item.usageStartDate ? new Date(item.usageStartDate) : null,
            periodEnd: new Date(item.usageEndDate),
            lockVersion: { increment: 1 },
            updatedAt: now,
          },
        });
        await record(
          tx,
          ctx.actor,
          {
            requestId: ctx.requestId,
            ip: null,
            userAgent: null,
            authMethod: null,
            sessionId: null,
          },
          {
            stream: "activity",
            category: "docs",
            action: "docs.license.period_changed",
            summary: "更新授权使用期",
            target: { type: "license_letter", id: old.id },
            entityId: item.entityId,
            storeId: item.storeId,
          },
        );
        revised++;
      }
      await tx.licenseLetterRevision.create({
        data: {
          id: revisionId,
          licenseLetterId: letter.id,
          revNo,
          reason,
          triggerRef,
          letterSnapshot: JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue,
          contentFp: licenseContentFingerprint(value),
          templateVersion: LICENSE_TEMPLATE_VERSION,
          renderStatus: "queued",
          createdAt: now,
          updatedAt: now,
        },
      });
      await deps.events.emit(tx, ctx, {
        type: "license_letter.revision_queued",
        aggregate: { type: "license_letter", id: letter.id },
        payload: { v: 1, licenseLetterId: letter.id, revisionId, reason },
        entityId: item.entityId,
        storeId: item.storeId,
      });
    }
  }
  deps.assertOpen?.();
  return { created, revised, voided, complete: true };
}
export const ensureLetters = reconcileLetters;


async function clearVoidedIssue(tx: Tx, ctx: IdentityContext, letter: LicenseLetter) {
  const latest = await tx.licenseLetterRevision.findFirst({
    where: { licenseLetterId: letter.id }, orderBy: { revNo: "desc" },
  });
  if (latest) await recordLicenseRenderResult(tx, ctx, {
    licenseLetterId: letter.id, revisionId: latest.id,
    entityId: letter.entityId, storeId: letter.storeId,
    fence: { attempt: latest.renderAttemptNo, leaseUntil: latest.renderLeaseUntil }, outcome: "voided",
  });
}

/** Reads before locks are references only; all item/letter facts are reread under the shared lock order. */
async function lockManualLetter(tx: Tx, deps: LicenseConvergenceDeps, id: string) {
  deps.assertOpen?.();
  const ref = await tx.licenseLetter.findUnique({ where: { id } });
  if (!ref) throw new AppError("NOT_FOUND");
  const facts = await deps.facts.getLicenseFacts(tx, [ref.orderItemId]);
  const keys = await tx.licenseLetter.findMany({
    where: { orderItemId: ref.orderItemId }, orderBy: { id: "asc" }, select: { id: true },
  });
  await lockRows(tx, "license_letter", keys.map((row) => row.id));
  const letters = await tx.licenseLetter.findMany({
    where: { orderItemId: ref.orderItemId }, orderBy: { id: "asc" },
  });
  const letter = letters.find((row) => row.id === id), fact = facts[0];
  if (!letter || !fact) throw new AppError("NOT_FOUND");
  deps.assertOpen?.();
  if (letter.status === "voided") throw new AppError("STATE_NOT_ALLOWED");
  return { letter, fact, letters, facts };
}

export function licenseLetterMatchesFacts(letter: LicenseLetter, fact: LicenseFacts): boolean {
  return licenseEligible(fact.phase) &&
    fact.accounts.some((account) => account.channelAccountId === letter.channelAccountId && account.platform === letter.platform) &&
    letter.entityId === fact.entityId && letter.storeId === fact.storeId &&
    letter.dramaId === fact.dramaId && letter.dramaOrderId === fact.orderId &&
    letter.status === (fact.usageStartDate ? "effective" : "pending_effective") &&
    day(letter.periodStart) === fact.usageStartDate && day(letter.periodEnd) === fact.usageEndDate;
}

const manualNote = (note: string) => {
  if (!note.trim() || Array.from(note).length > 200) throw new AppError("VALIDATION_FAILED");
};
export async function correctLicenseLetter(
  tx: Tx, deps: LicenseConvergenceDeps, ctx: IdentityContext,
  input: {
    licenseLetterId: string;
    correctionKinds: readonly ("licensee_name" | "store_name" | "account_name" | "other")[];
    note: string;
  },
) {
  manualNote(input.note);
  if (!input.correctionKinds.length || input.correctionKinds.some((kind) =>
    !["licensee_name", "store_name", "account_name", "other"].includes(kind)))
    throw new AppError("VALIDATION_FAILED");
  const { letter, fact } = await lockManualLetter(tx, deps, input.licenseLetterId);
  if (!licenseLetterMatchesFacts(letter, fact))
    throw new AppError("PRECONDITION_CHANGED", { message: "授权法律事实已变化，请先对齐当前授权" });
  const latest = await tx.licenseLetterRevision.findFirst({
    where: { licenseLetterId: letter.id }, orderBy: { revNo: "desc" },
  });
  if (!latest) throw new AppError("PRECONDITION_CHANGED");
  const old = parseLicenseLetterSnapshot(latest.letterSnapshot);
  const account = fact.accounts.find((row) => row.channelAccountId === letter.channelAccountId)!;
  // Metadata belongs to a revision. Preserve it for comparison before deciding there is a business change.
  const comparison = await snapshot(tx, deps, fact, account, letter, latest.revNo, old);
  if (licenseContentFingerprint(comparison) === latest.contentFp)
    throw new AppError("LICENSE_LETTER_UNCHANGED");
  const revNo = latest.revNo + 1, revisionId = uuidv7(), now = deps.clock.now();
  const verifyUrl = new URL(comparison.verifyUrl);
  verifyUrl.searchParams.set("rev", String(revNo));
  const value = parseLicenseLetterSnapshot({ ...comparison, revNo, issuedAt: now.toISOString(), verifyUrl: verifyUrl.toString() });
  await tx.licenseLetterRevision.create({ data: {
    id: revisionId, licenseLetterId: letter.id, revNo, reason: "correction",
    triggerRef: `guard-${ctx.requestId ?? revisionId}`.slice(0, 80),
    letterSnapshot: JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue,
    contentFp: licenseContentFingerprint(value), templateVersion: LICENSE_TEMPLATE_VERSION,
    renderStatus: "queued", createdAt: now, updatedAt: now,
  } });
  await record(tx, ctx.actor, { requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
    authMethod: null, sessionId: null }, {
    stream: "ops", category: "docs", action: "docs.license.correct", summary: "更正并重出授权书",
    target: { type: "license_letter", id: letter.id }, entityId: letter.entityId, storeId: letter.storeId,
    reason: { code: "correction", text: input.note }, meta: { correctionKinds: [...input.correctionKinds], revisionId },
  });
  await deps.events.emit(tx, ctx, {
    type: "license_letter.revision_queued", aggregate: { type: "license_letter", id: letter.id },
    payload: { v: 1, licenseLetterId: letter.id, revisionId, reason: "correction" },
    entityId: letter.entityId, storeId: letter.storeId,
  });
  deps.assertOpen?.();
  return { licenseLetterId: letter.id, revisionId, revNo };
}

export async function voidLicenseLetter(
  tx: Tx, deps: LicenseConvergenceDeps, ctx: IdentityContext,
  input: { licenseLetterId: string; note: string },
) {
  manualNote(input.note);
  const { letter, facts, letters } = await lockManualLetter(tx, deps, input.licenseLetterId);
  await deps.flow.transition(tx, ctx, {
    machine: "license_letter", stateField: "status", id: letter.id, event: "license_letter.void",
    to: "voided", ref: "13:949", args: checked, entityId: letter.entityId, storeId: letter.storeId,
    set: { voided_at: deps.clock.now(), void_reason: "manual" },
    emit: { type: "license_letter.voided", payload: { v: 1, licenseLetterId: letter.id, voidReason: "manual" } },
  });
  await clearVoidedIssue(tx, ctx, letter);
  await record(tx, ctx.actor, { requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
    authMethod: null, sessionId: null }, {
    stream: "ops", category: "docs", action: "docs.license.void", summary: "作废并重出授权书",
    target: { type: "license_letter", id: letter.id }, entityId: letter.entityId, storeId: letter.storeId,
    reason: { code: "manual", text: input.note },
  });
  const current = letters.map((row) => row.id === letter.id ? { ...row, status: "voided" } : row);
  await reconcileLockedLetters(tx, deps, facts, current, `guard-${ctx.requestId ?? uuidv7()}`.slice(0, 80));
  const replacement = current.find((row) => row.channelAccountId === letter.channelAccountId && row.status !== "voided");
  return { licenseLetterId: letter.id, reissuedLicenseLetterId: replacement?.id ?? null };
}
