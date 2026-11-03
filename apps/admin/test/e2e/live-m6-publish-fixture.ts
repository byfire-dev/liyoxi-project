import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  expect,
  type APIRequestContext,
  type ConsoleMessage,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  DeliveryTicketDetailSchema,
  PublishListAdminViewSchema,
  LaunchCalendarSchema,
  LaunchTrackPageSchema,
  LaunchSubmissionDetailSchema,
} from "@liyoxi/contract";
import { liveContext, noHorizontalScroll } from "./live-context";
import { liveChildEnv, liveChildFailure } from "./live-child-env";
export interface W608Fixture {
  scope: {
    runId: string;
    entityId: string;
    storeId: string;
    orderId: string;
    itemId: string;
    ticketId: string;
    dramaId: string;
    planId: string;
    managerId: string;
    posterFileId: string;
    accountIds: [string, string];
    foreign: { entityId: string; storeId: string; accountId: string };
  };
  ticketNo: string;
  orderNo: string;
  storeName: string;
  title: string;
  launchDate: string;
  deliveryDate: string;
  accounts: { id: string; name: string; platform: string }[];
  foreignAccount: { id: string; name: string; platform: string };
  viewer: {
    staffId: string;
    name: string;
    phone: string;
    password: string;
    recoveryCodes: string[];
  };
  ownerHeaders: Record<string, string>;
}
export function w608Fixture() {
  const f = (liveContext().fixtures as { fixtures: { w608: W608Fixture } }).fixtures.w608;
  if (!f?.scope?.ticketId || f.scope.accountIds.length !== 2)
    throw new Error("W608 requires its current-run fixture");
  return f;
}
export const adminHeaders = () => ({
  "X-LYX-Admin": "1",
  Origin: liveContext().origin,
  "X-Client-Version": "1.0.0",
});
export async function read(request: APIRequestContext, path: string, headers = adminHeaders()) {
  const result = await request.get(path, { headers });
  expect(result.status(), path).toBe(200);
  return (await result.json()).data;
}
export async function write(
  request: APIRequestContext,
  path: string,
  body: unknown,
  method: "post" | "put" = "post",
  headers: Record<string, string> = adminHeaders(),
) {
  const result = await request[method](path, {
    data: body,
    headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
  });
  expect(result.status(), path).toBe(200);
  return (await result.json()).data;
}
export const ticket = async (request: APIRequestContext) =>
  DeliveryTicketDetailSchema.parse(
    await read(request, `/api/v1/admin/delivery-tickets/${w608Fixture().scope.ticketId}`),
  );
export const publishList = async (request: APIRequestContext) =>
  PublishListAdminViewSchema.parse(
    await read(
      request,
      `/api/v1/admin/delivery-tickets/${w608Fixture().scope.ticketId}/publish-list`,
    ),
  );
export const launchCalendar = async (request: APIRequestContext, from: string, to: string) =>
  LaunchCalendarSchema.parse(
    await read(
      request,
      `/api/v1/admin/launch-calendar?from=${from}&to=${to}&managerId=${w608Fixture().scope.managerId}`,
    ),
  );
export const tracks = async (request: APIRequestContext) =>
  LaunchTrackPageSchema.parse(
    await read(
      request,
      `/api/v1/admin/launch-tasks?tab=all&orderItemId=${w608Fixture().scope.itemId}&page=1&pageSize=20`,
    ),
  );
export const submission = async (request: APIRequestContext, id: string) =>
  LaunchSubmissionDetailSchema.parse(await read(request, `/api/v1/admin/launch-submissions/${id}`));
export async function checklist(request: APIRequestContext, code: string) {
  const result = await read(
    request,
    `/api/v1/admin/checklist-templates?code=${code}&status=active`,
  );
  const template = result.items.find((item: { code: string }) => item.code === code);
  expect(template).toBeTruthy();
  return {
    checklistVersionNo: template.versionNo as number,
    results: (template.items as { key: string }[]).map(({ key }) => ({
      key,
      result: "pass" as const,
    })),
  };
}
export type W608Action =
  | "upload_sample"
  | "finish_sample"
  | "confirm_sample"
  | "upload_final"
  | "finish_final"
  | "inspect_package"
  | "observe_zip"
  | "run_zip"
  | "fail_next_zip";
