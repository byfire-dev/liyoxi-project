import { mkdirSync } from "node:fs";
import {
  AdminFileViewSchema,
  AdminStoreAssetDetailSchema,
  AdminStoreAssetSummarySchema,
} from "@liyoxi/contract";
import { expect, test, type Page } from "@playwright/test";
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

interface WriteFixture {
  storeId: string;
  staffId: string;
  reviewId: string;
  portraitId: string;
  reviewBody: {
    contentTagCodes: string[];
    usageTagCodes: string[];
    timeliness: { tagCode: string };
  };
}
const writeFixture = () =>
  (liveContext().fixtures as { fixtures: { "merchant-assets-write": WriteFixture } }).fixtures[
    "merchant-assets-write"
  ];
const changed = (page: Page, path: string) =>
  page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).pathname === `/api/v1/admin/${path}`,
  );
async function actualAsset(page: Page, id: string) {
  const response = await page.request.get(`/api/v1/admin/store-assets/${id}`);
  expect(response.status()).toBe(200);
  return AdminStoreAssetDetailSchema.parse((await response.json()).data);
}
async function write(page: Page, path: string, data: unknown) {
  return page.request.post(`/api/v1/admin/${path}`, {
    headers: {
      Origin: liveContext().origin,
      "X-LYX-Admin": "1",
      "Idempotency-Key": `w318:${crypto.randomUUID()}`,
    },
    data,
  });
}
async function select(page: Page, label: string, option: string) {
  await page.getByRole("dialog").getByRole("combobox", { name: label, exact: true }).click();
  await page.locator(".ant-select-dropdown:visible").getByTitle(option, { exact: true }).click();
  await page.keyboard.press("Escape");
}
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.screenshot({ path: `dist/e2e-shots/${name}.png`, animations: "disabled" });
}
const tinyPng = (name: string) => ({
  name,
  mimeType: "image/png",
  // 有效的虚构 1px PNG，只测试字节上传/入库/引用，不声明肖像材料真实有效。
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
});
async function actualFile(page: Page, id: string) {
  const response = await page.request.get(`/api/v1/admin/files/${id}`);
  expect(response.status()).toBe(200);
  return AdminFileViewSchema.parse((await response.json()).data);
}
async function confirmAsset(
  page: Page,
  title: string,
  path: string,
  checkLabel = "我已核对当前素材、版本和操作",
) {
  await page.getByRole("button", { name: "保存并核对", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  const submit = dialog.getByRole("button", { name: "确认", exact: true });
  await expect(submit).toBeDisabled();
  await dialog.getByRole("checkbox", { name: checkLabel, exact: true }).check();
  const response = changed(page, path);
  await submit.click();
  return response;
}

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

test("W318 整理使用所见版本：真实冲突回读、重新填写、重识别与原因删除", async ({ page }) => {
  const f = writeFixture(),
    errors = recordErrors(page);
  await page.goto(`/merchants/${f.storeId}?tab=assets`);
  const row = page.locator(`tr[data-row-key="${f.reviewId}"]`);
  await row.click();
  const original = await actualAsset(page, f.reviewId);
  expect(original.processingState).toBe("processed");
  expect(original.adminStatus).toBe("organizing");
  await page.getByRole("button", { name: "整理素材", exact: true }).click();
  await select(page, "内容标签", "W318虚构content");
  await select(page, "用途标签", "W318虚构usage");
  await select(page, "时效标签", "W318虚构timeliness");
  await page
    .getByRole("textbox", { name: "素材标题（选填）", exact: true })
    .fill("这份旧编辑不能覆盖并行修改");

  // 第二个真实 HTTP 客户端先落库；不拦截或伪造 409 响应。
  const concurrent = await write(page, `store-assets/${f.reviewId}/review`, {
    ...f.reviewBody,
    lockVersion: original.lockVersion,
    usability: "reference_only",
    title: "并行修改的服务端标题",
  });
  expect(concurrent.status()).toBe(200);
  const conflict = await confirmAsset(page, "整理素材", `store-assets/${f.reviewId}/review`);
  expect(conflict.status()).toBe(409);
  await expect(page.getByText(/当前事实已变化/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await actualAsset(page, f.reviewId)).title).toBe("并行修改的服务端标题");
  await shot(page, "merchant-assets-version-conflict");

  await page.getByRole("button", { name: "整理素材", exact: true }).click();
  await page
    .getByRole("textbox", { name: "素材标题（选填）", exact: true })
    .fill("人工核对后的虚构素材");
  const reviewed = await confirmAsset(page, "整理素材", `store-assets/${f.reviewId}/review`);
  expect(reviewed.status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const actual = await actualAsset(page, f.reviewId);
  expect(actual).toMatchObject({
    title: "人工核对后的虚构素材",
    adminStatus: "organized",
    usability: "reference_only",
    lockVersion: original.lockVersion + 2,
  });
  expect(actual.contentTags.some((tag) => tag.source === "reviewer" && tag.isConfirmed)).toBe(true);
  await shot(page, "merchant-assets-manual-review");

  await page.getByRole("button", { name: "重新识别", exact: true }).click();
  const reprocessed = await confirmAsset(page, "重新识别", `store-assets/${f.reviewId}/reprocess`);
  expect(reprocessed.status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await actualAsset(page, f.reviewId)).processingState).not.toBe("processed");
  await page.getByRole("button", { name: "删除素材", exact: true }).click();
  await page
    .getByRole("textbox", { name: "删除原因（必填）", exact: true })
    .fill("本轮虚构资料验收结束");
  const deleted = await confirmAsset(page, "删除素材", `store-assets/${f.reviewId}/delete`);
  expect(deleted.status()).toBe(200);
  await expect(row).toHaveCount(0);
  expect((await page.request.get(`/api/v1/admin/store-assets/${f.reviewId}`)).status()).toBe(404);
  expect(
    errors.filter(
      (message) =>
        !/^Failed to load resource: the server responded with a status of 409 /u.test(message),
    ),
  ).toEqual([]);
});

test("W318 真实小文件代传与肖像补交：入库后引用，显式确认才授权", async ({ page }) => {
  const f = writeFixture(),
    errors = recordErrors(page);
  await page.goto(`/merchants/${f.storeId}?tab=assets`);
  await page.getByRole("button", { name: "代传素材", exact: true }).click();
  await select(page, "素材类型", "图片");
  let registered = changed(page, "files");
  await page
    .getByRole("dialog", { name: "代传素材", exact: true })
    .locator('input[type="file"]')
    .setInputFiles(tinyPng("w318-fictional-store.png"));
  const registration = await registered;
  expect(registration.status()).toBe(200);
  const fileId: string = (await registration.json()).data.fileId;
  await expect.poll(async () => (await actualFile(page, fileId)).status).toBe("stored");
  expect(await actualFile(page, fileId)).toMatchObject({
    category: "store_asset",
    storeId: f.storeId,
    uploader: { actorId: f.staffId, actorType: "staff", client: "admin" },
  });
  await expect(page.getByRole("button", { name: "重新上传（替换）", exact: true })).toBeVisible();
  const created = await confirmAsset(page, "代传素材", "store-assets");
  expect(created.status()).toBe(200);
  const assetId: string = (await created.json()).data.storeAssetId;
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await actualAsset(page, assetId)).files.map((file) => file.fileId)).toContain(fileId);

  await page.locator(`tr[data-row-key="${f.portraitId}"]`).click();
  const before = await actualAsset(page, f.portraitId);
  expect(before.portraitAuth).toMatchObject({ fileCount: 0, authorizedAt: null });
  await page.getByRole("button", { name: "补交肖像材料", exact: true }).click();
  registered = changed(page, "files");
  await page
    .getByRole("dialog", { name: "补交肖像材料", exact: true })
    .locator('input[type="file"]')
    .setInputFiles(tinyPng("w318-fictional-portrait.png"));
  const portraitRegistration = await registered;
  expect(portraitRegistration.status()).toBe(200);
  const portraitFileId: string = (await portraitRegistration.json()).data.fileId;
  await expect.poll(async () => (await actualFile(page, portraitFileId)).status).toBe("stored");
  expect(await actualFile(page, portraitFileId)).toMatchObject({
    category: "portrait_auth",
    storeId: f.storeId,
    uploader: { actorId: f.staffId },
  });
  await expect(page.getByRole("button", { name: "重新上传（替换）", exact: true })).toBeVisible();
  const submitted = await confirmAsset(
    page,
    "补交肖像材料",
    `store-assets/${f.portraitId}/portrait-auth`,
  );
  expect(submitted.status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const supplemented = await actualAsset(page, f.portraitId);
  expect(supplemented.usability).toBe("need_portrait_auth");
  expect(supplemented.portraitAuth).toMatchObject({ fileCount: 1, authorizedAt: null });
  expect(supplemented.portraitAuthFileIds).toContain(portraitFileId);
  await shot(page, "merchant-assets-portrait-awaiting-confirmation");
  await page.getByRole("button", { name: "确认肖像授权", exact: true }).click();
  await page
    .getByRole("textbox", { name: "授权核验备注（选填）", exact: true })
    .fill("仅虚构材料流程验收");
  const confirmed = await confirmAsset(
    page,
    "确认肖像授权",
    `store-assets/${f.portraitId}/confirm-portrait-auth`,
  );
  expect(confirmed.status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const authorized = await actualAsset(page, f.portraitId);
  expect(authorized.usability).toBe("reference_only");
  expect(authorized.portraitAuth.authorizedAt).not.toBeNull();
  expect(authorized.lockVersion).toBe(supplemented.lockVersion + 1);
  await shot(page, "merchant-assets-portrait-confirmed");
  expect(errors).toEqual([]);
});

test("W318 真实需求创建、响应计数、完成和撤销均回读服务端", async ({ page }) => {
  const f = writeFixture(),
    errors = recordErrors(page);
  const demandCheck = "我已核对当前需求和操作";
  await page.goto(`/merchants/${f.storeId}?tab=assets`);
  const createDemand = async (title: string) => {
    await page.getByRole("button", { name: "发起素材需求", exact: true }).click();
    await page.getByRole("textbox", { name: "需求名称", exact: true }).fill(title);
    await page
      .getByRole("textbox", { name: "拍摄说明（选填）", exact: true })
      .fill("本轮虚构门店素材演练");
    await page
      .getByLabel("完成日期（北京时间）", { exact: true })
      .fill(new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10));
    const response = await confirmAsset(page, "发起素材需求", "asset-demands", demandCheck);
    expect(response.status()).toBe(200);
    const demand = (await response.json()).data as {
      assetDemandId: string;
      storeId: string;
      status: string;
      receivedCount: number;
    };
    expect(demand).toMatchObject({ storeId: f.storeId, status: "open", receivedCount: 0 });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    return demand.assetDemandId;
  };
  const id = await createDemand("W318虚构店内日常");
  const row = page.locator(`tr[data-row-key="${id}"]`);
  await row.getByRole("button", { name: "响应需求代传", exact: true }).click();
  await page
    .getByRole("textbox", { name: "素材正文", exact: true })
    .fill("响应本轮真实需求的虚构文字说明");
  const uploaded = await confirmAsset(page, "代传素材", "store-assets");
  expect(uploaded.status()).toBe(200);
  const assetId: string = (await uploaded.json()).data.storeAssetId;
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect((await actualAsset(page, assetId)).assetDemandId).toBe(id);
  await expect(row).toContainText("进行中 · 1 条");
  await row.getByRole("button", { name: "完成素材需求", exact: true }).click();
  const completed = await confirmAsset(
    page,
    "完成素材需求",
    `asset-demands/${id}/complete`,
    demandCheck,
  );
  expect(completed.status()).toBe(200);
  expect((await completed.json()).data).toMatchObject({
    assetDemandId: id,
    status: "done",
    receivedCount: 1,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(row).toContainText("已完成 · 1 条");
  await expect(row.getByRole("button", { name: "完成素材需求", exact: true })).toHaveCount(0);

  const canceledId = await createDemand("W318虚构撤销需求");
  const canceledRow = page.locator(`tr[data-row-key="${canceledId}"]`);
  await canceledRow.getByRole("button", { name: "撤销素材需求", exact: true }).click();
  await page
    .getByRole("textbox", { name: "撤销原因（选填）", exact: true })
    .fill("虚构需求计划调整");
  const canceled = await confirmAsset(
    page,
    "撤销素材需求",
    `asset-demands/${canceledId}/cancel`,
    demandCheck,
  );
  expect(canceled.status()).toBe(200);
  expect((await canceled.json()).data).toMatchObject({
    assetDemandId: canceledId,
    status: "canceled",
    receivedCount: 0,
  });
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(canceledRow).toContainText("已撤销 · 0 条");
  await page.reload();
  await expect(row).toContainText("已完成 · 1 条");
  await expect(canceledRow).toContainText("已撤销 · 0 条");
  await shot(page, "merchant-assets-demand-results");
  expect(errors).toEqual([]);
});
