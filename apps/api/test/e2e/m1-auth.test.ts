import { expect, it, vi } from "vitest";
import { staff } from "@liyoxi/services";
import { createClock } from "@liyoxi/services/testing";
import { loginM1Staff } from "./m1-auth.js";
import type { M1Api, M1RequestInit } from "./in-process.js";

const identity = {
  staffId: "01900000-0000-7000-8000-000000000001",
  phone: "19900000101",
  password: "fixture-password",
  secret: "JBSWY3DPEHPK3PXP",
  recoveryCodes: [],
};
const start = new Date("2026-10-18T04:00:02.000Z");
const step = staff.totpStep(start);
function fixture(lastStep: number | null) {
  const clock = createClock(start),
    readStaffTotpStep = vi.fn(async () => lastStep),
    waitUntil = vi.fn(async (at: Date) => clock.set(at)),
    waitForNextMfaStep = vi.fn(async () => clock.advance(30_000)),
    requests: { path: string; init: M1RequestInit | undefined }[] = [];
  const support: Pick<M1Api["support"], "clock" | "readStaffTotpStep"> = {
    clock,
    readStaffTotpStep,
  };
  const api: M1Api = {
    support: support as M1Api["support"],
    waitUntil,
    waitForNextMfaStep,
    async request(path, init) {
      requests.push({ path, init });
      if (path.endsWith("/login")) return Response.json({ data: { ticket: "fixture-ticket" } });
      return Response.json(
        { data: { staff: { staffId: identity.staffId } } },
        { headers: path.endsWith("/verify-mfa") ? { "set-cookie": "staff=fresh; HttpOnly" } : {} },
      );
    },
  };
  return { api, clock, readStaffTotpStep, waitUntil, waitForNextMfaStep, requests };
}

it.each([null, step - 1])(
  "HTTP 重登当前 TOTP 步未消费（%s）不空等，仍调用完整认证请求链",
  async (lastStep) => {
    const f = fixture(lastStep);
    const signedIn = await loginM1Staff(f.api, identity);
    expect(f.readStaffTotpStep).toHaveBeenCalledWith(identity.staffId);
    expect(f.waitUntil).not.toHaveBeenCalled();
    expect(f.waitForNextMfaStep).not.toHaveBeenCalled();
    expect(f.clock.now()).toEqual(start);
    expect(f.requests.map((row) => row.path)).toEqual([
      "/api/v1/admin/auth/login",
      "/api/v1/admin/auth/verify-mfa",
      "/api/v1/admin/auth/me",
    ]);
    expect(f.requests[1]?.init?.json).toEqual({
      ticket: "fixture-ticket",
      method: "totp",
      code: staff.hotp(staff.base32Decode(identity.secret), step),
    });
    expect(signedIn.headers.cookie).toBe("staff=fresh");
    expect(f.requests[2]?.init?.headers?.cookie).toBe("staff=fresh");
  },
);

it("HTTP 重登只在已消费步等待真实下一步，不提前生成未来码", async () => {
  const f = fixture(step);
  await loginM1Staff(f.api, identity);
  expect(f.waitUntil).toHaveBeenCalledExactlyOnceWith(new Date((step + 1) * 30_000));
  expect(f.waitForNextMfaStep).not.toHaveBeenCalled();
  expect(f.requests[1]?.init?.json).toMatchObject({
    code: staff.hotp(staff.base32Decode(identity.secret), step + 1),
  });
});

it("已用步查询和真实等待失败均原样中止，不能继续发 MFA 请求", async () => {
  const read = fixture(step),
    queryError = new Error("owned-read-failed");
  read.readStaffTotpStep.mockRejectedValue(queryError);
  await expect(loginM1Staff(read.api, identity)).rejects.toBe(queryError);
  expect(read.requests).toHaveLength(1);
  const wait = fixture(step),
    cancelled = new DOMException("cancelled", "AbortError");
  wait.waitUntil.mockRejectedValue(cancelled);
  await expect(loginM1Staff(wait.api, identity)).rejects.toBe(cancelled);
  expect(wait.requests).toHaveLength(1);
});

it("非 HTTP 的原可拨时钟重登保持原行为", async () => {
  const f = fixture(step);
  delete (f.api as { waitUntil?: M1Api["waitUntil"] }).waitUntil;
  delete (f.api as { waitForNextMfaStep?: M1Api["waitForNextMfaStep"] }).waitForNextMfaStep;
  await loginM1Staff(f.api, identity);
  expect(f.readStaffTotpStep).not.toHaveBeenCalled();
  expect(f.clock.now().getTime()).toBe(start.getTime() + 30_000);
});
