import type { QualificationSubmission } from "@liyoxi/db";
import type { StoreProfileBasicPatch } from "@liyoxi/contract";
import { dictRef } from "./repo.js";
import type { ProfileSnapshot } from "./repo.js";
import type { Tx } from "../kernel/index.js";

export type RoundAddress = {
  provinceCode: string | null;
  cityCode: string | null;
  districtCode: string | null;
  detail: string | null;
  poiName: string | null;
  latitude: number | null;
  longitude: number | null;
};
export function roundBasics(
  s: Pick<ProfileSnapshot, "store" | "profile">,
  round: QualificationSubmission | null = null,
) {
  const p = s.profile;
  return {
    storeName: round?.proposedStoreName ?? s.store.name,
    industryCode: round?.proposedIndustryCode ?? p?.industryCode ?? null,
    categoryCode: round?.proposedCategoryCode ?? p?.categoryCode ?? null,
    address: (round?.proposedAddressSnapshot as RoundAddress | null) ?? {
      provinceCode: p?.provinceCode ?? null,
      cityCode: p?.cityCode ?? null,
      districtCode: p?.districtCode ?? null,
      detail: p?.addressDetail ?? null,
      poiName: p?.poiName ?? null,
      latitude: p?.latitude?.toNumber() ?? null,
      longitude: p?.longitude?.toNumber() ?? null,
    },
  };
}
const addressKeys = ["provinceCode", "cityCode", "districtCode", "detail"] as const;
export function reviewFields(s: ProfileSnapshot, input: StoreProfileBasicPatch): string[] {
  const live = roundBasics(s),
    fields = [];
  if (input.storeName !== undefined && input.storeName !== live.storeName)
    fields.push("store_name");
  if (
    input.industryCode !== undefined &&
    (input.industryCode !== live.industryCode || input.categoryCode !== live.categoryCode)
  )
    fields.push("industry");
  if (
    input.address !== undefined &&
    addressKeys.some((key) => (input.address?.[key] ?? null) !== live.address[key])
  )
    fields.push("address");
  return fields;
}
export function changedBasics(s: ProfileSnapshot, round: QualificationSubmission): string[] {
  const value = roundBasics(s, round);
  return reviewFields(s, {
    draft: true,
    lockVersion: 0,
    storeName: value.storeName,
    industryCode: value.industryCode,
    categoryCode: value.categoryCode,
    address: { ...value.address, zoneCode: s.profile?.zoneCode ?? null },
  });
}
export async function pendingView(tx: Tx, round: QualificationSubmission | null) {
  if (!round || round.kind !== "change") return null;
  const a = round.proposedAddressSnapshot as RoundAddress | null;
  return {
    qualificationSubmissionId: round.id,
    phase: round.closedAt ? "closed" : round.submittedAt ? "in_review" : "draft",
    storeName: round.proposedStoreName,
    industry: await dictRef(tx, "industry", round.proposedIndustryCode),
    category: await dictRef(tx, "industry", round.proposedCategoryCode),
    address: a
      ? {
          province: await dictRef(tx, "region", a.provinceCode),
          city: await dictRef(tx, "region", a.cityCode),
          district: await dictRef(tx, "region", a.districtCode),
          detail: a.detail,
          poiName: a.poiName ?? null,
          latitude: a.latitude ?? null,
          longitude: a.longitude ?? null,
        }
      : null,
    lockVersion: round.lockVersion,
  };
}
