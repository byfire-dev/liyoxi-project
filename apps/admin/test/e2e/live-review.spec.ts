import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";

interface Fixture {
  submissions: {
    submissionId: string;
    storeId: string;
    name: string;
    docId?: string;
    fileId?: string;
    headers: Record<string, string>;
    incomplete: boolean;
  }[];
}
function fixtureImage(url: URL, fileId: string) {
  return (
    (url.origin === "http://127.0.0.1:9100" &&
      url.pathname === `/lyx-local-secure/test/${fileId}.jpg`) ||
    (url.origin === "https://fake-storage.invalid" && url.pathname === `/secure/test/${fileId}.jpg`)
  );
}
async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `dist/e2e-shots/${name}.png`, animations: "disabled" });
  await page.setViewportSize({ width: 1366, height: 768 });
}
test("真实首店校验与资质审核：通过自动选下一条、驳回必选原因、队列为空", async ({ page }) => {
  const fixture = (liveContext().fixtures as { fixtures: { qualification: Fixture } }).fixtures
    .qualification;
  const [first, second, incomplete] = fixture.submissions;
  if (!first || !second || !incomplete) throw new Error("资质演练数据缺失");
  if (!first.fileId) throw new Error("资质演练原图缺失");
  for (const originAndBucket of [
    "http://127.0.0.1:9100/lyx-local-secure",
    "https://fake-storage.invalid/secure",
  ]) {
    expect(
      fixtureImage(new URL(`${originAndBucket}/test/${first.fileId}.jpg?token=fake`), first.fileId),
    ).toBe(true);
    expect(
      fixtureImage(new URL(`${originAndBucket}/test/${second.fileId}.jpg`), first.fileId),
    ).toBe(false);
  }
  expect(
    fixtureImage(new URL(`https://other.invalid/secure/test/${first.fileId}.jpg`), first.fileId),
  ).toBe(false);
  expect(
    fixtureImage(
      new URL(`https://fake-storage.invalid/other/test/${first.fileId}.jpg`),
      first.fileId,
    ),
  ).toBe(false);
  const submit = async (item: Fixture["submissions"][number], version: string) =>
    page.request.post("/api/v1/m/store-profile/qualification/submit", {
      headers: {
        ...item.headers,
        "Idempotency-Key": `review-live-${item.submissionId}-${version}`,
      },
      data: {
        qualificationSubmissionId: item.submissionId,
        declarationConfirmed: true,
        declarationVersion: version,
      },
    });
  const missing = await submit(incomplete, "1");
  expect(missing.status()).toBe(409);
  expect(await missing.json()).toMatchObject({
    error: "STORE_PROFILE_INCOMPLETE",
    details: { missing: expect.arrayContaining([expect.objectContaining({ step: 1 })]) },
  });
  const stale = await submit(second, "old");
  expect(stale.status()).toBe(400);
  expect(await stale.json()).toMatchObject({ error: "DECLARATION_REQUIRED" });
  expect((await submit(second, "1")).status()).toBe(200);
  const errors = recordErrors(page);
  // 仅已登记的 fake / 公开 Compose 地址与本 fixture 对象回演练图，/api 全部走真实进程。
  await page.route(
    (url) => fixtureImage(url, first.fileId!),
    (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="220" height="260"><rect width="220" height="260" fill="white"/><text x="24" y="70" font-size="22">演练营业执照</text><text x="24" y="115" font-size="14">仅用于本地接口验收</text></svg>',
      }),
  );
  let signatures = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.endsWith("/download-urls")) signatures++;
  });
  await page.goto("/merchants/review");
  await expect(page.getByRole("heading", { name: "资质审核", exact: true })).toBeVisible();
  const queue = page.locator("[data-queue-item]");
  await expect(queue).toHaveCount(2);
  await queue.filter({ hasText: first.name }).click();
  await expect(page).toHaveURL(/id=/);
  await expect(page.getByRole("heading", { name: first.name, exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "证照人工核对" })).toContainText(
    `${first.name}演练主体`,
  );
  await expect(page.getByRole("button", { name: "查看原图", exact: true })).toBeVisible();
  expect(signatures).toBe(0);
  await page.getByRole("button", { name: "查看原图", exact: true }).click();
  const original = page.getByRole("img", { name: "营业执照原图", exact: true });
  await expect(original).toBeVisible();
  expect(signatures).toBe(1);
  await page.getByRole("button", { name: "查看原图", exact: true }).click();
  await expect.poll(() => signatures).toBe(2);
  await expect(page.getByRole("button", { name: "查看原图", exact: true })).not.toHaveClass(
    /ant-btn-loading/,
  );
  await expect
    .poll(() => original.evaluate((element) => (element as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  await shot(page, "review-01-queue-detail");
  const approve = page.getByRole("button", { name: "审核通过", exact: true });
  for (const checkbox of await page.locator(".lyx-checklist").getByRole("checkbox").all())
    await checkbox.check();
  await approve.click();
  await expect(queue).toHaveCount(1);
  await expect(page.getByRole("heading", { name: second.name, exact: true })).toBeVisible();
  const merchant = await page.request.get("/api/v1/m/store-profile/qualification", {
    headers: first.headers,
  });
  expect(merchant.status()).toBe(200);
  expect((await merchant.json()).data.storeQualificationStatus).toBe("verified");
  await page.getByRole("button", { name: "驳回", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "驳回资质审核", exact: true });
  const reject = dialog.getByRole("button", { name: "确认驳回", exact: true });
  await expect(reject).toBeDisabled();
  await dialog
    .getByRole("textbox", { name: "驳回说明", exact: true })
    .fill("营业执照图片模糊，请重新上传清晰原图");
  await expect(reject).toBeDisabled();
  await dialog.getByRole("radio", { name: "证照模糊", exact: true }).check();
  await dialog.getByRole("checkbox", { name: "营业执照", exact: true }).check();
  await expect(reject).toBeEnabled();
  await shot(page, "review-02-reject");
  await reject.click();
  await expect(dialog).toHaveCount(0);
  await expect(queue).toHaveCount(0);
  await expect(page.getByText("暂无待审核资质", { exact: true })).toBeVisible();
  await shot(page, "review-03-empty");
  const rejected = await page.request.get("/api/v1/m/store-profile/qualification", {
    headers: second.headers,
  });
  expect((await rejected.json()).data.storeQualificationStatus).toBe("rejected");
  const query = page.getByRole("searchbox", { name: "门店名称", exact: true });
  await query.fill("不存在的演练门店");
  await query.press("Enter");
  await expect(page).toHaveURL(/q=/);
  await expect(page.getByText("没有符合条件的事项", { exact: true })).toBeVisible();
  await noHorizontalScroll(page, "资质搜索无结果");
  expect(signatures).toBe(2);
  expect(errors).toEqual([]);
});
