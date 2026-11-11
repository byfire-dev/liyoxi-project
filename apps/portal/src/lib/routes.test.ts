import { describe, expect, it } from "vitest";

import { createPortalRoutes, safePortalTarget, type PortalRoute } from "./routes";

describe("portal route ownership", () => {
  it("登记不是业务实现，默认没有虚假login/items/preview/verify叶", () => {
    const registry = createPortalRoutes();
    for (const path of [
      "/",
      "/a",
      "/v?code=public",
      "/items",
      "/items/one",
      "/preview/ad/one",
      "/expired",
    ])
      expect(registry.match(path)).toBeNull();
  });
  it("后继只注册所属叶，验真保持public，preview保持session", () => {
    const registry = createPortalRoutes([
      { path: "/v", owner: "W6-12", access: "public", render: () => null },
      { path: "/preview/$kind/$id", owner: "W6-12", access: "session", render: () => null },
    ]);
    expect(registry.match("/v?code=public&rev=2")?.route.access).toBe("public");
    expect(registry.match("/preview/ad/019a-123")?.params).toEqual({ kind: "ad", id: "019a-123" });
    expect(registry.match("/preview/ad/019a-123")?.route.access).toBe("session");
    expect(registry.match("/items")).toBeNull();
    const invalid = {
      path: "/v",
      owner: "W6-11",
      access: "session",
      render: () => null,
    } as unknown as PortalRoute;
    expect(() => createPortalRoutes([invalid])).toThrow("页面归属或访问边界不符合登记");
  });
  it.each([
    "https://other.invalid",
    "//other.invalid",
    "/\\other.invalid",
    "/%2fother.invalid",
    "/a/../items",
    "/a/%2e%2e/items",
    "/v\n?code=x",
  ])("拒绝不安全导航%s", (target) => {
    expect(safePortalTarget(target)).toBeNull();
  });
});
