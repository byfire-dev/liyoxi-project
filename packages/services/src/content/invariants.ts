import { calendarDate } from "@liyoxi/shared/time";
import { paramsAt } from "../config/index.js";
import type { InvariantRegistration, InvariantViolation, Tx } from "../kernel/index.js";
import { boundContentPrices } from "./binding.js";
import { listingChecks, dateOf } from "./checks.js";
const violation = (id: string, detail: Record<string, unknown>): InvariantViolation => ({
  subject: { type: "drama", id },
  detail,
});
export async function findContentViolations(
  tx: Tx,
  code: string,
  at: Date,
): Promise<InvariantViolation[]> {
  const rows = await tx.drama.findMany({
      include: { dramaCopyrights: true, dramaEpisodes: { orderBy: { episodeNo: "asc" } } },
    }),
    result: InvariantViolation[] = [];
  const slots = (await paramsAt(tx, ["content.placement.open_slots"], at))[
    "content.placement.open_slots"
  ];
  const allCodes = new Set(
    (await tx.dictItem.findMany({ select: { dictTypeKey: true, code: true } })).map(
      (row) => `${row.dictTypeKey}/${row.code}`,
    ),
  );
  for (const row of rows) {
    if (code === "I1" && row.status === "listed") {
      const checks = await listingChecks(tx, row.id, at, boundContentPrices());
      if (!checks.isShelvable)
        result.push(
          violation(row.id, {
            failed: checks.items
              .filter((item) => !item.isOk && item.severity === "block")
              .map((item) => item.code),
          }),
        );
    }
    if (
      code === "I2" &&
      row.status === "listed" &&
      (!row.dramaCopyrights[0]?.licenseEndDate ||
        calendarDate(at) > dateOf(row.dramaCopyrights[0].licenseEndDate)!)
    )
      result.push(
        violation(row.id, {
          licenseEndDate: dateOf(row.dramaCopyrights[0]?.licenseEndDate ?? null),
        }),
      );
    if (code === "I4" && row.firstListedAt) {
      const c = row.dramaCopyrights[0],
        latest = await tx.dramaCopyrightRevision.findFirst({
          where: { dramaId: row.id },
          orderBy: { seq: "desc" },
        });
      const snapshot = c
        ? {
            source: c.source,
            platforms: c.platforms,
            territory: c.territory,
            hasNetworkRight: c.hasNetworkRight,
            canSublicense: c.canSublicense,
            canEditEmbed: c.canEditEmbed,
            canAdapt: c.canAdapt,
            licenseStartDate: dateOf(c.licenseStartDate),
            licenseEndDate: dateOf(c.licenseEndDate),
            proofFileIds: c.proofFileIds,
          }
        : null;
      // jsonb 属性顺序不影响比较；数组顺序仍是快照的一部分。
      const canonical = (value: unknown): string =>
        JSON.stringify(
          value,
          value && typeof value === "object" && !Array.isArray(value)
            ? Object.keys(value).sort()
            : undefined,
        );
      if (
        !c ||
        !latest ||
        c.currentDramaCopyrightRevisionId !== latest.id ||
        canonical(snapshot) !== canonical(latest.copyrightSnapshot)
      )
        result.push(violation(row.id, { reason: "current_revision_mismatch" }));
    }
    if (
      code === "I5" &&
      (row.dramaEpisodes.length !== (row.totalEpisodes ?? 0) ||
        row.dramaEpisodes.some((episode, index) => episode.episodeNo !== index + 1))
    )
      result.push(
        violation(row.id, {
          totalEpisodes: row.totalEpisodes,
          episodeNos: row.dramaEpisodes.map((item) => item.episodeNo),
        }),
      );
    if (
      code === "I6" &&
      row.allowedPlacements.some(
        (slot) =>
          !(slots as readonly string[]).includes(slot) ||
          ((row.dramaClass === "class_1" || row.dramaClass === "class_2") &&
            !["opening", "ending"].includes(slot)),
      )
    )
      result.push(violation(row.id, { allowedPlacements: row.allowedPlacements }));
    if (code === "I7") {
      const missing = [
        ...row.genreCodes.map((value) => `genre/${value}`),
        ...row.sellingTagCodes.map((value) => `selling_tag/${value}`),
        ...row.industryCodes.map((value) => `industry/${value}`),
      ].filter((value) => !allCodes.has(value));
      if (missing.length) result.push(violation(row.id, { missing }));
    }
  }
  return result;
}
export const contentInvariants: readonly InvariantRegistration[] = [
  "I1",
  "I2",
  "I4",
  "I5",
  "I6",
  "I7",
].map((code) => ({
  code: `content.${code}`,
  severity: "P2",
  modes: ["full"],
  heal: "none",
  run: async (tx, _scope, ctx) => {
    if (!ctx) throw new Error("content 不变量缺少运行时间");
    return findContentViolations(tx, code, ctx.now);
  },
}));
