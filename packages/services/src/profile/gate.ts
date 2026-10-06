import { IndustryExtSchema, RegionExtSchema } from "@liyoxi/contract";
import { AppError } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { snapshot, storeOf } from "./repo.js";

export type StoreGate = "full" | "parallel" | "blocked";
export async function storeGate(tx: Tx, storeId: string): Promise<StoreGate> {
  const store = await storeOf(tx, storeId);
  if (store.lifecycle !== "active" || store.entity.lifecycle !== "active") return "blocked";
  if (store.qualificationStatus === "verified") return "full";
  return store.isPrimary && store.qualificationStatus === "pending" ? "parallel" : "blocked";
}
export async function assertProfileComplete(tx: Tx, storeId: string) {
  const s = await snapshot(tx, storeId);
  const missing = s.completeness.steps
    .slice(0, 3)
    .flatMap((step) => step.missing.map((item) => ({ step: step.step, ...item })));
  if (missing.length) throw new AppError("STORE_PROFILE_INCOMPLETE", { details: { missing } });
}
export async function industryOpen(tx: Tx, storeId: string): Promise<boolean> {
  const p = await tx.storeProfile.findUnique({ where: { storeId } });
  if (!p) return false;
  for (const code of [p.industryCode, p.categoryCode]) {
    if (!code) return false;
    const row = await tx.dictItem.findUnique({
      where: { dictTypeKey_code: { dictTypeKey: "industry", code } },
    });
    if (!row || !IndustryExtSchema.parse(row.ext).open) return false;
  }
  for (const code of [
    p.provinceCode,
    p.cityCode,
    p.districtCode,
    ...(p.zoneCode ? [p.zoneCode] : []),
  ]) {
    if (!code) return false;
    const row = await tx.dictItem.findUnique({
      where: { dictTypeKey_code: { dictTypeKey: "region", code } },
    });
    if (!row || !RegionExtSchema.parse(row.ext).opened) return false;
  }
  return true;
}
export async function storeLocation(tx: Tx, storeId: string) {
  await storeOf(tx, storeId);
  const p = await tx.storeProfile.findUnique({ where: { storeId } });
  return {
    cityCode: p?.cityCode ?? null,
    industryCode: p?.industryCode ?? null,
    categoryCode: p?.categoryCode ?? null,
  };
}
