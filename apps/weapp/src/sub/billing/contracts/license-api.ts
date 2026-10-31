import type { operations } from "@liyoxi/contract/types/merchant";
import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";

export type LicensePage = Data<"m.licenseLetter.list">;
export type LicenseCard = LicensePage["items"][number];
export type LicenseDetail = Data<"m.licenseLetter.get">;
export type LicenseSummary = Data<"m.licenseLetter.summary">;
export type LicenseDownload = Data<"m.licenseLetter.downloadUrls">;
export type LicenseQuery = NonNullable<operations["m.licenseLetter.list"]["parameters"]["query"]>;
export type LicenseFilter = Pick<LicenseQuery, "storeId" | "orderId" | "includeVoided">;

function filterQuery(filter: LicenseFilter) {
  return Object.entries(filter)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join("&");
}

export function createLicenseApi(request: RequestLayer["request"]) {
  return {
    list: (filter: LicenseFilter, cursor?: LicenseQuery["cursor"]) =>
      request<LicensePage>(
        `/m/license-letters?${filterQuery(filter)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    summary: (filter: LicenseFilter) =>
      request<LicenseSummary>(`/m/license-letters/summary?${filterQuery(filter)}`),
    get: (id: LicenseCard["licenseLetterId"]) =>
      request<LicenseDetail>(`/m/license-letters/${encodeURIComponent(id)}`),
    download: (id: LicenseCard["licenseLetterId"], revNo?: number) =>
      request<LicenseDownload>(`/m/license-letters/${encodeURIComponent(id)}/download-urls`, {
        method: "POST",
        data: (revNo === undefined ? {} : { revNo }) satisfies Body<"m.licenseLetter.downloadUrls">,
      }),
  };
}
export type LicenseApi = ReturnType<typeof createLicenseApi>;
