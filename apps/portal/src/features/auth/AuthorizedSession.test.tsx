import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import { createPortalRuntime } from "../../lib/runtime";
import { failure, ok, SESSION } from "../../lib/api.test-helpers";
import { AuthorizedSession } from "./AuthorizedSession";
import { LoginPage } from "./LoginPage";

it("登录页停在唯一会话的真实门店、时间及退出，不跳到未注册的下载页", async () => {
  const actual = { ...SESSION, storeName: "本次授权门店" };
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(ok(actual));
  const runtime = createPortalRuntime({ fetch: send });
  try {
    await runtime.session.load();
    const html = renderToStaticMarkup(<LoginPage runtime={runtime} />);
    expect(html).toContain("电脑授权已确认");
    expect(html).toContain("本次授权门店");
    expect(html).toContain(actual.authorizedAt);
    expect(html).toContain(actual.expiresAt);
    expect(html).toContain("退出电脑授权");
    expect(html).toContain("刷新授权状态");
    expect(html).not.toMatch(/href="\/items|小程序授权登录|8 位登录码|刷新登录码/);
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    runtime.dispose();
  }
});

it.each([
  ["revoked", "owner_revoked", "门店老板已撤销这台电脑的授权"],
  ["expired", undefined, "本次电脑授权已过期"],
  ["authorizer_invalid", undefined, "授权人资格已变化"],
] as const)("刷新读回%s后撤下成功信息，沿原会话边界解释", async (reason, revokeReason, message) => {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(ok(SESSION))
    .mockResolvedValueOnce(
      failure("PORTAL_SESSION_INVALID", 401, { details: { reason, revokeReason } }),
    );
  const runtime = createPortalRuntime({ fetch: send });
  try {
    await runtime.session.load();
    const render = () => renderToStaticMarkup(<AuthorizedSession store={runtime.session} />);
    expect(render()).toContain("电脑授权已确认");
    await runtime.session.load();
    const html = render();
    expect(html).toContain(message);
    expect(html).toContain('href="/"');
    expect(html).not.toContain("电脑授权已确认");
    expect(html).not.toContain(SESSION.storeName);
    expect(html).not.toContain(SESSION.expiresAt);
    expect(send).toHaveBeenCalledTimes(2);
  } finally {
    runtime.dispose();
  }
});

it("退出结果未知保留真实会话与重试入口，确认退出后才撤下授权信息", async () => {
  const send = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(ok(SESSION))
    .mockRejectedValueOnce(new TypeError("network unavailable"))
    .mockResolvedValueOnce(ok(null));
  const runtime = createPortalRuntime({ fetch: send });
  try {
    await runtime.session.load();
    const render = () => renderToStaticMarkup(<AuthorizedSession store={runtime.session} />);
    await runtime.session.logout();
    expect(runtime.session.getSnapshot().error?.error).toBe("NETWORK_ERROR");
    expect(render()).toContain(SESSION.storeName);
    expect(render()).toContain("退出电脑授权");
    expect(render()).toContain('role="alert"');
    expect(send).toHaveBeenCalledTimes(2);
    await runtime.session.logout();
    expect(render()).not.toContain("电脑授权已确认");
    expect(render()).not.toContain(SESSION.storeName);
    expect(render()).toContain('href="/"');
    expect(send.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "DELETE", "DELETE"]);
  } finally {
    runtime.dispose();
  }
});
