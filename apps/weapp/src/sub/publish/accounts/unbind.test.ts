import { expect, it, vi } from "vitest";
import type { RequestLayer } from "@/lib/request";
import { ApiError } from "@/lib/request";
import { createPublishApi } from "./api";
vi.mock("@/lib/runtime", () => ({ request: vi.fn() }));
it("解绑使用正式 POST 空 body 与原意图键，关联仍在使用的拒绝原样保留", async () => {
  const failure = new ApiError({
    error: "CHANNEL_ACCOUNT_IN_USE",
    status: 409,
    requestId: "test",
    message: "账号仍有关联内容",
  });
  const send = vi.fn(async () => {
    throw failure;
  }) as unknown as RequestLayer["request"];
  await expect(createPublishApi(send).unbind("account-1", "original-key")).rejects.toBe(failure);
  expect(send).toHaveBeenCalledWith("/m/channel-accounts/account-1/unbind", {
    method: "POST",
    data: {},
    idempotencyKey: "original-key",
  });
});
