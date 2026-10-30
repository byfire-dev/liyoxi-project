import type { Tx } from "../kernel/index.js";
import { z } from "zod";

const scalar = z.string().refine((s) => [...s].length === 1 && !/[\uD800-\uDFFF]/u.test(s));
const field = z.enum([
  "template",
  "licensor.name",
  "licensor.creditCode",
  "licensee.name",
  "licensee.creditCode",
  "licensee.store",
  "drama.name",
  "drama.episodes",
  "drama.permits.kind",
  "drama.permits.number",
  "drama.permits.platform",
  "account.platform",
  "account.name",
  "account.accountId",
  "period.start",
  "period.startText",
  "period.end",
  "period.territory",
  "orderNo",
  "letterNo",
  "revNo",
  "issuedAt",
  "verifyUrl",
  "consent.consentNo",
  "consent.agreement",
  "consent.at",
  "consent.by",
]);
const issueSchema = z
  .strictObject({
    kind: z.literal("missing_glyph"),
    missing: z
      .array(
        z.strictObject({
          character: scalar,
          codePoint: z.string().regex(/^U\+[0-9A-F]{4,6}$/),
          fields: z.array(field).min(1).max(4),
        }),
      )
      .min(1)
      .max(32),
    totalMissingCodePoints: z.number().int().positive(),
    truncated: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (
      v.missing.some(
        (x) =>
          `U+${x.character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` !==
          x.codePoint,
      ) ||
      v.totalMissingCodePoints < v.missing.length
    )
      ctx.addIssue({ code: "custom", message: "缺字码点不一致" });
  });
const resultSchema = z.strictObject({
  v: z.literal(1),
  revisionId: z.string().uuid(),
  claim: z.strictObject({
    attempt: z.number().int().nonnegative(),
    leaseUntil: z.iso.datetime().nullable(),
  }),
  outcome: z.enum(["started", "failed", "ready", "rerender", "voided"]),
  issue: issueSchema.nullable(),
});
export type LicenseRenderIssue = z.infer<typeof issueSchema>;
export type LicenseRenderResult = z.infer<typeof resultSchema>;

/** Caller must establish domain visibility first. Never returns generic audit metadata. */
export async function readLicenseRenderResults(
  tx: Tx,
  input: {
    letterId: string;
    entityId: string;
    storeId: string;
    revisionIds: readonly string[];
  },
): Promise<ReadonlyMap<string, LicenseRenderResult | null>> {
  const ids = new Set(input.revisionIds);
  if (!ids.size) return new Map();
  const rows = await tx.auditLog.findMany({
    where: {
      stream: "ops",
      category: "docs",
      action: "docs.license.render_result",
      targetType: "license_letter",
      targetId: input.letterId,
      entityId: input.entityId,
      storeId: input.storeId,
    },
    orderBy: { seq: "desc" },
    select: { meta: true },
  });
  const results = new Map<string, LicenseRenderResult | null>();
  for (const row of rows) {
    const raw = row.meta;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const id = raw["revisionId"];
    if (typeof id !== "string" || !ids.has(id) || results.has(id)) continue;
    // A malformed latest row must not revive an older diagnostic.
    const result =
      Buffer.byteLength(JSON.stringify(raw), "utf8") <= 8192 ? resultSchema.safeParse(raw) : null;
    results.set(id, result?.success ? result.data : null);
  }
  return results;
}

/** Last actual claim survives reset-to-queued; used by the owner to avoid lease ABA with a frozen clock. */
export async function latestLicenseRenderClaimLease(
  tx: Tx,
  input: {
    licenseLetterId: string;
    revisionId: string;
    entityId: string;
    storeId: string;
  },
): Promise<Date | null> {
  const row = await tx.auditLog.findFirst({
    where: {
      stream: "ops",
      category: "docs",
      action: "docs.license.render_result",
      targetType: "license_letter",
      targetId: input.licenseLetterId,
      entityId: input.entityId,
      storeId: input.storeId,
      AND: [
        { meta: { path: ["revisionId"], equals: input.revisionId } },
        { meta: { path: ["outcome"], equals: "started" } },
      ],
    },
    orderBy: { seq: "desc" },
    select: { meta: true },
  });
  if (!row) return null;
  const parsed = resultSchema.safeParse(row.meta);
  if (
    !parsed.success ||
    parsed.data.revisionId !== input.revisionId ||
    parsed.data.outcome !== "started" ||
    !parsed.data.claim.leaseUntil
  )
    throw new TypeError("授权渲染认领审计不可用");
  return new Date(parsed.data.claim.leaseUntil);
}
