import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { createPortalRuntime } from "../../lib/runtime";
import { createPortalRoutes } from "../../lib/routes";
import { ItemsContent } from "./ItemsPage";
import { createDownloadRoutes } from "./routes";
import type { ItemsSnapshot } from "./model";

const empty = { page: { items: [], nextCursor: null, hasMore: false }, loading: false, error: "" };
it("两区分别显示空态，订购项与广告有不同预览入口", () => {
  const state: ItemsSnapshot = {
    orders: { ...empty, page: { ...empty.page, items: [] } },
    ads: { ...empty, page: { ...empty.page, items: [] } },
  };
  const render = () => renderToStaticMarkup(<ItemsContent state={state} load={vi.fn()} />);
  expect(render()).toContain("该门店暂无已交付成片");
  expect(render()).toContain("该门店暂无待确认广告");
  state.ads.page!.items.push({
    adId: "ad-1",
    adNo: "GG001",
    type: "opening",
    durationSec: 15,
    status: "pending_confirm",
    displayStatus: "pending_confirm",
    copy: "店铺广告",
    currentVersionNo: 2,
    currentVersionPushedAt: "2026-11-04T00:00:00.000Z",
    currentPreviewChannels: ["portal"],
    confirmedVersionNo: null,
    poster: null,
    isPortalPreviewable: true,
  });
  const html = render();
  expect(html).toContain('href="/preview/ad/ad-1"');
  expect(html).not.toContain('href="/items/ad-1"');
  expect(html).not.toMatch(/支付|购买|套餐|充值/);
});
it("只导出两个受session保护的W6-11叶，不实现预览或登录", () => {
  const runtime = createPortalRuntime({ fetch: vi.fn() });
  const routes = createDownloadRoutes(runtime);
  expect(routes.map(({ path, owner, access }) => ({ path, owner, access }))).toEqual([
    { path: "/items", owner: "W6-11", access: "session" },
    { path: "/items/$id", owner: "W6-11", access: "session" },
  ]);
  expect(createPortalRoutes(routes).match("/preview/ad/example")).toBeNull();
  runtime.dispose();
});