export async function control(request: APIRequestContext, action: W608Action) {
  const response = await request.post("/api/v1/__test/w608/control", {
    data: { action },
    headers: adminHeaders(),
  });
  expect(response.status(), action).toBe(200);
  return (await response.json()).data;
}
export function documents(action: "render" | "cleanup-docs"): Promise<Record<string, unknown>> {
  const context = process.env.LYX_ADMIN_LIVE_CONTEXT;
  if (!context) throw new Error("W608 requires the current-run context");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "--silent",
        "--filter",
        "@liyoxi/services",
        "exec",
        "tsx",
        "scripts/admin-live-w608.ts",
        "--context",
        context,
        "--action",
        action,
      ],
      {
        cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
        env: {
          ...liveChildEnv([
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "SHELL",
            "TMPDIR",
            "TMP",
            "TEMP",
            "LANG",
            "LC_ALL",
            "CI",
            "PNPM_HOME",
          ]),
          APP_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      error = "";
    child.stdout.on("data", (bytes) => {
      output = `${output}${bytes}`.slice(-16384);
    });
    child.stderr.on("data", (bytes) => {
      error = `${error}${bytes}`.slice(-4096);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const failure = liveChildFailure("W608本轮文书桥失败", error);
        for (const line of error.split("\n")) {
          try {
            const record = JSON.parse(line);
            if (
              record.evt === "w608.bridge.failed" &&
              /^[a-z_]+$/.test(record.phase) &&
              /^[A-Z_]+$/.test(record.symbol)
            )
              failure.message += `（${record.phase}:${record.symbol}）`;
          } catch {
            /* Only fixed safe diagnostics, never raw subprocess output. */
          }
        }
        reject(failure);
        return;
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error("W608文书桥未返回明确回执"));
      }
    });
  });
}
export async function shot(page: Page, name: string, focus?: Locator) {
  await noHorizontalScroll(page, name);
  await page.setViewportSize({ width: 1440, height: 900 });
  try {
    await page.evaluate(async () => {
      window.scrollTo({ top: 0, left: 0 });
      document.querySelector("main")?.scrollTo({ top: 0, left: 0 });
      await document.fonts.ready;
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
    });
    if (focus) await focus.scrollIntoViewIfNeeded();
    mkdirSync("dist/e2e-shots", { recursive: true });
    const deadline = Date.now() + 10_000;
    let pair = 0,
      stable: Buffer | undefined;
    await expect
      .poll(
        async () => {
          const first = await page.screenshot({
            path: `dist/e2e-shots/${name}-pair-first.png`,
            animations: "disabled",
            timeout: Math.max(1, deadline - Date.now()),
          });
          await page.evaluate(
            () => new Promise<void>((done) => requestAnimationFrame(() => done())),
          );
          const second = await page.screenshot({
            path: `dist/e2e-shots/${name}-pair-second.png`,
            animations: "disabled",
            timeout: Math.max(1, deadline - Date.now()),
          });
          if (++pair === 1) {
            writeFileSync(`dist/e2e-shots/${name}-initial-first.png`, first);
            writeFileSync(`dist/e2e-shots/${name}-initial-second.png`, second);
          }
          if (!second.equals(first)) return false;
          stable = second;
          return true;
        },
        { timeout: 10_000, intervals: [100], message: `${name}两帧稳定` },
      )
      .toBe(true);
    if (!stable) throw new Error("W608未取得两帧一致截图");
    writeFileSync(`dist/e2e-shots/${name}.png`, stable);
  } finally {
    await page.setViewportSize({ width: 1366, height: 768 });
  }
}
/** Consume exactly the expected browser resource error, keeping every unrelated error fatal. */
export async function expectedResourceError(
  page: Page,
  errors: string[],
  status: 400 | 409,
  action: () => Promise<void>,
) {
  const records: { text: string; url: string }[] = [];
  const listener = (message: ConsoleMessage) => {
    if (message.type() === "error")
      records.push({ text: message.text(), url: message.location().url });
  };
  page.on("console", listener);
  try {
    const response = page.waitForResponse(
      (r) =>
        r.request().method() !== "GET" &&
        r.status() === status &&
        new URL(r.url()).pathname.includes("/publish-list"),
    );
    await action();
    const rejected = await response;
    const text = `Failed to load resource: the server responded with a status of ${status} (${status === 400 ? "Bad Request" : "Conflict"})`;
    await expect.poll(() => records).toEqual([{ text, url: rejected.url() }]);
    expect(errors).toEqual([text]);
    errors.splice(0, 1);
    return rejected;
  } finally {
    page.off("console", listener);
  }
}

/** Native fetch keeps temporary test passwords/recovery codes outside Playwright traces. */
async function fixtureLogin(source: "viewer" | "publisher", expectedStaffId?: string) {
  const path = process.env.LYX_ADMIN_LIVE_CONTEXT;
  if (!path) throw new Error("W608 requires the current-run context");
  const context = JSON.parse(readFileSync(path, "utf8")),
    actor = (
      source === "viewer"
        ? context.fixtures.fixtures.w608.viewer
        : context.fixtures.fixtures.w513.publisher
    ) as W608Fixture["viewer"] & { roleKey?: string };
  if (
    !actor ||
    (source === "publisher" && (actor.roleKey !== "publisher" || actor.staffId !== expectedStaffId))
  )
    throw new Error("W608 existing publisher differs from the real ticket assignee");
  const code = actor.recoveryCodes.shift();
  if (!code) throw new Error(`W608 ${source} has no unused recovery code`);
  chmodSync(path, 0o600);
  writeFileSync(path, `${JSON.stringify(context)}\n`, { mode: 0o600 });
  const cookies = new Map<string, string>(),
    origin = liveContext().origin;
  const send = async (suffix: string, data: unknown) => {
    const response = await fetch(`${origin}/api/v1/admin/auth/${suffix}`, {
      method: "POST",
      headers: {
        ...adminHeaders(),
        "Content-Type": "application/json",
        Cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
      },
      body: JSON.stringify(data),
    });
    if (response.status !== 200)
      throw new Error(`W608 ${source} login failed: HTTP ${response.status}`);
    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0]!,
        at = pair.indexOf("=");
      cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return (await response.json()).data;
  };
  const first = await send("login", { phone: actor.phone, password: actor.password });
  if (first.next !== "mfa" || !first.ticket)
    throw new Error(`W608 ${source} login did not require the real second factor`);
  await send("verify-mfa", { ticket: first.ticket, method: "recovery", code });
  return {
    staffId: actor.staffId,
    cookies: [...cookies].map(([name, value]) => ({
      name,
      value,
      domain: new URL(origin).hostname,
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: origin.startsWith("https:"),
      sameSite: "Lax" as const,
    })),
  };
}
export const viewerLogin = () => fixtureLogin("viewer");
export const publisherLogin = (expectedStaffId: string) =>
  fixtureLogin("publisher", expectedStaffId);
