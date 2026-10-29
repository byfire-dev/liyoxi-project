import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { InvoiceRequestAdminDetailSchema } from "@liyoxi/contract";
import { liveContext, noHorizontalScroll } from "./live-context";
interface Fixture {
  pending: { id: string; requestNo: string };
  reject: { id: string; requestNo: string };
  red: { id: string; requestNo: string };
  pdf: string;
  rejectReason: string;
  requesterStaffId: string;
  reviewerStaffId: string;
}
export const fixture = () =>
  (liveContext().fixtures as { fixtures: { w418: { invoices: Fixture } } }).fixtures.w418.invoices;
export async function read(page: Page, id: string) {
  const response = await page.request.get(`/api/v1/admin/invoice-requests/${id}`);
  expect(response.status()).toBe(200);
  return InvoiceRequestAdminDetailSchema.parse((await response.json()).data);
}
export async function confirm(page: Page, name: string, path: string) {
  const dialog = page.getByRole("dialog", { name, exact: true });
  await dialog
    .getByRole("checkbox", { name: "我已核对当前申请、发票信息和处理内容", exact: true })
    .check();
  const written = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === path,
  );
  await dialog.getByRole("button", { name: `确认${name}`, exact: true }).click();
  expect((await written).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
}
export async function shot(page: Page, file: string) {
  if ((await page.getByRole("dialog").count()) === 0)
    await page.getByRole("heading", { name: "发票管理", exact: true }).scrollIntoViewIfNeeded();
  await noHorizontalScroll(page, file);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  const geometry = await page.evaluate(() => {
    const box = document.querySelector(".lyx-shell")?.getBoundingClientRect();
    return {
      width: innerWidth,
      height: innerHeight,
      shells: document.querySelectorAll(".lyx-shell").length,
      siders: document.querySelectorAll(".lyx-shell__sider").length,
      headers: document.querySelectorAll(".lyx-shell__header").length,
      top: box?.top,
      shellHeight: box?.height,
    };
  });
  expect(geometry).toEqual({
    width: 1440,
    height: 900,
    shells: 1,
    siders: 1,
    headers: 1,
    top: 0,
    shellHeight: 900,
  });
  mkdirSync("dist/e2e-shots", { recursive: true });
  writeFileSync(`dist/e2e-shots/${file}.geometry.json`, `${JSON.stringify(geometry)}\n`);
  await page.screenshot({ path: `dist/e2e-shots/${file}.png`, animations: "disabled" });
  await page.setViewportSize({ width: 1366, height: 768 });
}
