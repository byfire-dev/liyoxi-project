import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, type Page, type Response } from "@playwright/test";
import { liveContext, noHorizontalScroll } from "./live-context";

interface Staff {
  id: string;
  name: string;
  staffNo: number;
  roleKey: string;
}
export interface W206Fixture {
  admin: Staff;
  editor: Staff & { phone: string };
  cs: Staff;
  recipient: Staff;
  manager: Staff;
  followId: string;
  approvals: { id: string; kind: string }[];
}
export const w206 = () =>
  (liveContext().fixtures as { fixtures: { w206: W206Fixture } }).fixtures.w206;
// Synthetic client sources through the existing trusted loopback proxy; not physical IPs.
export const w206ClientSources = {
  roles: "192.0.2.206",
  safety: "198.51.100.206",
  activation: "203.0.113.206",
} as const;
export const clientSourceHeaders = (source: keyof typeof w206ClientSources) => ({
  "X-Forwarded-For": w206ClientSources[source],
});
export function recordExpectedConflictErrors(page: Page) {
  const errors: { message: string; url?: string }[] = [];
  let expected: Response | undefined;
  page.on("pageerror", (error) => errors.push({ message: error.message }));
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push({ message: message.text(), url: message.location().url });
  });
  return {
    allow(response: Response, path: string) {
      expect(expected).toBeUndefined();
      expect(response.request().method()).toBe("PATCH");
      expect(response.url()).toBe(`${liveContext().origin}${path}`);
      expect(response.status()).toBe(409);
      expected = response;
    },
    unexpected() {
      expect(expected).toBeDefined();
      let matches = 0;
      const remaining = errors.filter((error) => {
        const matchesResponse =
          error.url === expected!.url() &&
          error.message ===
            "Failed to load resource: the server responded with a status of 409 (Conflict)";
        if (matchesResponse) matches++;
        return !matchesResponse;
      });
      expect(matches).toBe(1);
      return remaining.map((error) => error.message);
    },
  };
}
export async function api<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(`/api/v1/admin${path}`);
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
export async function write<T>(
  page: Page,
  path: string,
  method: "POST" | "PUT" | "PATCH",
  data: unknown,
): Promise<T> {
  const response = await page.request.fetch(`/api/v1/admin${path}`, {
    method,
    data,
    headers: {
      Origin: liveContext().origin,
      "X-LYX-Admin": "1",
      "Idempotency-Key": `w206:${crypto.randomUUID()}`,
    },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()) as { data: T }).data;
}
export async function select(page: Page, label: string, value: string) {
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.locator(".ant-select-dropdown:visible").getByTitle(value, { exact: true }).click();
}
export async function openStaff(page: Page, name: string) {
  await page.goto(`/sys/staff?q=${encodeURIComponent(name)}`);
  await page
    .getByRole("row")
    .filter({ hasText: name })
    .getByRole("button", { name: "查看 / 操作", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "员工详情", exact: true })).toContainText(name);
}
export async function confirm(page: Page, title: string, staffNo?: number) {
  const dialog = page.getByRole("dialog", { name: title, exact: true });
  await dialog.getByRole("checkbox", { name: "我已核对员工与操作影响", exact: true }).check();
  if (staffNo !== undefined)
    await dialog
      .getByRole("textbox", { name: "请输入员工工号确认", exact: true })
      .fill(String(staffNo));
  await dialog.getByRole("button", { name: "确认", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
export async function shot(page: Page, name: string) {
  await noHorizontalScroll(page, name);
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: `dist/e2e-shots/${name}.png`,
    animations: "disabled",
    mask: [
      page.locator(".lyx-staff-activation"),
      page.locator(".ant-qrcode"),
      page.getByRole("textbox", { name: "手输密钥", exact: true }),
      page.locator(".lyx-recovery-codes"),
    ],
  });
  await page.setViewportSize({ width: 1366, height: 768 });
}
export function totp(secret: string) {
  let bits = "";
  for (const character of secret) {
    const n = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
    if (n < 0) throw new Error("演练密钥不是Base32");
    bits += n.toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((value) => parseInt(value, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest(),
    offset = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
