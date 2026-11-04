import { expect, it, vi } from "vitest";
import type { RequestLayer } from "@/lib/request";
import { createPortalApprovalApi } from "./api";

it("批准和拒绝复用中央请求的门店身份与幂等键，不从二维码选API主机", async () => {
  const sent = vi.fn<(...args: Parameters<RequestLayer["request"]>) => void>();
  const send: RequestLayer["request"] = async <T>(...args: Parameters<RequestLayer["request"]>) => {
    sent(...args);
    return null as T;
  };
  const api = createPortalApprovalApi(send);
  await api.lookup("AbC+/?");
  await api.approve("ticket/a", "17", "approve:key");
  await api.reject("ticket/a", "reject:key");
  expect(sent.mock.calls).toEqual([
    ["/m/portal-tickets/lookup?code=AbC%2B%2F%3F"],
    [
      "/m/portal-tickets/ticket%2Fa/approve",
      { method: "POST", data: { pairDigits: "17" }, idempotencyKey: "approve:key" },
    ],
    ["/m/portal-tickets/ticket%2Fa/reject", { method: "POST", idempotencyKey: "reject:key" }],
  ]);
});
