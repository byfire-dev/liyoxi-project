// 商城与订购共用的日历谓词（D8 5.1）。只用北京时间日期，不取系统时钟。
import { daysInMonth, formatLocalDate, parseLocalDate } from "../time/index.js";

export function stopDate(licenseEndDate: string, minLicenseMonths: number): string {
  if (!Number.isInteger(minLicenseMonths) || minLicenseMonths < 0)
    throw new RangeError("最短可订月数必须是非负整数");
  const { year, month, day } = parseLocalDate(licenseEndDate);
  const index = year * 12 + month - 1 - minLicenseMonths;
  const y = Math.floor(index / 12),
    m = index - y * 12 + 1;
  return formatLocalDate(y, m, Math.min(day, daysInMonth(y, m)));
}
export interface VisibilityFacts {
  readonly status: string;
  readonly archivedAt?: Date | null;
  readonly licenseEndDate: string | null;
  readonly minLicenseMonths: number;
}
export function visible(facts: VisibilityFacts, today: string): boolean {
  parseLocalDate(today);
  return (
    facts.status === "listed" &&
    !facts.archivedAt &&
    facts.licenseEndDate !== null &&
    today < stopDate(facts.licenseEndDate, facts.minLicenseMonths)
  );
}
export interface PermitRow {
  readonly platform: string;
  readonly kind: string;
  readonly number: string;
  readonly status?: string;
}
/** 每种编号优先具体平台，再用 all；调用方取多个平台结果时去重。 */
export function selectPermits<T extends PermitRow>(rows: readonly T[], platform: string): T[] {
  const active = rows.filter((row) => row.status === undefined || row.status === "active");
  return [...new Set(active.map((row) => row.kind))].flatMap((kind) => {
    const row =
      active.find((item) => item.kind === kind && item.platform === platform) ??
      active.find((item) => item.kind === kind && item.platform === "all");
    return row ? [row] : [];
  });
}
export function permitCovers(
  rows: readonly PermitRow[],
  platform: string,
  dramaClass: string | null,
): boolean {
  const kinds = selectPermits(rows, platform).map((row) => row.kind);
  return dramaClass === "class_3"
    ? kinds.includes("program_no")
    : (dramaClass === "class_1" || dramaClass === "class_2") &&
        (kinds.includes("license_no") || kinds.includes("approval_no"));
}
export function orderable(
  facts: VisibilityFacts & {
    readonly platforms: readonly string[];
    readonly permits: readonly PermitRow[];
    readonly dramaClass: string | null;
    readonly permitCheck: "block" | "warn" | "off";
  },
  selected: readonly string[],
  today: string,
): boolean {
  return (
    visible(facts, today) &&
    selected.length > 0 &&
    selected.every(
      (platform) =>
        facts.platforms.includes(platform) &&
        (facts.permitCheck !== "block" || permitCovers(facts.permits, platform, facts.dramaClass)),
    )
  );
}
