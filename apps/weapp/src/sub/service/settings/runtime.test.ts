import { describe, expect, it, vi } from "vitest";
import { createSettingsApi } from "./api";
import type { RequestLayer } from "@/lib/request";
import { createPhoneAuthorization } from "@/pages/login/phone-authorization";

describe("W2-13 actual传输与手机号采集边界", () => {
  it("八个本人调用用中央request形状，专用旧号SMS/确认注销/opaque换绑/游标编码，无portal Meta调用", async () => {
    const sent = vi.fn<(...args: Parameters<RequestLayer["request"]>) => void>();
    const send: RequestLayer["request"] = async <T>(
      ...args: Parameters<RequestLayer["request"]>
    ) => {
      sent(...args);
      return null as T;
    };
    const api = createSettingsApi(send);
    await api.me();
    await api.update({ displayName: "店长" }, "name:key");
    await api.sms("sms:key");
    await api.changePhone({ oldSmsCode: "123456", newPhoneCode: "opaque/phone_code" }, "phone:key");
    await api.identities("cursor+/?");
    await api.remove("identity/a", "remove:key");
    await api.acknowledge("notice/a", "notice:key");
    await api.deletion("delete:key");
    await api.agreements(null);
    expect(sent.mock.calls).toEqual([
      ["/m/me"],
      ["/m/me", { method: "PATCH", data: { displayName: "店长" }, idempotencyKey: "name:key" }],
      [
        "/m/sms-codes",
        { method: "POST", data: { purpose: "phone_change" }, idempotencyKey: "sms:key" },
      ],
      [
        "/m/me/change-phone",
        {
          method: "POST",
          data: { oldSmsCode: "123456", newPhoneCode: "opaque/phone_code" },
          idempotencyKey: "phone:key",
        },
      ],
      ["/m/me/wechat-identities?limit=20&cursor=cursor%2B%2F%3F"],
      ["/m/me/wechat-identities/identity%2Fa", { method: "DELETE", idempotencyKey: "remove:key" }],
      [
        "/m/me/user-notices/notice%2Fa/acknowledge",
        { method: "POST", idempotencyKey: "notice:key" },
      ],
      [
        "/m/me/deletion",
        { method: "POST", data: { hasConfirmed: true }, idempotencyKey: "delete:key" },
      ],
      ["/m/agreements?scene=login&limit=50", { auth: false }],
    ]);
  });
  it("手机号组件先隐私与同意，拒绝/额度/未配H5不请求；opaque一次提交/双回调/卸载失效", async () => {
    let scope = "guest";
    const privacy = vi.fn(async () => true),
      exhausted = vi.fn(),
      submit = vi.fn(async () => {});
    const phone = createPhoneAuthorization({
      supported: true,
      scope: () => scope,
      privacy,
      exhausted,
    });
    await phone.prepare(false);
    expect(privacy).not.toHaveBeenCalled();
    vi.mocked(privacy).mockResolvedValueOnce(false);
    await phone.prepare(true);
    await phone.accept({ code: "cannot-use" }, submit);
    expect(submit).not.toHaveBeenCalled();
    await phone.prepare(true);
    await phone.accept({ errMsg: "getPhoneNumber:fail user deny" }, submit);
    expect(phone.snapshot().error).toContain("未获得");
    await phone.prepare(true);
    await phone.accept({ errno: 1400001 }, submit);
    expect(exhausted).toHaveBeenCalledOnce();
    await phone.prepare(true);
    await Promise.all([
      phone.accept({ code: "real-opaque-code/a" }, submit),
      phone.accept({ code: "duplicate" }, submit),
    ]);
    expect(submit).toHaveBeenCalledExactlyOnceWith("real-opaque-code/a");
    expect(JSON.stringify(phone.snapshot())).not.toContain("real-opaque");
    await phone.prepare(true);
    scope = "new-session";
    await phone.accept({ code: "late" }, submit);
    expect(submit).toHaveBeenCalledOnce();
    const h5 = createPhoneAuthorization({
      supported: false,
      scope: () => scope,
      privacy,
      exhausted,
    });
    await h5.prepare(true);
    await h5.accept({ code: "fake" }, submit);
    expect(h5.snapshot().error).toContain("此环境不支持");
    expect(submit).toHaveBeenCalledOnce();
    const unmounted = createPhoneAuthorization({
      supported: true,
      scope: () => scope,
      privacy,
      exhausted,
    });
    await unmounted.prepare(true);
    unmounted.dispose();
    await unmounted.accept({ code: "late" }, submit);
    expect(submit).toHaveBeenCalledOnce();
  });
});
