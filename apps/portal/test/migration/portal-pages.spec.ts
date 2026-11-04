import { readFile } from "node:fs/promises";
import type { Download, Page } from "@playwright/test";
import {
  DRAMA_TITLE,
  FILE_CONTENT,
  ITEM_ID,
  NEXT_TITLE,
  POLL_SECRET,
  STORE_NAME,
} from "./fixtures";
import { expect, test } from "./portal-mock";

async function downloaded(download: Download, fileName: string) {
  expect(download.suggestedFilename()).toBe(fileName);
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(path).not.toBeNull();
  expect(await readFile(path!, "utf8")).toBe(FILE_CONTENT);
}
async function clickDownload(page: Page, name: string) {
  const event = page.waitForEvent("download");
  await page.getByRole("button", { name, exact: true }).click();
  return event;
}
async function noPrivateContent(page: Page) {
  await expect(page.getByRole("button", { name: "退出电脑授权", exact: true })).toHaveCount(0);
  await expect(page.getByText(`当前门店：${STORE_NAME}`, { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: `《${DRAMA_TITLE}》`, exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "下载第 1 集", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "返回首页", exact: true })).toBeVisible();
}

test("扫码页面经交换后回读会话，再进入正式契约的可下载列表", async ({ page, portal }, info) => {
  await page.goto("/");
  await expect(page.getByText("8 位登录码：ABCDEFGH", { exact: true })).toBeVisible();
  await expect(page.getByText("确认数字：42", { exact: true })).toBeVisible();
  expect(portal.sequence).toEqual(["session:anonymous", "ticket:create"]);
  expect(await page.locator("html").innerHTML()).not.toContain(POLL_SECRET);
  expect(page.url()).not.toContain(POLL_SECRET);
  const storage = await page.evaluate(() => ({
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));
  expect(storage).toEqual({ local: {}, session: {} });
  await page.screenshot({ path: info.outputPath("contract-login.png"), fullPage: true });

  portal.approved = true;
  await expect(page).toHaveURL(/\/items$/);
  await expect(page.getByRole("heading", { name: "我的成片", exact: true })).toBeVisible();
  await expect(page.getByText(`当前门店：${STORE_NAME}`, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: `《${DRAMA_TITLE}》`, exact: true }),
  ).toBeVisible();
  const exchange = portal.sequence.indexOf("exchange"),
    firstItems = portal.sequence.indexOf("items");
  expect(exchange).toBeGreaterThan(0);
  expect(firstItems).toBeGreaterThan(exchange);
  expect(portal.sequence.slice(exchange + 1, firstItems)).toContain("session:authorized");
  expect(
    await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
  ).toEqual({ local: {}, session: {} });
});

