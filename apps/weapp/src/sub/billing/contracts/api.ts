import type { operations } from "@liyoxi/contract/types/merchant";
import type { Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";

export type SignedPage = Data<"m.agreementConsent.list">;
export type SignedItem = SignedPage["items"][number];
export type Version = Data<"m.agreementVersion.get">;
export type SignedQuery = NonNullable<operations["m.agreementConsent.list"]["parameters"]["query"]>;
export function createContractsApi(request: RequestLayer["request"]) {
  return {
    list: (cursor?: SignedQuery["cursor"]) =>
      request<SignedPage>(
        `/m/agreement-consents?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    summary: () => request<Data<"m.agreementConsent.summary">>("/m/agreement-consents/summary"),
    version: (id: string) => request<Version>(`/m/agreement-versions/${encodeURIComponent(id)}`),
  };
}
export type ContractsApi = ReturnType<typeof createContractsApi>;
