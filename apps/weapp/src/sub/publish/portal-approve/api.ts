import type { Body, Data } from "@/lib/account-api";
import type { RequestLayer } from "@/lib/request";

export type PortalPreview = Data<"m.portalTicket.lookup">;
export type PortalDecision = Data<"m.portalTicket.approve">;

export function createPortalApprovalApi(send: RequestLayer["request"]) {
  return {
    lookup: (code: string) =>
      send<PortalPreview>(`/m/portal-tickets/lookup?code=${encodeURIComponent(code)}`),
    approve: (id: string, pairDigits: string, idempotencyKey: string) =>
      send<PortalDecision>(`/m/portal-tickets/${encodeURIComponent(id)}/approve`, {
        method: "POST",
        data: { pairDigits } satisfies Body<"m.portalTicket.approve">,
        idempotencyKey,
      }),
    reject: (id: string, idempotencyKey: string) =>
      send<Data<"m.portalTicket.reject">>(`/m/portal-tickets/${encodeURIComponent(id)}/reject`, {
        method: "POST",
        idempotencyKey,
      }),
  };
}
