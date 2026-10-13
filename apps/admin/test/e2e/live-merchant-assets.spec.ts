import { mkdirSync } from "node:fs";
import { AdminStoreAssetDetailSchema, AdminStoreAssetSummarySchema } from "@liyoxi/contract";
import { expect, test } from "@playwright/test";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";

interface Fixture {
  storeId: string;
  storeName: string | null;
  otherStoreId: string;
  text: { storeAssetId: string; textBody: string };
  secondId: string;
  foreignId: string;
  document: { storeAssetId: string; fileId: string };
}
const fixture = () =>
  (liveContext().fixtures as { fixtures: { "merchant-assets-read": Fixture } }).fixtures[
    "merchant-assets-read"
  ];

test("W318 素材只读页真实筛选与详情、缺少机器结果、文件现签和外店选择隔离", async ({ page }) => {
  const f = fixture();
  const errors = recordErrors(page);
  const requests: { method: string; path: string; storeId: string | null }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/v1/admin/store-assets"))
      requests.push({
        method: request.method(),
        path: url.pathname,
        storeId: url.searchParams.get("storeId"),
      });
  });
  const row = (id: string) => page.locator(`tr[data-row-key="${id}"]`);
  const route = `/merchants/${f.storeId}?tab=assets`;
  await page.goto(route);
  await expect(page.getByRole("tab", { name: "门店素材", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(row(f.text.storeAssetId)).toBeVisible();
  await expect(row(f.secondId)).toBeVisible();
  await expect(row(f.document.storeAssetId)).toBeVisible();
  await expect(row(f.foreignId)).toHaveCount(0);
  const summaryResponse = await page.request.get(
    `/api/v1/admin/store-assets/summary?storeId=${f.storeId}`,
  );
  expect(summaryResponse.status()).toBe(200);
  expect(summaryResponse.headers()["cache-control"]).toBe("no-store");
  expect(AdminStoreAssetSummarySchema.parse((await summaryResponse.json()).data).tabs).toEqual({
    all: 3,
    organizing: 3,
    adopted: 0,
  });
  await row(f.text.storeAssetId).click();
  const detail = page.getByRole("region", { name: "素材详情", exact: true });
  await expect(detail).toContainText(f.text.textBody);
  await expect(detail).toContainText("机器识别（仅供参考）");
  await expect(detail).toContainText("人工整理与授权事实");
  const getText = await page.request.get(`/api/v1/admin/store-assets/${f.text.storeAssetId}`);
  expect(getText.status()).toBe(200);
  const actual = AdminStoreAssetDetailSchema.parse((await getText.json()).data);
  expect(actual.storeId).toBe(f.storeId);
  expect(actual.suggestion).toBeNull();
  expect(actual.reviewedAt).toBeNull();
  expect(actual.portraitAuth.authorizedAt).toBeNull();
  await noHorizontalScroll(page, "W318素材只读详情");
  mkdirSync("dist/e2e-shots", { recursive: true });
  await detail.screenshot({
    path: "dist/e2e-shots/merchant-assets-read-text.png",
    animations: "disabled",
  });

  // 同域筛选来自真实查询，刷新继续保留；不以本地过滤冒充服务端数量。
  await page.goto(`${route}&type=text`);
  await expect(row(f.text.storeAssetId)).toBeVisible();
  await expect(row(f.document.storeAssetId)).toHaveCount(0);
  await page.reload();
  await expect(page).toHaveURL(/type=text/);
  await expect(row(f.secondId)).toBeVisible();
  const filtered = await page.request.get(
    `/api/v1/admin/store-assets/summary?storeId=${f.storeId}&type=text`,
  );
  expect(filtered.status()).toBe(200);
  expect(AdminStoreAssetSummarySchema.parse((await filtered.json()).data).tabs.all).toBe(2);

  // 即使后台员工可见其他店，当前页也不能由任意URL资产ID触发跨店详情/现签。
  const beforeForeign = requests.length;
  await page.goto(`${route}&assetId=${f.foreignId}`);
  await expect(row(f.text.storeAssetId)).toBeVisible();
  await expect(page.getByRole("region", { name: "素材详情", exact: true })).toHaveCount(0);
  expect(requests.slice(beforeForeign).some((r) => r.path.endsWith(`/${f.foreignId}`))).toBe(false);

  const fileReady = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      new URL(r.url()).pathname === `/api/v1/admin/store-assets/${f.document.storeAssetId}`,
  );
  await row(f.document.storeAssetId).click();
  const fileResponse = await fileReady;
  expect(fileResponse.status()).toBe(200);
  expect(fileResponse.headers()["cache-control"]).toBe("no-store");
  const document = AdminStoreAssetDetailSchema.parse((await fileResponse.json()).data);
  expect(document.storeId).toBe(f.storeId);
  expect(document.files.map((file) => file.fileId)).toContain(f.document.fileId);
  const signed = document.files.find((file) => file.fileId === f.document.fileId)!;
  expect(signed.kind).toBe("document");
  expect(signed.url).toMatch(/^https?:\/\//);
  expect(Date.parse(signed.expiresAt!)).toBeGreaterThan(Date.now());
  const links = () =>
    detail
      .locator("a[href]")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
  await expect.poll(links).toContain(signed.url);
  const refresh = page.waitForResponse(
    (r) =>
      r.request().method() === "GET" &&
      new URL(r.url()).pathname === `/api/v1/admin/store-assets/${f.document.storeAssetId}`,
  );
  await page.getByRole("button", { name: "刷新素材详情", exact: true }).click();
  const refreshedResponse = await refresh;
  expect(refreshedResponse.status()).toBe(200);
  const renewed = AdminStoreAssetDetailSchema.parse(
    (await refreshedResponse.json()).data,
  ).files.find((file) => file.fileId === f.document.fileId)!;
  await expect.poll(links).toContain(renewed.url);
  await noHorizontalScroll(page, "W318素材文件事实");
  await detail.screenshot({
    path: "dist/e2e-shots/merchant-assets-read-file.png",
    animations: "disabled",
  });
  expect(requests.filter((r) => r.method !== "GET")).toEqual([]);
  expect(requests.filter((r) => r.storeId !== null).every((r) => r.storeId === f.storeId)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
