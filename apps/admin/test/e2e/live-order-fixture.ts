import { mkdirSync } from "node:fs";
import type { Page } from "@playwright/test";
import { liveContext, noHorizontalScroll } from "./live-context";
export interface OrderFixture {
  orders: { id: string; orderNo: string; name: string; status: string; ticketId: string | null }[];
  accounts: { id: string; name: string; storeName: string; fileId: string }[];
  manager: { id: string; name: string; phone: string; password: string; recoveryCode: string };
}
export function orderFixture(): OrderFixture {
  return (liveContext().fixtures as { fixtures: Record<string, OrderFixture> }).fixtures[
    "z-order-ticket"
  ]!;
}
export async function orderShot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: `dist/e2e-shots/${name}.png`, animations: "disabled" });
  await page.setViewportSize({ width: 1366, height: 768 });
}
export function accountFixtureImage(url: URL, ids: readonly string[]) {
  return ids.some(
    (id) =>
      (url.origin === "http://127.0.0.1:9100" &&
        url.pathname === `/lyx-local-asset/test/${id}.jpg`) ||
      (url.origin === "https://fake-storage.invalid" && url.pathname === `/asset/test/${id}.jpg`),
  );
}
