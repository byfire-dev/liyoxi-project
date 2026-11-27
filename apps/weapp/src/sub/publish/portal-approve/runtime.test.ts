import { afterEach, beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => {
  const request = vi.fn(async () => null);
  const fixture = vi.fn(async () => null);
  return { request, fixture, install: vi.fn(() => fixture) };
});
vi.mock("@/lib/runtime", () => ({ request: calls.request }));
vi.mock("../../../../shots/portal-approval-fixtures", () => ({
  offlinePortalApprovalRequest: calls.install,
}));
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it("正式 weapp 即使存在样张全局也只走中央 request", async () => {
  vi.stubEnv("TARO_ENV", "weapp");
  vi.stubGlobal("__LYX_PORTAL_APPROVAL_SHOT__", "portal-approve-pair");
  const { portalApprovalApi } = await import("./runtime");
  await portalApprovalApi.lookup("AB12CD34");
  expect(calls.request).toHaveBeenCalledWith("/m/portal-tickets/lookup?code=AB12CD34", undefined);
  expect(calls.install).not.toHaveBeenCalled();
  expect(calls.fixture).not.toHaveBeenCalled();
});
it("H5 无显式样张全局仍走中央 request", async () => {
  vi.stubEnv("TARO_ENV", "h5");
  const { portalApprovalApi } = await import("./runtime");
  await portalApprovalApi.lookup("AB12CD34");
  expect(calls.request).toHaveBeenCalledOnce();
  expect(calls.install).not.toHaveBeenCalled();
});
it("显式 H5 样张并发首请求只安装一次，之后不重建夹具状态", async () => {
  vi.stubEnv("TARO_ENV", "h5");
  vi.stubGlobal("__LYX_PORTAL_APPROVAL_SHOT__", "portal-approve-pair");
  const { portalApprovalApi } = await import("./runtime");
  await Promise.all([portalApprovalApi.lookup("AB12CD34"), portalApprovalApi.lookup("EF56GH78")]);
  await portalApprovalApi.reject("ticket", "intent");
  expect(calls.install).toHaveBeenCalledExactlyOnceWith("portal-approve-pair");
  expect(calls.fixture).toHaveBeenCalledTimes(3);
  expect(calls.request).not.toHaveBeenCalled();
});
