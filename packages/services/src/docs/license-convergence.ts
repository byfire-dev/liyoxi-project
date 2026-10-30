import { createHash, randomInt } from "node:crypto";
import type { Prisma } from "@liyoxi/db";
import { AppError, createIdentityContext, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
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
    issuedAt: now.toISOString(),
    verifyUrl: url.toString(),
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
