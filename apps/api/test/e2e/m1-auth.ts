// 真实激活、口令、TOTP、再次登录与 MFA；秘密只在本轮内存中。
import { randomBytes } from "node:crypto";
import { staff } from "@liyoxi/services";
import type { StaffMe } from "@liyoxi/contract";
import { m1Data } from "./in-process.js";
import type { M1Api } from "./in-process.js";

export interface M1AuthenticatedStaff {
  readonly staffId: string;
  readonly phone: string;
  readonly password: string;
  readonly secret: string;
  readonly recoveryCodes: readonly string[];
  readonly headers: Readonly<Record<string, string>>;
}
const WRITE = { "X-LYX-Admin": "1", origin: "http://admin.localhost" };
const cookieOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0]!)
    .join("; ");
const codeNow = (secret: string, api: M1Api) =>
  staff.hotp(staff.base32Decode(secret), staff.totpStep(api.support.clock.now()));
export async function activateM1Staff(
  api: M1Api,
  input: { phone: string; activationCode: string; staffId?: string; relogin?: boolean },
): Promise<M1AuthenticatedStaff> {
  const post = (path: string, json: unknown, cookie = "") =>
    api.request(`/api/v1/admin/auth/${path}`, {
      method: "POST",
      json,
      headers: { ...WRITE, ...(cookie ? { cookie } : {}) },
    });
  const activated = await m1Data<{ ticket: string }>(
    await post("activate", { phone: input.phone, activationCode: input.activationCode }),
    "激活员工",
  );
  const password = `Lyx-${randomBytes(18).toString("hex")}!A7`;
  const set = await m1Data<{ ticket: string }>(
    await post("set-password", { ticket: activated.ticket, newPassword: password }),
    "设置临时口令",
  );
  const enroll = await m1Data<{ ticket: string; secret: string }>(
    await post("enroll-totp", { ticket: set.ticket }),
    "绑定动态口令",
  );
  const confirmation = await post("confirm-totp", {
    ticket: enroll.ticket,
    code: codeNow(enroll.secret, api),
  });
  const confirmed = await m1Data<{ me: StaffMe; recoveryCodes: string[] }>(
    confirmation,
    "确认动态口令",
  );
  let signedIn = confirmed.me;
  let cookie = cookieOf(confirmation);
  if (input.relogin) {
    // 首管理员验证登录主路径。第二员工用真实 confirm-totp 已签发的会话，避免重复登录耗掉同 IP 配额。
    if (api.waitForNextMfaStep) await api.waitForNextMfaStep();
    else api.support.clock.advance(30_000);
    const login = await m1Data<{ ticket: string }>(
      await post("login", { phone: input.phone, password }, cookie),
      "后台登录",
    );
    const verification = await post(
      "verify-mfa",
      { ticket: login.ticket, method: "totp", code: codeNow(enroll.secret, api) },
      cookie,
    );
    signedIn = await m1Data<StaffMe>(verification, "后台二次验证");
    cookie = cookieOf(verification);
  }
  const headers = { ...WRITE, cookie };
  const me = await m1Data<StaffMe>(
    await api.request("/api/v1/admin/auth/me", { headers }),
    "后台身份",
  );
  if (
    me.staff.staffId !== confirmed.me.staff.staffId ||
    me.staff.staffId !== signedIn.staff.staffId ||
    (input.staffId && me.staff.staffId !== input.staffId)
  )
    throw new Error("M1 后台登录员工归属不一致");
  return {
    staffId: me.staff.staffId,
    phone: input.phone,
    password,
    secret: enroll.secret,
    recoveryCodes: confirmed.recoveryCodes,
    headers,
  };
}
export async function bootstrapM1Admin(api: M1Api): Promise<M1AuthenticatedStaff> {
  const phone = "19900000101";
  const result = await api.support.runtime.staffAuth.bootstrap({ name: "M1演示管理员", phone });
  return activateM1Staff(api, {
    phone,
    staffId: result.staffId,
    activationCode: result.activationCode,
    relogin: true,
  });
}

/** 已初始化的同库第二遍：真实口令登录/MFA，不重引导或伪造会话。 */
export async function loginM1Staff(
  api: M1Api,
  input: Pick<M1AuthenticatedStaff, "staffId" | "phone" | "password" | "secret" | "recoveryCodes">,
): Promise<M1AuthenticatedStaff> {
  const login = await m1Data<{ ticket: string }>(
    await api.request("/api/v1/admin/auth/login", {
      method: "POST",
      headers: WRITE,
      json: { phone: input.phone, password: input.password },
    }),
    "已初始化员工登录",
  );
  if (api.waitUntil) {
    // 前一轮主链通常已跨步。只等待实际已消费的步，避免读冒烟先空等近 30 秒。
    // 不试错登录、不预用未来码、不修改 totp_last_step；生产校验仍拒绝重放。
    const lastStep = await api.support.readStaffTotpStep(input.staffId);
    if (lastStep !== null && staff.totpStep(api.support.clock.now()) <= lastStep)
      await api.waitUntil(new Date((lastStep + 1) * 30_000));
  } else if (api.waitForNextMfaStep) await api.waitForNextMfaStep();
  else api.support.clock.advance(30_000);
  const verified = await api.request("/api/v1/admin/auth/verify-mfa", {
    method: "POST",
    headers: WRITE,
    json: { ticket: login.ticket, method: "totp", code: codeNow(input.secret, api) },
  });
  const me = await m1Data<StaffMe>(verified, "已初始化员工二次验证");
  if (me.staff.staffId !== input.staffId) throw new Error("M1 重登员工归属不一致");
  const headers = { ...WRITE, cookie: cookieOf(verified) };
  const current = await m1Data<StaffMe>(
    await api.request("/api/v1/admin/auth/me", { headers }),
    "已初始化员工身份",
  );
  if (current.staff.staffId !== input.staffId) throw new Error("M1 重登会话归属不一致");
  return { ...input, headers };
}
