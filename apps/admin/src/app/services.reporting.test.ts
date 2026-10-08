import { afterEach, expect, it, vi } from "vitest";
import { ACCESS_QUERY_KEY, createAppServices } from "./services";
import type { AccessSnapshot } from "../lib/permissions";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
function absoluteRequest() {
  const NativeRequest = Request;
  vi.stubGlobal(
    "Request",
    class extends NativeRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(typeof input === "string" ? new URL(input, "http://admin.test") : input, init);
      }
    },
  );
}
it("真实AppServices装配公开DSN/中央sender/当前staff内部UUID", async () => {
  absoluteRequest();
  vi.stubEnv("VITE_CLIENT_ERROR_DSN", "https://publickey@example.invalid/7");
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (request: Request) => {
    requests.push(request);
    return new Response(JSON.stringify({ code: 0, message: "ok", data: null }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  });
  const services = createAppServices();
  const userId = "01972ef1-0000-7000-8000-000000000001";
  services.queryClient.setQueryData<AccessSnapshot>(ACCESS_QUERY_KEY, {
    staff: { id: userId, name: "测试", roleKey: "super_admin", roleName: "管理员" },
    isLead: false,
    moduleLevels: {},
    actions: [],
    dataScope: "all",
    releases: {},
  });
  services.clientReporting.capture(new Error("Example error"));
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const request = requests[0]!;
  expect(request.url).toBe("http://admin.test/api/v1/admin/client-errors");
  expect(request.headers.get("Content-Type")).toBe("application/x-sentry-envelope");
  expect(request.headers.get("X-LYX-Admin")).toBe("1");
  const raw = await request.text();
  expect(JSON.parse(raw.split("\n")[0]!)).toMatchObject({
    dsn: "https://publickey@example.invalid/7",
  });
  expect(JSON.parse(raw.split("\n")[2]!)).toMatchObject({ user: { id: userId } });
  expect(raw).not.toContain("测试");
  services.queryClient.clear();
});
it("真实AppServices公开DSN未配时错误捕获不发请求", async () => {
  absoluteRequest();
  vi.stubEnv("VITE_CLIENT_ERROR_DSN", "");
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const services = createAppServices();
  services.clientReporting.capture(new Error("Example error"));
  await Promise.resolve();
  expect(fetch).not.toHaveBeenCalled();
  services.queryClient.clear();
});
