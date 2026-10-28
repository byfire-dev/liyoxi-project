import { mkdirSync, writeFileSync } from "node:fs";
import { expect, type Page } from "@playwright/test";
import { liveContext, noHorizontalScroll } from "./live-context";
export interface ReconFixture {
  prefix: string;
  entityId: string;
  entityName: string;
  paymentOrderId: string;
  orderNo: string;
  amountFen: number;
  receivedAt: string;
  payerName: string;
  bankSerialNo: string;
  note: string;
}
export const reconcileFixture = () =>
  (liveContext().fixtures as { fixtures: { "w418-reconcile": ReconFixture } }).fixtures[
    "w418-reconcile"
  ];
export async function readFinance(page: Page, path: string): Promise<unknown> {
  const response = await page.request.get(`/api/v1/admin${path}`);
  expect(response.status(), path).toBe(200);
  return (await response.json()).data as unknown;
}
export async function reconcileShot(page: Page, name: string, detail = true) {
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelector('[data-testid="shell-content"]')?.scrollTo(0, 0);
  });
  await noHorizontalScroll(page, name);
  await page.setViewportSize({ width: 1440, height: 900 });
  if (detail)
    await page.evaluate(() =>
      document
        .querySelector('[aria-label="差异详情与处理"] h2')
        ?.scrollIntoView({ block: "start" }),
    );
  mkdirSync("dist/e2e-shots", { recursive: true });
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
  try {
    await expect.poll(geometry).toEqual({
      width: 1440,
      height: 900,
      shells: 1,
      siders: 1,
      headers: 1,
      top: 0,
      shellHeight: 900,
    });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
    });
    writeFileSync(
      `dist/e2e-shots/w418-reconcile-${name}.geometry.json`,
      `${JSON.stringify(await geometry())}\n`,
    );
    await page.screenshot({
      path: `dist/e2e-shots/w418-reconcile-${name}.png`,
      animations: "disabled",
    });
  } finally {
    await page.setViewportSize({ width: 1366, height: 768 });
  }
}
