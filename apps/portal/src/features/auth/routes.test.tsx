import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createPortalRuntime } from "../../lib/runtime";
import { createPortalRoutes } from "../../lib/routes";
import { createAuthRoutes } from "./routes";

it("登录与落地页仅注册自己的公开叶，静态渲染不发授权请求", () => {
  const send = vi.fn<typeof fetch>();
  const runtime = createPortalRuntime({ fetch: send });
  const routes = createPortalRoutes(createAuthRoutes(runtime));
  for (const path of ["/", "/a?t=public-only"]) {
    const match = routes.match(path)!;
    expect(match.route.access).toBe("public");
    const html = renderToStaticMarkup(match.route.render(match.params));
    expect(html).toContain("小程序");
    expect(html).not.toMatch(/pollSecret|public-only|套餐|购买|充值/);
  }
  expect(routes.match("/items")).toBeNull();
  expect(routes.match("/v?code=public-only")).toBeNull();
  expect(send).not.toHaveBeenCalled();
  runtime.dispose();
});
