import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { createAdminApi } from "../../src/lib/api";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
type Fixture = {
  timers: { timerId: string }[];
  outbox: { outboxEventId: string; subscriber: string }[];
  webhooks: { webhookEventId: string }[];
};
const fixture = () => (liveContext().fixtures as { fixtures: { w223: Fixture } }).fixtures.w223;
function totp(secret: string) {
  let bits = "";
  for (const character of secret.toUpperCase().replaceAll("=", "")) {
    const value = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(character);
    if (value < 0) throw new Error("假TOTP格式错误");
    bits += value.toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2))),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest(),
    index = digest[digest.length - 1]! & 15;
  return String((digest.readUInt32BE(index) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}
// typed中央客户端使用原生Node fetch；假手机号/activation/TOTP/密码都不进入Playwright步骤或trace。
async function createReadonly(page: Page) {
  const origin = liveContext().origin,
    administratorCookie = (await page.context().cookies(origin))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  const cookies = new Map<string, string>();
  const client = (administrator = false) =>
    createAdminApi({
      baseUrl: origin,
      build: "w223-readonly",
      fetch: async (request) => {
        request.headers.set("Origin", origin);
        request.headers.set(
          "Cookie",
          administrator
            ? administratorCookie
            : [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        );
        const result = await fetch(request);
        if (!administrator)
          for (const value of result.headers.getSetCookie()) {
            const pair = value.split(";")[0]!,
              at = pair.indexOf("=");
            cookies.set(pair.slice(0, at), pair.slice(at + 1));
          }
        return result;
      },
      handlers: {
        redirectToLogin() {},
        stepUp: async () => false,
        refreshAccess() {},
        invalidateQueries() {},
        notify() {},
        showBlocked() {},
        buildMismatch() {},
      },
    }).client;
  const phone = "18800002231",
    password = "Liyoxi-2026-ok",
    created = await client(true).POST("/api/v1/admin/staff", {
      body: {
        name: "流程只读财务",
        phone,
        roleKey: "finance",
        isLead: false,
        activateNow: true,
        activationDelivery: "manual",
        inviteWecom: false,
      },
      headers: { "Idempotency-Key": "w223-readonly-create" },
    });
  expect(created.response.status).toBe(200);
  const staffId = created.data!.data.staff.staffId,
    activationCode = created.data!.data.activation?.activationCode;
  expect(Boolean(activationCode)).toBe(true);
  const auth = client(),
    activated = await auth.POST("/api/v1/admin/auth/activate", {
      body: { phone, activationCode: activationCode! },
    });
  expect(activated.response.status).toBe(200);
  const set = await auth.POST("/api/v1/admin/auth/set-password", {
    body: { ticket: activated.data!.data.ticket!, newPassword: password },
  });
  expect(set.response.status).toBe(200);
  const enrolled = await auth.POST("/api/v1/admin/auth/enroll-totp", {
    body: { ticket: set.data!.data.ticket! },
  });
  expect(enrolled.response.status).toBe(200);
  const confirmed = await auth.POST("/api/v1/admin/auth/confirm-totp", {
    body: { ticket: enrolled.data!.data.ticket, code: totp(enrolled.data!.data.secret) },
  });
  expect(confirmed.response.status).toBe(200);
  // session为本轮fake配置/真实auth结果，销毁context后原runner负责整个专属库清理。
  return {
    staffId,
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
export function registerFlowOpsReadonlyTest() {
  test("W223 finance真实system只读直接入口，无四写按钮且API拒绝", async ({
    browser,
    page: administrator,
  }) => {
    const readonly = await createReadonly(administrator),
      context = await browser.newContext({
        baseURL: liveContext().origin,
        storageState: { cookies: readonly.cookies, origins: [] },
        viewport: { width: 1366, height: 768 },
        locale: "zh-CN",
        timezoneId: "Asia/Shanghai",
      });
    try {
      const page = await context.newPage(),
        errors = recordErrors(page);
      await page.goto("/sys/flow-ops");
      await expect(page.getByRole("heading", { name: "流程运维", exact: true })).toBeVisible();
      const meResponse = await page.request.get("/api/v1/admin/auth/me"),
        me = (await meResponse.json()).data;
      expect(me.staff.staffId).toBe(readonly.staffId);
      expect(me.moduleLevels.system).toBe("v");
      expect(me.permissions).not.toContain("flow.ops.manage");
      for (const tab of ["失败的定时器", "死信投递", "回调收件箱"]) {
        await page.getByRole("tab", { name: tab, exact: true }).click();
        await expect(page.getByRole("table")).toBeVisible();
        for (const name of ["重新排期", "标记为不再需要", "重投死信", "重置死信回调"])
          await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
      }
      const item = fixture(),
        headers = { Origin: liveContext().origin, "X-LYX-Admin": "1" };
      for (const [path, data] of [
        [`timers/${item.timers[3]!.timerId}/reschedule`, {}],
        [`timers/${item.timers[3]!.timerId}/cancel`, { reason: "只读用户不能取消" }],
        [
          `outbox-events/${item.outbox[3]!.outboxEventId}/retry`,
          { subscriber: item.outbox[3]!.subscriber },
        ],
        [`webhook-events/${item.webhooks[3]!.webhookEventId}/retry`, {}],
      ] as const) {
        const denied = await page.request.post(`/api/v1/admin/${path}`, {
          headers: {
            ...headers,
            "Idempotency-Key": `w223-readonly-${path.split("/")[0]}-${path.split("/").at(-1)}`,
          },
          data,
        });
        expect(denied.status()).toBe(403);
        expect((await denied.json()).error).toBe("PERMISSION_DENIED");
      }
      await noHorizontalScroll(page, "只读流程运维");
      mkdirSync("dist/e2e-shots", { recursive: true });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({
        path: "dist/e2e-shots/flow-ops-06-readonly.png",
        animations: "disabled",
      });
      await page.setViewportSize({ width: 1366, height: 768 });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
}