test("列表游标翻页与详情展示使用正式字段，不混入样片", async ({ page, portal }, info) => {
  portal.authenticated = true;
  await page.goto("/items");
  await expect(
    page.getByRole("heading", { name: `《${DRAMA_TITLE}》`, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "加载更多成片", exact: true }).click();
  await expect(page.getByRole("heading", { name: `《${NEXT_TITLE}》`, exact: true })).toBeVisible();
  expect(portal.listQueries).toEqual([
    { tab: "all", limit: 20 },
    { tab: "all", limit: 20, cursor: "migration-page-2" },
  ]);
  await expect(page.getByRole("button", { name: "加载更多成片", exact: true })).toHaveCount(0);
  await expect(page.getByText("该门店暂无待确认广告", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("contract-items.png"), fullPage: true });
  await page.getByRole("link", { name: "查看成片与下载", exact: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/items/${ITEM_ID}$`));
  await expect(
    page.getByRole("heading", { name: `《${DRAMA_TITLE}》`, exact: true }),
  ).toBeVisible();
  await expect(page.getByText("第 2 版 · 2 集", { exact: true })).toBeVisible();
  await expect(page.getByText("本次更新", { exact: true })).toBeVisible();
  await expect(page.getByText("40.0 MB", { exact: true })).toBeVisible();
  await expect(page.locator("pre")).toHaveText(portal.fixtures.publishList.text!);
  await expect(page.getByRole("link", { name: /样片/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("contract-release-detail.png"), fullPage: true });
});

test("单集、异步ZIP和发布清单触发真实浏览器下载事件", async ({ page, context, portal }) => {
  portal.authenticated = true;
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(`/items/${ITEM_ID}`);
  await expect(page.getByRole("button", { name: "下载第 1 集", exact: true })).toBeVisible();
  await downloaded(await clickDownload(page, "下载第 1 集"), "migration-episode-1.mp4");
  expect(portal.downloads[0]).toEqual({ kind: "episode", episodeNo: 1 });

  const zipDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载整包 ZIP", exact: true }).click();
  await expect(
    page.getByText("正在打包，约需几分钟；您也可以先逐集下载。", { exact: true }),
  ).toBeVisible();
  await downloaded(await zipDownload, "migration-package.zip");
  expect(portal.downloads.filter((entry) => entry.kind === "zip")).toEqual([
    { kind: "zip", retry: false },
    { kind: "zip", retry: false },
  ]);

  await downloaded(await clickDownload(page, "下载清单文本"), "migration-publish-list.txt");
  expect(portal.downloads.at(-1)).toEqual({ kind: "publish_list" });
  await page.getByRole("button", { name: "复制发布清单", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(portal.fixtures.publishList.text);
});

test("只有用户在ZIP失败后重试才发送retry true", async ({ page, portal }) => {
  portal.authenticated = true;
  portal.zipStates = ["failed", "ready"];
  await page.goto(`/items/${ITEM_ID}`);
  await page.getByRole("button", { name: "下载整包 ZIP", exact: true }).click();
  await expect(page.getByText("打包失败，请重试或逐集下载。", { exact: true })).toBeVisible();
  expect(portal.downloads).toEqual([{ kind: "zip", retry: false }]);
  await downloaded(await clickDownload(page, "重新打包下载"), "migration-package.zip");
  expect(portal.downloads).toEqual([
    { kind: "zip", retry: false },
    { kind: "zip", retry: true },
  ]);
});

test("清单文件未就绪时只下载当前清单文本，不自动创建ZIP", async ({ page, portal }) => {
  portal.authenticated = true;
  portal.publishFileState = "none";
  await page.goto(`/items/${ITEM_ID}`);
  await expect(page.locator("pre")).toHaveText(portal.fixtures.publishList.text!);
  const download = await clickDownload(page, "下载清单文本");
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  expect(await readFile(path!, "utf8")).toBe(portal.fixtures.publishList.text);
  expect(portal.downloads).toEqual([{ kind: "publish_list" }]);
});

for (const action of ["release", "episode", "zip"] as const) {
  test(`退出授权后丢弃迟到的${action}响应，不恢复私有内容或下载`, async ({ page, portal }) => {
    portal.authenticated = true;
    if (action === "zip") await page.clock.install();
    const held = portal.holdNext(action);
    let downloadEvents = 0;
    page.on("download", () => {
      downloadEvents += 1;
    });
    await page.goto(`/items/${ITEM_ID}`);
    if (action !== "release") {
      await page
        .getByRole("button", {
          name: action === "episode" ? "下载第 1 集" : "下载整包 ZIP",
          exact: true,
        })
        .click();
    }
    await held.requested;
    const cancelled = page.waitForEvent("requestfailed", {
      predicate: (request) =>
        new URL(request.url()).pathname.endsWith(
          action === "release" ? "/release" : "/download-urls",
        ),
    });
    await page.getByRole("button", { name: "退出电脑授权", exact: true }).click();
    await noPrivateContent(page);
    await cancelled;
    held.release();
    await held.completed;
    if (action === "zip") await page.clock.fastForward(6000);
    // The real abortable fetch and scope generation must keep the old leaf disposed.
    await noPrivateContent(page);
    expect(downloadEvents).toBe(0);
    expect(portal.sequence).toContain("logout");
    expect(portal.downloads).toHaveLength(action === "release" ? 0 : 1);
  });
}
