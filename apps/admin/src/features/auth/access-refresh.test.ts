import { afterEach, expect, it, vi } from "vitest";
import { createAppServices } from "../../app/services";
import type { AccessSnapshot } from "../../lib/permissions";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("权限拒绝后重新拉取没有观察者的 loader 缓存，再使守卫失效", async () => {
  const NativeRequest = Request;
  vi.stubGlobal(
    "Request",
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === "string" ? new URL(input, "http://admin.test") : input, init);
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ error: "PERMISSION_DENIED", code: 40300, message: "没有访问权限" }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
  );
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  const services = createAppServices();
  let reads = 0;
  const snapshot: AccessSnapshot = {
    staff: { id: "staff", name: "管理员", roleKey: "super_admin", roleName: "管理员" },
    isLead: false,
    moduleLevels: { system: "e" },
    actions: [],
    dataScope: "all",
    releases: {},
  };
  services.setAccessSource({
    load: async (): Promise<AccessSnapshot> => ({
      ...snapshot,
      moduleLevels: { system: ++reads === 1 ? "e" : "n" },
    }),
  });
  expect((await services.loadAccess())?.moduleLevels.system).toBe("e");
  const refreshed = new Promise<void>((resolve) => services.onAccessRefreshed(resolve));
  await services.api.client.GET("/api/v1/admin/auth/me");
  await refreshed;
  expect(reads).toBe(2);
  expect((await services.loadAccess())?.moduleLevels.system).toBe("n");
  services.queryClient.clear();
});
