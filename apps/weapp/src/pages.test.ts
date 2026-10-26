import { describe, expect, it } from "vitest";

import { buildRoutes, isBuilt, WEAPP_PAGES, WEAPP_PRELOAD, type WeappPage } from "./pages";

// 页面清单的用例：清单本身的形状，以及由它拼出全局配置的规则。数量对的是 D7 第 4.1 节与计划 第 8.3 节。

describe("页面清单", () => {
  it("49 个路由：主包 6 页、9 个分包；路由不重复，各自落在自己的包下", () => {
    expect(WEAPP_PAGES).toHaveLength(49);
    expect(new Set(WEAPP_PAGES.map((page) => page.route)).size).toBe(49);
    expect(WEAPP_PAGES.filter((page) => page.pkg === "main")).toHaveLength(6);
    const subs = new Set(WEAPP_PAGES.filter((page) => page.pkg !== "main").map((page) => page.pkg));
    expect(subs.size).toBe(9);
    for (const page of WEAPP_PAGES) {
      const prefix = page.pkg === "main" ? "pages/" : `${page.pkg}/`;
      expect(page.route.startsWith(prefix), page.route).toBe(true);
      expect(page.route.endsWith("/index"), page.route).toBe(true);
    }
  });

  it("里程碑归属照计划 第 8.3 节：25、8、5、4、3、1、2，预告片页 V1.0 不做", () => {
    const count = (milestone: WeappPage["milestone"]) =>
      WEAPP_PAGES.filter((page) => page.milestone === milestone).length;
    expect(["M1", "M2", "M3", "M4", "M5", "M6", "M7"].map((m) => count(m as "M1"))).toEqual([
      25, 8, 5, 4, 3, 1, 2,
    ]);
    expect(
      WEAPP_PAGES.filter((page) => page.milestone === "V1.1").map((page) => page.route),
    ).toEqual(["sub/catalog/trailer/index"]);
  });

  it("已交付四十一页包含 M1 全部二十五页，V1.1不实现", () => {
    const built = WEAPP_PAGES.filter(isBuilt);
    expect(built.filter((page) => page.placeholder)).toHaveLength(0);
    expect(WEAPP_PAGES.filter((page) => page.milestone === "M1" && !page.implemented)).toHaveLength(
      0,
    );
    expect(built.map((page) => page.route)).toEqual([
      "pages/home/index",
      "pages/mall/index",
      "pages/cart/index",
      "pages/mine/index",
      "pages/login/index",
      "pages/agreement/index",
      "sub/catalog/search/index",
      "sub/catalog/detail/index",
      "sub/order/checkout/index",
      "sub/order/result/index",
      "sub/order/orders/index",
      "sub/order/order-detail/index",
      "sub/order/plan/index",
      "sub/order/sample/index",
      "sub/order/launch-record/index",
      "sub/publish/tasks/index",
      "sub/publish/downloads/index",
      "sub/publish/accounts/index",
      "sub/billing/wallet/index",
      "sub/billing/plan-pick/index",
      "sub/billing/topup/index",
      "sub/billing/invoices/index",
      "sub/billing/contracts/index",
      "sub/profile/profile/index",
      "sub/profile/basic/index",
      "sub/profile/store/index",
      "sub/profile/service/index",
      "sub/profile/cert/index",
      "sub/profile/review/index",
      "sub/profile/stores/index",
      "sub/profile/store-add/index",
      "sub/profile/staff-profile/index",
      "sub/asset/lib/index",
      "sub/asset/upload/index",
      "sub/asset/detail/index",
      "sub/asset/uploader/index",
      "sub/service/messages/index",
      "sub/service/settings/index",
      "sub/member/members/index",
      "sub/member/invite/index",
      "sub/member/join/index",
    ]);
    expect(built.filter((page) => page.implemented).map((page) => page.route)).toEqual([
      "pages/home/index",
      "pages/mall/index",
      "pages/cart/index",
      "pages/mine/index",
      "pages/login/index",
      "pages/agreement/index",
      "sub/catalog/search/index",
      "sub/catalog/detail/index",
      "sub/order/checkout/index",
      "sub/order/result/index",
      "sub/order/orders/index",
      "sub/order/order-detail/index",
      "sub/order/plan/index",
      "sub/order/sample/index",
      "sub/order/launch-record/index",
      "sub/publish/tasks/index",
      "sub/publish/downloads/index",
      "sub/publish/accounts/index",
      "sub/billing/wallet/index",
      "sub/billing/plan-pick/index",
      "sub/billing/topup/index",
      "sub/billing/invoices/index",
      "sub/billing/contracts/index",
      "sub/profile/profile/index",
      "sub/profile/basic/index",
      "sub/profile/store/index",
      "sub/profile/service/index",
      "sub/profile/cert/index",
      "sub/profile/review/index",
      "sub/profile/stores/index",
      "sub/profile/store-add/index",
      "sub/profile/staff-profile/index",
      "sub/asset/lib/index",
      "sub/asset/upload/index",
      "sub/asset/detail/index",
      "sub/asset/uploader/index",
      "sub/service/messages/index",
      "sub/service/settings/index",
      "sub/member/members/index",
      "sub/member/invite/index",
      "sub/member/join/index",
    ]);
    expect(
      built.filter((page) => page.placeholder).every((page) => page.tab && !page.implemented),
    ).toBe(true);
    expect(
      WEAPP_PAGES.filter((page) => page.milestone === "V1.1").every((page) => !page.implemented),
    ).toBe(true);
    expect(WEAPP_PAGES.filter((page) => page.customNav).map((page) => page.route)).toEqual([
      "pages/home/index",
      "pages/login/index",
    ]);
  });
});

