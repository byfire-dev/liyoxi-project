import type { IdentityContext, Tx } from "../kernel/index.js";
import { record } from "../audit/index.js";

/** Fixed snapshot field paths, never source text, keep diagnostics useful without persisting names. */
export const LICENSE_GLYPH_FIELDS = [
  "licensor.name", "licensor.creditCode", "licensee.name", "licensee.creditCode", "licensee.store",
  "drama.name", "drama.permits.kind", "drama.permits.number", "drama.permits.platform",
  "account.platform", "account.name", "account.accountId", "period.startText", "period.end",
  "period.territory", "consent.consentNo", "consent.agreement", "consent.at", "consent.by",
  "orderNo", "letterNo", "issuedAt", "template", "period.start", "verifyUrl", "revNo", "drama.episodes",
] as const;
export interface LicenseRenderIssue {
  readonly kind: "missing_glyph";
  readonly missing: readonly {
    readonly character: string;
    readonly codePoint: string;
    readonly fields: readonly string[];
  }[];
  readonly totalMissingCodePoints: number;
  readonly truncated: boolean;
}
export interface LicenseRenderFence {
  readonly attempt: number;
  readonly leaseUntil: Date | null;
}
export type LicenseRenderOutcome = "started" | "failed" | "ready" | "rerender" | "voided";

/** Bound before audit.record's generic 16KiB cap; never let a digest pretend to be a complete issue. */
export function boundedLicenseRenderIssue(issue: LicenseRenderIssue): LicenseRenderIssue {
  const distinct = new Map<string, { character: string; codePoint: string; fields: string[] }>();
  for (const item of issue.missing) {
    const chars = Array.from(item.character);
    if (chars.length !== 1) continue;
    const point = chars[0]!.codePointAt(0)!;
    if (point === 0 || (point >= 0xd800 && point <= 0xdfff)) continue;
    const codePoint = `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
    const previous = distinct.get(codePoint);
    const fields = [...new Set([
      ...(previous?.fields ?? []),
      ...item.fields.filter((field) => (LICENSE_GLYPH_FIELDS as readonly string[]).includes(field)),
    ])].slice(0, 4);
    distinct.set(codePoint, { character: chars[0]!, codePoint, fields });
  }
  const total = Math.max(distinct.size, Number.isSafeInteger(issue.totalMissingCodePoints)
    ? issue.totalMissingCodePoints : 0);
  const missing = [...distinct.values()].slice(0, 32);
  const value: LicenseRenderIssue = {
    kind: "missing_glyph", missing, totalMissingCodePoints: total,
    truncated: issue.truncated || total > missing.length,
  };
  while (Buffer.byteLength(JSON.stringify(value), "utf8") > 7 * 1024 && missing.length) {
    missing.pop();
    (value as { truncated: boolean }).truncated = true;
  }
  return value;
}

export async function recordLicenseRenderResult(
  tx: Tx,
  ctx: IdentityContext,
  input: {
    licenseLetterId: string;
    revisionId: string;
    entityId: string;
    storeId: string;
    fence: LicenseRenderFence;
    outcome: LicenseRenderOutcome;
    issue?: LicenseRenderIssue;
  },
) {
  const meta = {
    v: 1, revisionId: input.revisionId,
    claim: { attempt: input.fence.attempt, leaseUntil: input.fence.leaseUntil?.toISOString() ?? null },
    outcome: input.outcome,
    issue: input.issue ? boundedLicenseRenderIssue(input.issue) : null,
  };
  if (Buffer.byteLength(JSON.stringify(meta), "utf8") > 8 * 1024)
    throw new TypeError("授权渲染诊断超过持久化上限");
  await record(tx, ctx.actor, {
    requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent,
    authMethod: null, sessionId: null,
  }, {
    stream: "ops", category: "docs", action: "docs.license.render_result",
    summary: input.issue ? "授权书缺字，修正资料或字体后重试" : "更新授权书渲染结果",
    target: { type: "license_letter", id: input.licenseLetterId },
    entityId: input.entityId, storeId: input.storeId, meta,
  });
}
