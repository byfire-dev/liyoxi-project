import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { FinanceConfigViewSchema, adminPage } from "@liyoxi/contract";
import { liveContext, noHorizontalScroll } from "./live-context";

interface Fixture {
  bankId: string;
  approvalId: string;
  requesterStaffId: string;
  baselineBankId: string;
  changeNote: string;
  last4: string;
  selfApprovalRejected: boolean;
  entityIds: string[];
}
export const settingsFixture = () =>
  (liveContext().fixtures as { fixtures: { "w418-settings": Fixture } }).fixtures["w418-settings"];
export async function readConfig(page: Page, id: string) {
  const response = await page.request.get(
    `/api/v1/admin/finance-config-revisions?tab=history&financeConfigRevisionId=${id}&page=1&pageSize=20`,
  );
  expect(response.status()).toBe(200);
  const data = adminPage(FinanceConfigViewSchema).parse((await response.json()).data);
  expect(data.total).toBe(1);
  expect(data.items).toHaveLength(1);
  expect(data.items[0]!.financeConfigRevisionId).toBe(id);
  return data.items[0]!;
}
export async function settingsShot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole("heading", { name: "受控财务配置", exact: true }).scrollIntoViewIfNeeded();
  const geometry = () =>
    page.evaluate(() => {
      const shell = document.querySelector(".lyx-shell")?.getBoundingClientRect();
      return {
        width: innerWidth,
        height: innerHeight,
        shells: document.querySelectorAll(".lyx-shell").length,
        siders: document.querySelectorAll(".lyx-shell__sider").length,
        headers: document.querySelectorAll(".lyx-shell__header").length,
        top: shell?.top,
        shellHeight: shell?.height,
      };
    });
  const expected = {
    width: 1440,
    height: 900,
    shells: 1,
    siders: 1,
    headers: 1,
    top: 0,
    shellHeight: 900,
  };
  await expect.poll(geometry).toEqual(expected);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  const observed = await geometry();
  expect(observed).toEqual(expected);
  mkdirSync("dist/e2e-shots", { recursive: true });
  writeFileSync(`dist/e2e-shots/${name}.geometry.json`, `${JSON.stringify(observed)}\n`);
  await page.screenshot({ path: `dist/e2e-shots/${name}.png`, animations: "disabled" });
  await page.setViewportSize({ width: 1366, height: 768 });
}
