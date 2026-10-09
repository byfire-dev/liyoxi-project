import { expect, test, type Page } from "@playwright/test";
import type { components } from "@liyoxi/contract/types/admin";
import { createAdminApi } from "../../src/lib/api";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { api, shot, totp, write } from "./w206-helpers";

type Role = components["schemas"]["RoleDetail"];
const roleBody = (role: Role) => ({
  moduleLevels: role.moduleLevels,
  actions: role.actions,
  dataScope: role.dataScope,
  lockVersion: role.lockVersion,
});

// These fictional credentials travel through native fetch, outside Playwright traces/screenshots.
async function createIdentity(page: Page, roleKey: "publisher" | "editor", index: number) {
  const origin = liveContext().origin;
  const administratorCookie = (await page.context().cookies(origin))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const cookies = new Map<string, string>();
  const client = (administrator = false) =>
    createAdminApi({
      baseUrl: origin,
      build: "w216-permissions",
      fetch: async (request) => {
        request.headers.set("Origin", origin);
        request.headers.set(
          "Cookie",
          administrator
            ? administratorCookie
            : [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        );
        const response = await fetch(request);
        if (!administrator)
          for (const value of response.headers.getSetCookie()) {
            const pair = value.split(";")[0]!,
              at = pair.indexOf("=");
            cookies.set(pair.slice(0, at), pair.slice(at + 1));
          }
        return response;
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
  const phone = `1880000216${index}`,
    password = "Liyoxi-2026-agreements";
  const created = await client(true).POST("/api/v1/admin/staff", {
    body: {
      name: `协议权限演练${index}`,
      phone,
      roleKey,
      isLead: false,
      activateNow: true,
      activationDelivery: "manual",
      inviteWecom: false,
    },
    headers: { "Idempotency-Key": `w216-permission-create-${index}` },
  });
  expect(created.response.status).toBe(200);
  const staffId = created.data!.data.staff.staffId,
    activationCode = created.data!.data.activation?.activationCode;
  expect(activationCode).toBeTruthy();
  const auth = client();
  const activated = await auth.POST("/api/v1/admin/auth/activate", {
    body: { phone, activationCode: activationCode! },
  });
  expect(activated.response.status).toBe(200);
  const passwordSet = await auth.POST("/api/v1/admin/auth/set-password", {
    body: { ticket: activated.data!.data.ticket!, newPassword: password },
  });
  expect(passwordSet.response.status).toBe(200);
  const enrolled = await auth.POST("/api/v1/admin/auth/enroll-totp", {
    body: { ticket: passwordSet.data!.data.ticket! },
  });
  expect(enrolled.response.status).toBe(200);
  const confirmed = await auth.POST("/api/v1/admin/auth/confirm-totp", {
    body: { ticket: enrolled.data!.data.ticket, code: totp(enrolled.data!.data.secret) },
  });
  expect(confirmed.response.status).toBe(200);
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

/** Register after every original staff count/assertion. No initial fixture adds employees. */
export function registerAgreementPermissionsTest() {
  test("W216 真实ops查看/无权限身份：页面只读及直接写403，finally恢复原角色", async ({
    browser,
    page: administrator,
  }) => {
    const original = await api<Role>(administrator, "/roles/publisher");
    try {
      await write(administrator, "/roles/publisher", "PUT", {
        ...roleBody(original),
        moduleLevels: { ...original.moduleLevels, ops: "v" },
      });
      for (const [roleKey, index] of [
        ["publisher", 1],
        ["editor", 2],
      ] as const) {
        const identity = await createIdentity(administrator, roleKey, index);
        const context = await browser.newContext({
          baseURL: liveContext().origin,
          viewport: { width: 1366, height: 768 },
          storageState: { cookies: identity.cookies, origins: [] },
          locale: "zh-CN",
          timezoneId: "Asia/Shanghai",
        });
        try {
          const page = await context.newPage(),
            errors = recordErrors(page);
          await page.goto("/ops/agreements?agreementKey=custom_license");
          if (roleKey === "publisher") {
            await expect(
              page.getByText("当前为只读权限，可查看协议与脱敏签署证据", { exact: true }),
            ).toBeVisible();
            for (const name of ["新建草稿", "编辑草稿", "编辑", "安排", "撤回"])
              await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
            await page.getByRole("tab", { name: "同意记录", exact: true }).click();
            await expect(
              page.getByRole("region", { name: "协议同意记录", exact: true }).getByRole("table"),
            ).toBeVisible();
            await shot(page, "agreements-09-readonly");
          } else
            await expect(
              page.getByRole("heading", { name: "没有访问权限", exact: true }),
            ).toBeVisible();
          const denied = await page.request.post(
            "/api/v1/admin/agreements/custom_license/agreement-versions",
            {
              headers: {
                Origin: liveContext().origin,
                "X-LYX-Admin": "1",
                "Idempotency-Key": `w216-denied-${index}`,
              },
              data: { bumpMajor: false, isLegalApproved: false },
            },
          );
          expect(denied.status()).toBe(403);
          expect((await denied.json()).error).toBe("PERMISSION_DENIED");
          await noHorizontalScroll(page, `协议权限${roleKey}`);
          expect(errors).toEqual([]);
        } finally {
          await context.close();
        }
      }
    } finally {
      const current = await api<Role>(administrator, "/roles/publisher");
      await write(administrator, "/roles/publisher", "PUT", {
        ...roleBody(original),
        lockVersion: current.lockVersion,
      });
      const restored = await api<Role>(administrator, "/roles/publisher");
      expect(roleBody(restored)).toEqual({
        ...roleBody(original),
        lockVersion: restored.lockVersion,
      });
    }
  });
}
