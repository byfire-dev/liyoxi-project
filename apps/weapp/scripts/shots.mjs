#!/usr/bin/env node
// 小程序页面截图。根脚本是 pnpm weapp:shots（= pnpm --filter @liyoxi/weapp shots）。
//
// 用法：pnpm weapp:shots [-- --page <路由> …] [--component <组件名> …] [--sheet <样张名> …] [--no-build]
//   不带参数           页面清单（src/pages.ts）里已建的页各出一张；组件陈列（src/gallery.ts）的目录页一张、
//                      每个组件的预览各一张、每张基础样张各一张
//   --page <路由>      只出这一页，可给多次。路由照页面清单的写法，如 pages/home/index
//   --component <名字> 只出这个组件的预览，可给多次。名字是 src/components/ 下的目录名，如 Button
//   --sheet <名字>     只出这张基础样张，可给多次。名字照 src/gallery.ts 的 GALLERY_SHEETS，如 colors
//   --scene <名字>     只出账户固定离线场景，可多次；场景见 shots/account-scenes.ts
//   --no-build         不重新构建，直接用上一次的 H5 产物
// 组件预览的图（W0-27b）：文件名 gallery__<组件名>.png，截整页（预览比一屏长），其余的页只截一屏。
// 基础样张的图（W0-29）：文件名 gallery__sheet-<样张名>.png，同样截整页；陈列的目录页也截整页（看样要看全各组的节号与要点）。
// 做法（任务书 W0-27a 第 11 节第 1 项）：先出一份 Taro 的 H5 构建（shots/dist/h5/），本机起一个只服务这个目录的
// 静态服务，用 Playwright 的 Chromium 按 375 × 812、1 倍像素打开每一页截图。产物在 shots/dist/png/，
// 文件名是路由把 / 换成 __，宽 375；不入库，CI 把这个目录作为产物 weapp-shots 上传。
// 浏览器：缺省用 Playwright 自带的 Chromium（CI 里先 playwright install）；本机可用 LYX_E2E_CHANNEL=chrome。
// 与真机的差异（PR 描述里要写）：H5 是近似，不是小程序渲染层。原生导航栏在 H5 下不出现（没有标题栏与胶囊），
// 标签栏是 Taro 的 H5 仿制件，高度与字体都与微信不同；自绘导航取不到胶囊位置，用的是兜底值；页面底色没有铺满，
// 内容区是白的；尺寸在 375 宽下恰好是原型的 px。真机上的样子以开发者工具与手机为准（E16、E7）。
// 退出码：0 全部出图；1 有页面没出来（路由不在已建的页里、页面报错、截不到）；2 用法或环境错误。
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium, expect } from "@playwright/test";
import {
  deliveryRegression,
  deliveryNavigationRegression,
} from "../shots/delivery-regressions.mjs";
import { orderRegression, publishRegression } from "../shots/order-regressions.mjs";
import { searchEntryRegression, searchRegression } from "../shots/search-regressions.mjs";
import { assetRegression } from "../shots/asset-regressions.mjs";
import {
  profileContactRegression,
  profileAuthorizationRegression,
  profileContextRegression,
  profileEditRegression,
  profilePageReady,
  profileMissingRegression,
  profileCertificateSheetRegression,
} from "../shots/profile-regressions.mjs";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const h5Dir = path.join(appRoot, "shots/dist/h5");
const outDir = path.join(appRoot, "shots/dist/png");
const VIEWPORT = { width: 375, height: 812 };
/** 同时开几个标签页截图 */
const CONCURRENCY = 3;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function fail(message, code = 2) {
  console.error(`小程序截图：${message}`);
  process.exit(code);
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
const wanted = [];
const wantedComponents = [];
const wantedSheets = [];
const wantedScenes = [];
const { ACCOUNT_SCENES } = await import(
  pathToFileURL(path.join(appRoot, "shots/account-scenes.ts")).href
);
const { PROFILE_SCENES } = await import(
  pathToFileURL(path.join(appRoot, "shots/profile-scenes.ts")).href
);
const { BILLING_SCENES } = await import(
  pathToFileURL(path.join(appRoot, "shots/billing-scenes.ts")).href
);
const { CATALOG_SCENES } = await import(
  pathToFileURL(path.join(appRoot, "shots/catalog-scenes.ts")).href
);
const { ORDER_SCENES } = await import(
  pathToFileURL(path.join(appRoot, "shots/order-scenes.ts")).href
);
const { PUBLISH_SCENES } = await import(
  pathToFileURL(path.join(appRoot, "shots/publish-scenes.ts")).href
);
const { DELIVERY_SCENES } = await import(
  pathToFileURL(path.join(appRoot, "shots/delivery-scenes.ts")).href
);
const { MESSAGE_SCENES } = await import(
  pathToFileURL(path.join(appRoot, "shots/message-scenes.ts")).href
);
const { SEARCH_SCENES } = await import(
  pathToFileURL(path.join(appRoot, "shots/search-scenes.ts")).href
);
const { ASSET_SCENES } = await import(
  pathToFileURL(path.join(appRoot, "shots/asset-scenes.ts")).href
);
let build = true;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--no-build") build = false;
  else if (args[index] === "--page") {
    const route = args[(index += 1)];
    if (!route) fail("--page 后面要跟一个路由，如 pages/home/index");
    wanted.push(route.replace(/^\//, ""));
  } else if (args[index] === "--component") {
    const name = args[(index += 1)];
    if (!name) fail("--component 后面要跟一个组件名，如 Button");
    wantedComponents.push(name);
  } else if (args[index] === "--sheet") {
    const name = args[(index += 1)];
    if (!name) fail("--sheet 后面要跟一个样张名，如 colors");
    wantedSheets.push(name);
  } else if (args[index] === "--scene") {
    const name = args[(index += 1)];
    if (
      ![
        ...ACCOUNT_SCENES,
        ...PROFILE_SCENES,
        ...BILLING_SCENES,
        ...CATALOG_SCENES,
        ...ORDER_SCENES,
        ...PUBLISH_SCENES,
        ...DELIVERY_SCENES,
        ...MESSAGE_SCENES,
        ...SEARCH_SCENES,
        ...ASSET_SCENES,
      ].some((item) => item.name === name)
    )
      fail(`未知固定场景 ${name}`);
    wantedScenes.push(name);
  } else fail(`不认识的参数 ${args[index]}`);
}

// 页面清单是 TypeScript，用 Node 自带的类型擦除直接读（文件里不得有要运行的 import）
const { WEAPP_PAGES, isBuilt } = await import(
  pathToFileURL(path.join(appRoot, "src/pages.ts")).href
);
// 组件陈列（开发用的分包，H5 构建一律带）：目录页照普通页面出，每个组件的预览另出一张整页的
const { GALLERY_ITEMS, GALLERY_SHEETS, GALLERY_INDEX_ROUTE, GALLERY_PREVIEW_ROUTE } = await import(
  pathToFileURL(path.join(appRoot, "src/gallery.ts")).href
);
const builtRoutes = [...WEAPP_PAGES.filter(isBuilt).map((item) => item.route), GALLERY_INDEX_ROUTE];
const unknown = wanted.filter((route) => !builtRoutes.includes(route));
if (unknown.length > 0) {
  fail(`这些路由不在已建的页里：${unknown.join("、")}。已建的页：${builtRoutes.join("、")}`, 1);
}
const componentNames = GALLERY_ITEMS.map((item) => item.name);
const unknownComponents = wantedComponents.filter((name) => !componentNames.includes(name));
if (unknownComponents.length > 0) {
  fail(`这些组件不在陈列的登记（src/gallery.ts）里：${unknownComponents.join("、")}`, 1);
}
const sheetNames = GALLERY_SHEETS.map((item) => item.name);
const unknownSheets = wantedSheets.filter((name) => !sheetNames.includes(name));
if (unknownSheets.length > 0) {
  fail(`这些样张不在陈列的登记（src/gallery.ts）里：${unknownSheets.join("、")}`, 1);
}
const all =
  wanted.length === 0 &&
  wantedComponents.length === 0 &&
  wantedSheets.length === 0 &&
  wantedScenes.length === 0;
/** 要出的图：url 是 # 后面的部分，file 是不带扩展名的文件名，fullPage 为真截整页 */
const targets = [
  ...(all ? ACCOUNT_SCENES : ACCOUNT_SCENES.filter((item) => wantedScenes.includes(item.name))).map(
    (item) => ({
      label: item.name,
      url: `${item.route}${item.route.includes("?") ? "&" : "?"}lyxShot=${item.name}`,
      file: `account__${item.name}`,
      scene: item.name,
      kind: "account",
      fullPage: false,
    }),
  ),
  ...(all ? PROFILE_SCENES : PROFILE_SCENES.filter((item) => wantedScenes.includes(item.name))).map(
    (item) => ({
      label: item.name,
      url: `${item.route}?lyxShot=${item.name}`,
      file: `profile__${item.name}`,
      scene: item.name,
      kind: "profile",
      fullPage: false,
    }),
  ),
  ...(all ? BILLING_SCENES : BILLING_SCENES.filter((item) => wantedScenes.includes(item.name))).map(
    (item) => ({
      label: item.name,
      url: `${item.route}${item.route.includes("?") ? "&" : "?"}lyxShot=${item.name}`,
      file: `billing__${item.name}`,
      scene: item.name,
      kind: "billing",
      fullPage: false,
    }),
  ),
  ...(all ? CATALOG_SCENES : CATALOG_SCENES.filter((item) => wantedScenes.includes(item.name))).map(
    (item) => ({
      label: item.name,
      url: `${item.route}${item.route.includes("?") ? "&" : "?"}lyxShot=${item.name}`,
      file: `catalog__${item.name}`,
      scene: item.name,
      kind: "catalog",
      fullPage: false,
    }),
  ),
  ...(all ? PUBLISH_SCENES : PUBLISH_SCENES.filter((item) => wantedScenes.includes(item.name))).map(
    (item) => ({
      label: item.name,
      url: `${item.route}?lyxShot=${item.name}`,
      file: `publish__${item.name}`,
      scene: item.name,
      kind: "publish",
      fullPage: false,
    }),
  ),
  ...(all ? ORDER_SCENES : ORDER_SCENES.filter((item) => wantedScenes.includes(item.name))).map(
    (item) => ({
      label: item.name,
      url: `${item.route}${item.route.includes("?") ? "&" : "?"}lyxShot=${item.name}`,
      file: `order__${item.name}`,
      scene: item.name,
      kind: "order",
      fullPage: false,
    }),
  ),
  ...(all
    ? DELIVERY_SCENES
    : DELIVERY_SCENES.filter((item) => wantedScenes.includes(item.name))
  ).map((item) => ({
    label: item.name,
    url: `${item.route}${item.route.includes("?") ? "&" : "?"}lyxShot=${item.name}`,
    file: `delivery__${item.name}`,
    scene: item.name,
    kind: "delivery",
    fullPage: false,
  })),
  ...(all ? MESSAGE_SCENES : MESSAGE_SCENES.filter((item) => wantedScenes.includes(item.name))).map(
    (item) => ({
      label: item.name,
      url: `${item.route}?lyxShot=${item.name}`,
      file: `message__${item.name}`,
      scene: item.name,
      kind: "message",
      fullPage: false,
    }),
  ),
  ...(all
    ? SEARCH_SCENES
    : SEARCH_SCENES.filter(
        (item) => wantedScenes.includes(item.name) || wanted.includes(item.route),
      )
  ).map((item) => ({
    label: item.name,
    url: `${item.route}?lyxShot=${item.name}`,
    file: `search__${item.name}`,
    scene: item.name,
    kind: "search",
    fullPage: false,
  })),
  ...(all
    ? ASSET_SCENES
    : ASSET_SCENES.filter(
        (item) => wantedScenes.includes(item.name) || wanted.includes(item.route.split("?")[0]),
      )
  ).map((item) => ({
    label: item.name,
    url: `${item.route}${item.route.includes("?") ? "&" : "?"}lyxShot=${item.name}`,
    file: `asset__${item.name}`,
    scene: item.name,
    kind: "asset",
    fullPage: false,
  })),
  ...(all
    ? builtRoutes.filter(
        (route) =>
          !["pages/login/index", "pages/agreement/index", "pages/mine/index"].includes(route) &&
          !PROFILE_SCENES.some((item) => item.route === route) &&
          !BILLING_SCENES.some((item) => item.route === route) &&
          !CATALOG_SCENES.some((item) => item.route.split("?")[0] === route) &&
          !ORDER_SCENES.some((item) => item.route.split("?")[0] === route) &&
          !PUBLISH_SCENES.some((item) => item.route === route) &&
          !DELIVERY_SCENES.some((item) => item.route.split("?")[0] === route) &&
          !MESSAGE_SCENES.some((item) => item.route === route) &&
          !SEARCH_SCENES.some((item) => item.route === route) &&
          !ASSET_SCENES.some((item) => item.route.split("?")[0] === route),
      )
    : wanted.filter(
        (route) =>
          !SEARCH_SCENES.some((item) => item.route === route) &&
          !ASSET_SCENES.some((item) => item.route.split("?")[0] === route),
      )
  ).map((route) => ({
    label: route,
    url: route,
    file: route.replaceAll("/", "__"),
    fullPage: route === GALLERY_INDEX_ROUTE,
    ...(PROFILE_SCENES.some((item) => item.route === route)
      ? { scene: PROFILE_SCENES.find((item) => item.route === route)?.name, kind: "profile" }
      : route === "sub/service/messages/index"
        ? { scene: "messages-owner", kind: "message" }
        : {}),
  })),
  ...(all ? componentNames : wantedComponents).map((name) => ({
    label: `组件 ${name}`,
    url: `${GALLERY_PREVIEW_ROUTE}?name=${name}`,
    file: `gallery__${name}`,
    fullPage: true,
  })),
  ...(all ? sheetNames : wantedSheets).map((name) => ({
    label: `样张 ${name}`,
    url: `${GALLERY_PREVIEW_ROUTE}?sheet=${name}`,
    file: `gallery__sheet-${name}`,
    fullPage: true,
  })),
];

if (build) {
  const result = spawnSync(process.execPath, [path.join(appRoot, "scripts/build.mjs"), "h5"], {
    cwd: appRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) fail("H5 构建没过，出不了图", result.status ?? 1);
}
if (!existsSync(path.join(h5Dir, "index.html"))) fail("没有 H5 产物：去掉 --no-build 再跑");

/** 只服务 H5 产物目录的静态服务：只听本机，路径越出目录即 404 */
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  const file = path.join(h5Dir, pathname === "/" ? "index.html" : pathname);
  if (!file.startsWith(h5Dir + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
  });
  createReadStream(file).pipe(response);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ channel: process.env.LYX_E2E_CHANNEL || undefined });
} catch (error) {
  server.close();
  fail(`浏览器起不来（本机可加 LYX_E2E_CHANNEL=chrome）。${String(error.message).split("\n")[0]}`);
}
const context = await browser.newContext({
  viewport: VIEWPORT,
  deviceScaleFactor: 1,
  locale: "zh-CN",
  timezoneId: "Asia/Shanghai",
});
const failed = [];
async function shoot(target) {
  const isolated = target.scene
    ? await browser.newContext({
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
      })
    : null;
  const page = await (isolated ?? context).newPage();
  if (target.scene === "cert-sheet") await page.setViewportSize({ width: 320, height: 568 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    if (target.scene) {
      await page.addInitScript(
        ({ scene, kind }) => {
          globalThis.__LYX_ACCOUNT_SHOT__ = [
            "profile",
            "billing",
            "order",
            "publish",
            "delivery",
          ].includes(kind)
            ? "mine-owner"
            : scene;
          if (kind === "catalog") {
            globalThis.__LYX_ACCOUNT_SHOT__ = scene.endsWith("clerk")
              ? "mine-clerk"
              : scene.endsWith("guest")
                ? "mine-guest"
                : "mine-owner";
            globalThis.__LYX_CATALOG_SHOT__ = scene;
            if (scene.startsWith("home-") || scene.startsWith("mall-"))
              globalThis.__LYX_SEARCH_SHOT__ = scene.endsWith("clerk")
                ? "search-clerk"
                : scene.endsWith("guest")
                  ? "search-guest"
                  : "search-owner";
          }
          if (kind === "search") {
            globalThis.__LYX_ACCOUNT_SHOT__ = scene.endsWith("clerk")
              ? "mine-clerk"
              : scene.endsWith("guest")
                ? "mine-guest"
                : "mine-owner";
            globalThis.__LYX_SEARCH_SHOT__ = scene;
            globalThis.__LYX_CATALOG_SHOT__ = scene;
          }
          if (kind === "asset") {
            globalThis.__LYX_ACCOUNT_SHOT__ = scene.endsWith("clerk") ? "mine-clerk" : "mine-owner";
            globalThis.__LYX_ASSET_SHOT__ = scene;
          }
          if (kind === "order") globalThis.__LYX_ORDER_SHOT__ = scene;
          if (kind === "publish") globalThis.__LYX_PUBLISH_SHOT__ = scene;
          if (kind === "delivery") globalThis.__LYX_DELIVERY_SHOT__ = scene;
          if (kind === "profile") globalThis.__LYX_PROFILE_SHOT__ = scene;
          if (kind === "billing") globalThis.__LYX_BILLING_SHOT__ = scene;
          if (kind === "message") {
            globalThis.__LYX_ACCOUNT_SHOT__ =
              scene === "messages-no-store"
                ? scene
                : scene === "messages-clerk"
                  ? "mine-clerk"
                  : "mine-owner";
            globalThis.__LYX_MESSAGE_SHOT__ = scene;
          }
        },
        { scene: target.scene, kind: target.kind },
      );
      await page.route("**/*", (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        errors.push(`离线场景外发请求：${route.request().url()}`);
        return route.abort();
      });
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
    }
    await page.goto(`${origin}/#/${target.url}`, { waitUntil: "networkidle" });
    const taroPage = page.locator(".taro_page").first();
    await taroPage.waitFor({ state: "visible", timeout: 15_000 });
    if (target.scene) {
      await page
        .locator(
          target.kind === "profile"
            ? "#profile-ready"
            : target.kind === "billing"
              ? "#billing-ready"
              : target.kind === "publish"
                ? "#publish-ready"
                : target.kind === "order"
                  ? "#order-ready"
                  : target.kind === "catalog"
                    ? "#catalog-ready"
                    : target.kind === "search"
                      ? "#search-ready"
                      : target.kind === "asset"
                        ? target.scene === "asset-lib-loading"
                          ? ".asset-lib .lyx-skeleton"
                          : "#asset-ready"
                        : target.kind === "message"
                          ? target.scene === "messages-loading"
                            ? ".messages-page .lyx-skeleton"
                            : "#messages-ready"
                          : target.kind === "delivery"
                            ? "#delivery-ready"
                            : "#account-ready",
        )
        .waitFor({ state: "visible", timeout: 15_000 });
      if (target.kind === "search") await searchRegression(page, target.scene);
      if (target.kind === "asset") await assetRegression(page, target.scene, origin);
      if (target.kind === "publish" && target.scene === "accounts-bind") {
        await page.locator(".accounts-page .lyx-button").filter({ hasText: "绑定新账号" }).click();
        await page.locator(".accounts-page__form").waitFor({ state: "visible" });
      }
      if (target.kind === "message") {
        if (target.scene === "messages-loading") {
          await expect(page.locator(".messages-page .lyx-skeleton")).toBeVisible();
          await expect(page.getByText("暂无消息", { exact: true })).toHaveCount(0);
        }
        if (target.scene === "messages-error") {
          await expect(page.getByText("网络异常，请检查网络后重试", { exact: true })).toBeVisible();
          await expect(page.getByText("重新加载", { exact: true })).toBeVisible();
          await expect(page.getByText("暂无消息", { exact: true })).toHaveCount(0);
        }
        if (target.scene === "messages-category") {
          await page.locator(".lyx-filter-chips__item").filter({ hasText: "审核" }).click();
          await expect(page.locator(".messages-page__row")).toHaveCount(1);
          await expect(page.locator(".messages-page__row")).toContainText("门店审核通过");
        }
        if (target.scene === "messages-more") {
          const activePage = page.locator(".taro_page_stationed:not(.taro_page_shade)");
          const more = page
            .locator(".messages-page .lyx-button")
            .filter({ hasText: "继续查看消息" });
          const cursorCalls = () =>
            page.evaluate(() =>
              (globalThis.__LYX_MESSAGE_CALLS__ ?? []).filter((call) => {
                const url = new URL(call.path, "http://local");
                return url.pathname === "/m/messages" && url.searchParams.has("cursor");
              }),
            );
          const assertCursor = async () => {
            const calls = await cursorCalls();
            expect(calls).toHaveLength(1);
            expect(calls[0].method).toBe("GET");
            expect([...new URL(calls[0].path, origin).searchParams]).toEqual([
              ["tab", "all"],
              ["limit", "20"],
              ["cursor", "opaque+/=page2"],
            ]);
          };
          const scrollPage = async (bottom) => {
            await activePage.evaluate((node, toBottom) => {
              node.removeAttribute("data-shot-scroll");
              node.addEventListener("scroll", () => node.setAttribute("data-shot-scroll", "done"), {
                once: true,
              });
              node.scrollTo(0, toBottom ? node.scrollHeight : 0);
            }, bottom);
            await expect(activePage).toHaveAttribute("data-shot-scroll", "done");
          };
          await expect(page.locator(".messages-page__row")).toHaveCount(20);
          const height = await activePage.evaluate((node) => Math.ceil(node.scrollHeight));
          await page.setViewportSize({ width: VIEWPORT.width, height: height + VIEWPORT.height });
          await expect(more).toBeInViewport({ ratio: 1 });
          expect(await activePage.evaluate((node) => node.scrollTop)).toBe(0);
          expect(await cursorCalls()).toHaveLength(0);
          await page
            .locator(".messages-page .lyx-button")
            .filter({ hasText: "继续查看消息" })
            .click();
          await expect(page.locator(".messages-page__row")).toHaveCount(24);
          await assertCursor();
          await page.setViewportSize(VIEWPORT);
          await page.reload({ waitUntil: "networkidle" });
          await page.locator("#messages-ready").waitFor({ state: "visible", timeout: 15_000 });
          await expect(page.locator(".messages-page__row")).toHaveCount(20);
          expect(await cursorCalls()).toHaveLength(0);
          await scrollPage(true);
          await expect(page.locator(".messages-page__row")).toHaveCount(24);
          await assertCursor();
          await scrollPage(false);
          await scrollPage(true);
          await assertCursor();
          expect(page.viewportSize()).toEqual(VIEWPORT);
        }
        if (target.scene === "messages-all-read") {
          await page.locator(".messages-page__action").filter({ hasText: "全部已读" }).click();
          await expect(page.locator(".messages-page__toolbar")).toContainText("未读 0 条");
          const writes = await page.evaluate(() =>
            globalThis.__LYX_MESSAGE_CALLS__.filter((call) => call.path === "/m/messages/read"),
          );
          if (
            writes.length !== 2 ||
            writes[0].key !== writes[1].key ||
            writes[0].data.upToMessageId !== writes[1].data.upToMessageId
          )
            throw new Error("全读网络重试未保持同一边界/幂等键");
        }
        if (target.scene === "messages-empty")
          await expect(page.getByText("暂无消息", { exact: true })).toBeVisible();
        if (
          target.scene === "messages-clerk" &&
          (await page.locator(".messages-page__row").allTextContents()).some((text) =>
            text.includes("积分变动"),
          )
        )
          throw new Error("店员消息出现老板财务文案");
        if (target.scene === "messages-no-store") {
          const headers = await page.evaluate(() => globalThis.__LYX_MESSAGE_HEADERS__);
          if (!headers.length || headers.some((item) => item.storeId !== undefined))
            throw new Error("无店场景仍发送门店头");
          await expect(page.getByText("账号安全提醒", { exact: true })).toBeVisible();
        }
        if (target.scene === "messages-unavailable") {
          await page.locator(".messages-page__row").first().click();
          await expect(
            page.getByText("该内容暂不可访问，消息仍会保留", { exact: true }),
          ).toBeVisible();
          await page.locator(".messages-page__action").filter({ hasText: "订阅通知设置" }).click();
          await expect(page.getByText("暂不可用", { exact: true })).toBeVisible();
          await expect(page.locator(".lyx-sheet-popup")).toBeInViewport({ ratio: 1 });
        }
      }
      if (target.kind === "delivery") {
        if (target.scene === "plan-change") {
          await page.locator(".lyx-button").filter({ hasText: "联系服务经理修改" }).click();
          await page.locator(".lyx-sheet .lyx-chip").first().click();
          await page.locator(".lyx-sheet textarea").fill("请调整到月底上线");
          await page.waitForTimeout(350);
        }
        if (target.scene === "sample-viewed") {
          await page.locator(".lyx-button").filter({ hasText: "保存样片到相册查看" }).click();
          await page.waitForFunction(
            () =>
              !globalThis.document
                .querySelector(".lyx-checkbox")
                ?.classList.contains("lyx-checkbox--disabled"),
          );
          await page.locator(".lyx-checkbox").click();
          const calls = await page.evaluate(() => globalThis.__LYX_DELIVERY_CALLS__);
          if (
            calls.filter((c) => c.path.endsWith("/sample")).length < 2 ||
            calls.filter((c) => c.path.endsWith("/download-urls")).length !== 1
          )
            throw new Error("保存样片后没有重取查看证据");
        }
        await page.waitForTimeout(2100);
        if (target.scene === "sample-unsaved") {
          if (
            !(await page.locator(".lyx-checkbox--disabled").count()) ||
            !(await page.locator(".lyx-footer-bar .lyx-button--disabled").count())
          )
            throw new Error("未保存样片可确认");
        }
      }
      if (target.kind === "delivery") {
        if (target.scene === "tasks-submit") {
          await page.locator(".lyx-button").filter({ hasText: "回填上线链接" }).first().click();
          await page.locator(".lyx-sheet input").nth(0).fill("https://example.test/collection");
          await page.locator(".lyx-sheet input").nth(1).fill("30");
          await page.locator(".lyx-sheet input").nth(2).fill("2026-10-07");
          await page.waitForTimeout(350);
        }
        if (target.scene === "downloads-expired") {
          if ((await page.locator(".lyx-button--disabled").count()) !== 60)
            throw new Error("过期授权可保存");
        }
        if (target.scene === "downloads-default") {
          for (let n = 0; n < 2; n++) {
            await page.locator(".lyx-button").filter({ hasText: "存到相册" }).first().click();
            await page.locator(".lyx-button--loading").waitFor({ state: "hidden" });
          }
          const calls = await page.evaluate(() =>
            globalThis.__LYX_DELIVERY_CALLS__.filter((c) => c.path.endsWith("download-urls")),
          );
          if (
            calls.length !== 2 ||
            calls.some((c) => c.key || c.data?.kind !== "episode" || c.data?.episodeNo !== 1)
          )
            throw new Error("逐集保存没有每次独立签名");
          await page.waitForTimeout(2100);
        }
      }
      if (target.kind === "catalog") {
        if (target.scene === "cart-default")
          await page.locator(".cart-page__row .lyx-checkbox").first().click();
        if (target.scene === "cart-price-changed") {
          await page
            .locator(".cart-page__actions .lyx-button")
            .filter({ hasText: "确认新价格" })
            .click();
          await page.getByText("确认价格", { exact: true }).waitFor({ state: "visible" });
          await page.waitForTimeout(350);
        }

        if (target.scene === "mall-end") {
          await page.getByText("继续向下浏览", { exact: true }).click();
          await page.getByText("没有更多了", { exact: true }).scrollIntoViewIfNeeded();
        }
        if (target.scene === "mall-empty") {
          await page.getByText("暂无分类", { exact: true }).click();
          await page.getByText("没有符合条件的短剧", { exact: true }).waitFor({ state: "visible" });
        }
        if (target.scene.endsWith("clerk")) {
          const cartCalls = await page.evaluate(() =>
            Object.entries(globalThis.__LYX_CATALOG_COUNTS__ ?? {})
              .filter(([key]) => key.includes("/m/cart-items"))
              .reduce((sum, [, n]) => sum + n, 0),
          );
          if (cartCalls !== 0) throw new Error("店员场景触发了cart请求");
        }
      }
      if (target.scene.startsWith("bank-")) {
        await page.locator(".lyx-button").filter({ hasText: "对公转账" }).click();
        await page.locator(".lyx-button").filter({ hasText: "确认付款" }).click();
        await page.getByText("选择转账凭证", { exact: true }).waitFor({ state: "visible" });
        if (target.scene === "bank-selected") {
          await page.getByText("选择转账凭证", { exact: true }).click();
          await page
            .locator(".billing-receipt .lyx-button")
            .filter({ hasText: "提交转账凭证" })
            .waitFor({ state: "visible" });
          await page.waitForFunction(() => {
            const button = globalThis.document.querySelector(".billing-receipt .lyx-button");
            return button && !button.classList.contains("lyx-button--disabled");
          });
          await page.waitForTimeout(300);
        }
        await page.waitForTimeout(500);
      }
      if (target.scene.startsWith("login")) {
        await page.locator("input").fill("13800138000");
        if (target.scene === "login-checked")
          await page.getByText("我已阅读并同意", { exact: true }).click();
        else await page.locator(".lyx-button").filter({ hasText: "手机号快捷登录" }).click();
      }
      if (target.scene === "store-switch")
        await page.locator(".lyx-text-button").filter({ hasText: "切换门店" }).click();
      if (target.scene === "reconsent")
        await page.getByText("请确认更新后的协议", { exact: true }).waitFor({ state: "visible" });
      if (target.scene === "store-switch" || target.scene === "reconsent")
        await page.waitForTimeout(400);
      if (target.kind === "profile") {
        if (target.scene === "basic-normal") {
          await page.locator("input").first().fill("邻里咖啡新店");
          await page.locator(".lyx-button").filter({ hasText: "保存草稿" }).click();
          await page.locator(".lyx-button--loading").waitFor({ state: "hidden" });
          const body = await page.evaluate(
            () =>
              globalThis.__LYX_PROFILE_CALLS__.find(
                (call) => call.path === "/m/store-profile/basic" && call.method === "PATCH",
              )?.data,
          );
          if (
            body?.brandName !== "邻里咖啡新店" ||
            body?.draft !== true ||
            body?.lockVersion !== 1 ||
            body?.address?.latitude !== null ||
            body?.address?.longitude !== null ||
            body?.address?.poiName !== null ||
            body?.businessHours?.[0]?.start !== "09:00"
          )
            throw new Error("基础信息保存未按当前DTO发送");
          await taroPage.evaluate((node) => {
            node.scrollTop = 0;
          });
        }
        if (target.scene === "store-normal" || target.scene === "service-normal") {
          const media = target.scene === "store-normal";
          await page.locator(".lyx-button").filter({ hasText: "保存草稿" }).click();
          await page.locator(".lyx-button--loading").waitFor({ state: "hidden" });
          const body = await page.evaluate(
            (path) =>
              globalThis.__LYX_PROFILE_CALLS__.find(
                (call) => call.path === path && call.method === "PATCH",
              )?.data,
            media ? "/m/store-profile/media" : "/m/store-profile/service",
          );
          if (
            body?.draft !== true ||
            body?.lockVersion !== 1 ||
            (media
              ? body?.groups?.interior?.length !== 3
              : body?.serviceItems?.[0]?.priceFen !== 2800 ||
                body?.sellingPointCodes?.[0] !== "fresh")
          )
            throw new Error("建档保存未按当前DTO发送");
          await taroPage.evaluate((node) => {
            node.scrollTop = 0;
          });
        }
        if (target.scene === "cert-missing") {
          await page.locator(".lyx-checkbox").filter({ hasText: "我确认所填信息" }).click();
          await expect(
            page.locator(".lyx-checkbox").filter({ hasText: "我确认所填信息" }),
          ).toHaveClass(/lyx-checkbox--checked/);
          await page.locator(".lyx-button").filter({ hasText: "提交资质审核" }).click();
          const missing = page.getByText("请补充门店必填资料", { exact: true });
          await missing.waitFor({ state: "visible" });
          await expect(page).toHaveURL(/sub\/profile\/cert\/index/);
          await missing.scrollIntoViewIfNeeded();
        }
        if (target.scene === "review-rejected")
          await page.getByText("证照不清晰", { exact: true }).waitFor({ state: "visible" });
      }
    }
    if (target.kind === "catalog") await searchEntryRegression(page, target.scene);
    if (errors.length > 0) throw new Error(`页面报错：${errors[0]}`);
    if (target.fullPage) {
      // 页面上开着弹层时，等它的进场动画走完
      if ((await page.locator(".nut-overlay").count()) > 0) await page.waitForTimeout(500);
      // Taro 的 H5 页面在自己的容器里滚动，整页截图要先把视口撑到内容那么高
      const height = await taroPage.evaluate((node) => Math.ceil(node.scrollHeight));
      await page.setViewportSize({ width: VIEWPORT.width, height: Math.max(height, 200) });
      // 视口刚撑高，新露出来的那一段可能还没重画：并着截、机器忙的时候截到过上一屏的残影（W0-29），等一下再截
      await page.waitForTimeout(200);
    }
    const file = path.join(outDir, `${target.file}.png`);
    await page.screenshot({ path: file });
    if (target.kind === "delivery") await deliveryRegression(page, target.scene);
    if (target.kind === "order") await orderRegression(page, target.scene);
    if (target.kind === "order" && target.scene === "order-detail-producing")
      await deliveryNavigationRegression(
        page,
        path.join(outDir, "delivery__order-entry-sample.png"),
      );
    if (target.kind === "publish") await publishRegression(page, target.scene);
    if (target.kind === "catalog") {
      if (target.scene === "cart-default") {
        if (!(await page.locator(".cart-page__total").innerText()).includes("900 积分"))
          throw new Error("选择合计必须使用服务端S900");
        await page.locator(".cart-page__row .lyx-checkbox").first().click();
        if (!(await page.locator(".cart-page__total").innerText()).includes("0 积分"))
          throw new Error("复选项必须可以取消");
      }
      if (target.scene === "cart-price-changed") {
        const before = await page.evaluate(
          () => globalThis.__LYX_CATALOG_COUNTS__["GET /m/cart-items"],
        );
        await page.locator(".lyx-sheet .lyx-button").filter({ hasText: "确认价格" }).click();
        await page.getByText("网络暂时中断，请重试", { exact: true }).waitFor({ state: "visible" });
        await page.locator(".lyx-sheet .lyx-button").filter({ hasText: "确认价格" }).click();
        await page.getByText("确认新价格", { exact: true }).waitFor({ state: "hidden" });
        const result = await page.evaluate(() => ({
          calls: globalThis.__LYX_CATALOG_MUTATIONS__,
          reads: globalThis.__LYX_CATALOG_COUNTS__["GET /m/cart-items"],
        }));
        if (
          result.calls.length !== 2 ||
          result.calls[0].key !== result.calls[1].key ||
          result.calls[1].data.acceptedPricePoints !== 1200 ||
          result.reads <= before
        )
          throw new Error("P/samekey/C50重放GET验收不成立");
      }
      if (target.scene === "cart-invalid") {
        await page
          .locator(".cart-page__actions .lyx-button")
          .filter({ hasText: "移出选剧单" })
          .first()
          .click();
        await page.locator(".lyx-sheet .lyx-button").filter({ hasText: "确认移出" }).click();
        await page.getByText("已下架，请移出选剧单", { exact: true }).waitFor({ state: "hidden" });
        if ((await page.locator(".cart-page__row").count()) !== 1)
          throw new Error("真实删除后列表未刷新");
      }
      if (target.scene === "detail-owner") {
        await page.locator(".detail-page .lyx-button").filter({ hasText: "加入选剧单" }).click();
        await page.getByText("已在选剧单", { exact: true }).waitFor({ state: "visible" });
        await page.waitForFunction(
          () => globalThis.__LYX_CATALOG_COUNTS__["GET /m/cart-items"] >= 1,
        );
        await page.locator(".detail-page .lyx-button").filter({ hasText: "已在选剧单" }).click();
        await page.waitForFunction(
          () => globalThis.__LYX_CATALOG_COUNTS__["GET /m/cart-items"] >= 2,
        );
        if (
          (await page.evaluate(() => globalThis.__LYX_CATALOG_COUNTS__["POST /m/cart-items"])) !== 2
        )
          throw new Error("natural重复加入没有真实回放");
      }
      if (
        target.scene === "home-clerk" &&
        (await page.getByText("上线概览", { exact: true }).count())
      )
        throw new Error("店员首页出现owner数据");
      if (
        target.scene === "home-guest" &&
        (await page.getByText("可用积分", { exact: true }).count())
      )
        throw new Error("游客首页出现财务数据");
    }
    if (target.scene === "profile-not-started") {
      if (
        await page.evaluate(() =>
          globalThis.__LYX_PROFILE_CALLS__.some((call) => call.path === "/m/entities"),
        )
      )
        throw new Error("打开建档首页不应创建主体");
      await page.locator(".lyx-button").filter({ hasText: "开始建档" }).click();
      await page.getByText("建档完成度", { exact: true }).waitFor({ state: "visible" });
      if (
        (await page.evaluate(
          () =>
            globalThis.__LYX_PROFILE_CALLS__.filter((call) => call.path === "/m/entities").length,
        )) !== 1
      )
        throw new Error("开始建档须只创建一次");
    }
    if (target.scene === "cert-normal") {
      await profileContactRegression(page);
      await profileAuthorizationRegression(page);
      await page.locator(".lyx-checkbox:visible").filter({ hasText: "我确认所填信息" }).click();
      await expect(
        page.locator(".lyx-checkbox:visible").filter({ hasText: "我确认所填信息" }),
      ).toHaveClass(/lyx-checkbox--checked/);
      await page.locator(".lyx-button:visible").filter({ hasText: "提交资质审核" }).click();
      await page
        .getByText("信息确认已更新，请刷新后重新阅读并确认", { exact: true })
        .waitFor({ state: "visible" });
      await page.locator(".lyx-text-button").filter({ hasText: "刷新并核对" }).click();
      await page.getByText("确认版本：2", { exact: true }).waitFor({ state: "visible" });
      const submit = page.locator(".lyx-button:visible").filter({ hasText: "提交资质审核" });
      if (!(await submit.getAttribute("class"))?.includes("lyx-button--disabled"))
        throw new Error("声明更新后须重新勾选");
      await page.locator(".lyx-checkbox:visible").filter({ hasText: "我确认所填信息" }).click();
      await expect(
        page.locator(".lyx-checkbox:visible").filter({ hasText: "我确认所填信息" }),
      ).toHaveClass(/lyx-checkbox--checked/);
      await page.evaluate(() =>
        globalThis.__LYX_PROFILE_CONTROL__.authorization.failNextRedirect(),
      );
      await submit.dblclick();
      await page
        .getByText("资料已保存，页面跳转失败，请点击下方重试", { exact: true })
        .waitFor({ state: "visible" });
      await expect(page).toHaveURL(/sub\/profile\/cert\/index/);
      await page.locator(".lyx-text-button").filter({ hasText: "重新进入审核进度" }).click();
      await expect(page).toHaveURL(/sub\/profile\/review\/index/);
      await profilePageReady(page, "review");
      await page.getByText("平台审核中", { exact: true }).waitFor({ state: "visible" });
      const submitted = await page.evaluate(() =>
        globalThis.__LYX_PROFILE_CALLS__
          .filter((call) => call.path === "/m/store-profile/qualification/submit")
          .map((call) => call.data.declarationVersion),
      );
      if (JSON.stringify(submitted) !== JSON.stringify(["1", "2"]))
        throw new Error("提交没有携带本次声明版本");
      await page.evaluate(() => globalThis.__LYX_PROFILE_CONTROL__.authorization.enter());
      await profilePageReady(page, "cert");
      await profileContextRegression(page, "cert");
    }
    if (target.scene === "cert-sheet")
      await profileCertificateSheetRegression(
        page,
        path.join(outDir, "profile__cert-sheet-bottom.png"),
      );
    if (["basic-normal", "store-normal", "service-normal"].includes(target.scene))
      await profileEditRegression(page, target.scene);
    if (
      [
        "profile-missing-items",
        "service-no-points",
        "service-disabled-points",
        "cert-declaration",
      ].includes(target.scene)
    )
      await profileMissingRegression(page, target.scene);
    if (errors.length > 0) throw new Error(`页面报错：${errors[0]}`);
    console.log(`已出图 ${path.relative(appRoot, file)}`);
  } catch (error) {
    failed.push(`${target.label}：${String(error.message)}`);
  }
  await page.close();
  await isolated?.close();
}
// 一张图的时间大半花在等（等网络空闲、等动画），几页并着截；每页各用各的标签页，互不影响
const queue = [...targets];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let target = queue.shift(); target; target = queue.shift()) await shoot(target);
  }),
);
await browser.close();
server.close();
if (failed.length > 0) fail(`有页面没出图。\n  ${failed.join("\n  ")}`, 1);
console.log(
  `小程序截图：${targets.length} 张，宽 ${VIEWPORT.width}，在 apps/weapp/shots/dist/png/`,
);
