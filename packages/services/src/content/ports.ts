import { definePort } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
export interface DramaPrice {
  readonly dramaId: string;
  readonly points: number;
  readonly source: {
    readonly mode: "template" | "custom";
    readonly tier: "S" | "A" | "B" | "C" | null;
    readonly dramaPriceRevisionId: string | null;
    readonly tierRevisionId: string | null;
  };
}
export interface DramaPrices {
  priceAt(
    tx: Tx,
    dramaIds: readonly string[],
    at: Date,
  ): Promise<Map<string, DramaPrice | "no_tier" | "no_template" | "not_found">>;
  minLicenseMonths(tx: Tx, at: Date): Promise<number>;
}
export const DramaPricePort = definePort<DramaPrices>("content.drama_price");

export interface DramaUsage {
  stats(
    tx: Tx,
    ids: readonly string[],
    at: Date,
  ): Promise<
    Map<
      string,
      {
        orders30d: number;
        ordersMtd: number;
        liveItems: number;
      }
    >
  >;
  hasOpenItems(tx: Tx, dramaId: string): Promise<boolean>;
}
export const DramaUsagePort = definePort<DramaUsage>("content.drama_usage");