describe("由清单拼出全局配置", () => {
  it("现在：主包六页、八个已交付分包，预下载只指向已交付分包", () => {
    expect(buildRoutes()).toEqual({
      pages: [
        "pages/home/index",
        "pages/mall/index",
        "pages/cart/index",
        "pages/mine/index",
        "pages/login/index",
        "pages/agreement/index",
      ],
      subPackages: [
        { root: "sub/catalog", pages: ["search/index", "detail/index"] },
        {
          root: "sub/order",
          pages: [
            "checkout/index",
            "result/index",
            "orders/index",
            "order-detail/index",
            "plan/index",
            "sample/index",
            "launch-record/index",
          ],
        },
        { root: "sub/publish", pages: ["tasks/index", "downloads/index", "accounts/index"] },
        {
          root: "sub/billing",
          pages: [
            "wallet/index",
            "plan-pick/index",
            "topup/index",
            "invoices/index",
            "contracts/index",
          ],
        },
        {
          root: "sub/profile",
          pages: [
            "profile/index",
            "basic/index",
            "store/index",
            "service/index",
            "cert/index",
            "review/index",
            "stores/index",
            "store-add/index",
            "staff-profile/index",
          ],
        },
        {
          root: "sub/asset",
          pages: ["lib/index", "upload/index", "detail/index", "uploader/index"],
        },
        { root: "sub/service", pages: ["messages/index", "settings/index"] },
        { root: "sub/member", pages: ["members/index", "invite/index", "join/index"] },
      ],
      preloadRule: {
        "pages/home/index": { network: "all", packages: ["sub/catalog", "sub/order"] },
        "pages/mall/index": { network: "all", packages: ["sub/catalog"] },
        "pages/cart/index": { network: "all", packages: ["sub/order"] },
        "pages/mine/index": { network: "all", packages: ["sub/billing", "sub/profile"] },
      },
    });
  });

  it("分包里的页一实现：分包与指向它的预下载跟着出现；没有页的分包不出现", () => {
    const pages = WEAPP_PAGES.map((page) =>
      ["sub/order/order-detail/index", "sub/publish/accounts/index"].includes(page.route)
        ? { ...page, implemented: false }
        : page,
    ).map((page) =>
      ["sub/catalog/detail/index", "sub/order/checkout/index", "sub/order/orders/index"].includes(
        page.route,
      )
        ? { ...page, implemented: true }
        : page,
    );
    const routes = buildRoutes(pages);
    expect(routes.subPackages).toEqual([
      { root: "sub/catalog", pages: ["search/index", "detail/index"] },
      {
        root: "sub/order",
        pages: [
          "checkout/index",
          "result/index",
          "orders/index",
          "plan/index",
          "sample/index",
          "launch-record/index",
        ],
      },
      { root: "sub/publish", pages: ["tasks/index", "downloads/index"] },
      {
        root: "sub/billing",
        pages: [
          "wallet/index",
          "plan-pick/index",
          "topup/index",
          "invoices/index",
          "contracts/index",
        ],
      },
      {
        root: "sub/profile",
        pages: [
          "profile/index",
          "basic/index",
          "store/index",
          "service/index",
          "cert/index",
          "review/index",
          "stores/index",
          "store-add/index",
          "staff-profile/index",
        ],
      },
      { root: "sub/asset", pages: ["lib/index", "upload/index", "detail/index", "uploader/index"] },
      { root: "sub/service", pages: ["messages/index", "settings/index"] },
      { root: "sub/member", pages: ["members/index", "invite/index", "join/index"] },
    ]);
    expect(routes.preloadRule).toEqual({
      "pages/home/index": { network: "all", packages: ["sub/catalog", "sub/order"] },
      "pages/mall/index": { network: "all", packages: ["sub/catalog"] },
      "pages/mine/index": { network: "all", packages: ["sub/billing", "sub/profile"] },
      "pages/cart/index": { network: "all", packages: ["sub/order"] },
    });
    const withoutBilling = buildRoutes(
      pages.map((page) => (page.pkg === "sub/billing" ? { ...page, implemented: false } : page)),
    );
    expect(withoutBilling.subPackages.some((item) => item.root === "sub/billing")).toBe(false);
    expect(withoutBilling.preloadRule["pages/mine/index"]).toEqual({
      network: "all",
      packages: ["sub/profile"],
    });
  });

  it("预下载只挂在主包的页上，指到的都是清单里的分包", () => {
    const subs = new Set(WEAPP_PAGES.map((page) => page.pkg));
    for (const [route, packages] of Object.entries(WEAPP_PRELOAD)) {
      expect(WEAPP_PAGES.find((page) => page.route === route)?.pkg, route).toBe("main");
      for (const name of packages) expect(subs.has(name), name).toBe(true);
    }
  });
});
