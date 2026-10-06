// 建档完整度的唯一口径（m03 2.1、04 分组；前三步 11 项，第四步 4 项与各项许可证）。
import { divRoundHalfUp } from "../pricing/round.js";

export const PROFILE_REQUIRED_ITEMS = {
  1: [
    "brand_name",
    "store_name",
    "industry",
    "address",
    "business_hours",
    "store_tel",
    "avg_spend",
  ],
  2: ["door_photos", "interior_photos"],
  3: ["service_items", "selling_points"],
  4: ["entity_type", "business_license", "contact", "declaration"],
} as const;
export type ProfileRequiredItem =
  (typeof PROFILE_REQUIRED_ITEMS)[keyof typeof PROFILE_REQUIRED_ITEMS][number] | "permit";
export interface ProfileCompletenessInput {
  readonly filled: Readonly<Partial<Record<Exclude<ProfileRequiredItem, "permit">, boolean>>>;
  readonly requiredPermits: readonly string[];
  readonly providedPermits: readonly string[];
}
export function profileCompleteness(input: ProfileCompletenessInput) {
  const steps = ([1, 2, 3, 4] as const).map((step) => {
    const missing: { item: ProfileRequiredItem; permitType: string | null }[] =
      PROFILE_REQUIRED_ITEMS[step]
        .filter((item) => !input.filled[item])
        .map((item) => ({ item, permitType: null }));
    const permits = step === 4 ? [...new Set(input.requiredPermits)] : [];
    missing.push(
      ...permits
        .filter((code) => !input.providedPermits.includes(code))
        .map((permitType) => ({ item: "permit" as const, permitType })),
    );
    const total = PROFILE_REQUIRED_ITEMS[step].length + permits.length;
    return {
      step,
      state:
        missing.length === 0
          ? ("completed" as const)
          : missing.length === total
            ? ("not_started" as const)
            : ("in_progress" as const),
      missing,
    };
  });
  const requiredTotal = 15 + new Set(input.requiredPermits).size;
  const requiredFilled = requiredTotal - steps.reduce((n, step) => n + step.missing.length, 0);
  return {
    pct: divRoundHalfUp([requiredFilled, 100], [requiredTotal]),
    requiredFilled,
    requiredTotal,
    steps,
  };
}
