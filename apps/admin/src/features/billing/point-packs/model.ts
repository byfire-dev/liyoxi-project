import { PointPackCreateBodySchema } from "@liyoxi/contract";
import { yuanToFen } from "@liyoxi/shared/format/money";
import type { PointPack } from "./api";
export interface PackDraft {
  points: number;
  priceYuan: string;
  position: number;
}
export function packBody(draft: PackDraft, seen?: Pick<PointPack, "lockVersion">) {
  const body = {
    points: draft.points,
    priceFen: yuanToFen(draft.priceYuan),
    position: draft.position,
  };
  const value = PointPackCreateBodySchema.parse(body);
  return seen ? { ...value, lockVersion: seen.lockVersion } : value;
}
export function packSearch(raw: Record<string, unknown>) {
  return {
    listed:
      raw.listed === "true"
        ? ("true" as const)
        : raw.listed === "false"
          ? ("false" as const)
          : undefined,
  };
}
