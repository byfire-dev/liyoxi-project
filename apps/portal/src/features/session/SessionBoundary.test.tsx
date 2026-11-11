import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createPortalClient } from "../../lib/api";
import { failure, ok, SESSION } from "../../lib/api.test-helpers";
import { createPortalSessionStore } from "./model";
import { SessionBoundary } from "./SessionBoundary";

describe("真实会话边界呈现", () => {
  it("未知/失效状态不呈现受保护内容，不伪造登录入口", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(
      failure("PORTAL_SESSION_INVALID", 401, {
        details: { reason: "revoked", revokeReason: "owner_revoked" },
      }),
    );
    const store = createPortalSessionStore(createPortalClient({ fetch: send }));
    const render = () =>
      renderToStaticMarkup(
        <SessionBoundary store={store}>
          <p>本次授权内容</p>
        </SessionBoundary>,
      );
    expect(render()).toContain("正在核对电脑授权");
    expect(render()).not.toContain("本次授权内容");
    await store.load();
    const invalid = render();
    expect(invalid).toContain("门店老板已撤销这台电脑的授权");
    expect(invalid).not.toContain("本次授权内容");
    expect(invalid).toContain('href="/"');
  });

  it("认证显示真实门店与退出；维护只有显式重载，不提供失效重试", async () => {
    const send = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(ok(SESSION))
      .mockResolvedValueOnce(failure("MAINTENANCE", 503));
    const store = createPortalSessionStore(createPortalClient({ fetch: send }));
    await store.load();
    const render = () =>
      renderToStaticMarkup(
        <SessionBoundary store={store}>
          <p>本次授权内容</p>
        </SessionBoundary>,
      );
    expect(render()).toContain("测试门店");
    expect(render()).toContain("退出电脑授权");
    expect(render()).toContain("本次授权内容");
    await store.load();
    const maintenance = render();
    expect(maintenance).toContain("重新加载页面");
    expect(maintenance).not.toContain("重新读取授权");
    expect(maintenance).not.toContain("本次授权内容");
    expect(maintenance).not.toContain("测试门店");
  });
});
