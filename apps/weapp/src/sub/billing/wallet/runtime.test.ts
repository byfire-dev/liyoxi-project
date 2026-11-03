import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { request } from "@/lib/runtime";
import type * as BillingFixtures from "../../../../shots/billing-fixtures";
import { offlineBillingRequest } from "../../../../shots/billing-fixtures";

vi.mock("@/lib/runtime", () => ({ request: vi.fn() }));
vi.mock("../../../../shots/billing-fixtures", async (original) => {
  const actual = await original<typeof BillingFixtures>();
  return { ...actual, offlineBillingRequest: vi.fn(actual.offlineBillingRequest) };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("TARO_ENV", "h5");
  vi.stubGlobal("__LYX_BILLING_SHOT__", "topup-list");
  vi.stubGlobal("__LYX_TOPUP_CALLS__", undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("wallet/policy并发首读只构造一次真实离线夹具，原调用记录不被后初始化覆盖", async () => {
  const { billingRequest } = await import("./runtime");
  await Promise.all([billingRequest("/m/wallet"), billingRequest("/m/purchase-policy?type=topup")]);
  expect(offlineBillingRequest).toHaveBeenCalledTimes(1);
  expect(offlineBillingRequest).toHaveBeenCalledWith("topup-list");
  const calls = (globalThis as { __LYX_TOPUP_CALLS__?: { path: string; method: string }[] })
    .__LYX_TOPUP_CALLS__;
  expect(calls?.map(({ path, method }) => ({ path, method }))).toEqual([
    { path: "/m/wallet", method: "GET" },
    { path: "/m/purchase-policy?type=topup", method: "GET" },
  ]);
  expect(request).not.toHaveBeenCalled();
});

it.each([
  ["weapp", "topup-list"],
  ["h5", undefined],
])("%s环境及显式标记%s仍严格限定离线入口", async (environment, scene) => {
  vi.stubEnv("TARO_ENV", environment);
  vi.stubGlobal("__LYX_BILLING_SHOT__", scene);
  const { billingRequest } = await import("./runtime");
  await billingRequest("/m/wallet");
  expect(request).toHaveBeenCalledWith("/m/wallet", undefined);
  expect(offlineBillingRequest).not.toHaveBeenCalled();
});
