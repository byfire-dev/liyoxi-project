import { describe, expect, it, vi } from "vitest";
import { makeMe, agreements } from "../../../../shots/account-fixtures";
import { ApiError } from "@/lib/request";
import type { Data, Identity, SettingsApi } from "./api";
import { createSettingsController, deletionBlockers, settingsError } from "./model";

const error = (symbol: ApiError["error"], details?: unknown, status = 409) =>
  new ApiError({
    error: symbol,
    details,
    status,
    message: "服务端受控提示",
    requestId: "test",
  });
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const identity = (id = "first", isCurrent = false): Identity => ({
  wechatIdentityId: id,
  boundAt: "2026-10-01T00:00:00Z",
  lastLoginAt: "2026-10-13T00:00:00Z",
  deviceSummary: "测试设备",
  isCurrent,
  actions: ["delete"],
});
function setup() {
  let token: string | null = "first-token",
    rev = 1,
    n = 0,
    now = 1000,
    me = makeMe();
  const api: SettingsApi = {
    me: vi.fn(async () => me),
    agreements: vi.fn(async () => agreements),
    update: vi.fn(async (body) => {
      me = { ...me, user: { ...me.user, ...body } };
      return me.user;
    }),
    sms: vi.fn<SettingsApi["sms"]>(async () => ({
      purpose: "phone_change",
      targetPhoneMask: "138****8000",
      expiresAt: "2026-10-13T01:00:00Z",
      resendAfterSec: 60,
    })),
    changePhone: vi.fn(async () => me.user),
    identities: vi.fn(async () => ({ items: [identity()], nextCursor: null, hasMore: false })),
    remove: vi.fn(async (id) => ({
      wechatIdentityId: id,
      revokedSessionCount: 2,
      isCurrentSessionRevoked: false,
    })),
    acknowledge: vi.fn(async (id) => ({ userNoticeId: id, ackedAt: "2026-10-13T00:00:00Z" })),
    deletion: vi.fn(async () => ({ deletedAt: "2026-10-13T00:00:00Z" })),
  };
  const clear = vi.fn(),
    gotoLogin = vi.fn(),
    reloadMe = vi.fn(async () => {}),
    logout = vi.fn(async () => {});
  const build = () =>
    createSettingsController({
      api,
      scope: () => JSON.stringify([token, rev]),
      authenticated: () => Boolean(token),
      key: (action) => `${action}:${++n}`,
      now: () => now,
      clear,
      gotoLogin,
      reloadMe,
      logout,
    });
  return {
    api,
    controller: build(),
    build,
    clear,
    gotoLogin,
    reloadMe,
    logout,
    setToken: (value: string | null) => {
      token = value;
    },
    switchStore: () => {
      rev++;
    },
    advance: () => {
      now += 60001;
    },
    setMe: (value: typeof me) => {
      me = value;
    },
  };
}
describe("W2-13 私有账号操作与时序", () => {
  it("称呼同步忙锁拒双点，失败同意图重用key，改内容新key，成功只刷新服务端本人", async () => {
    const e = setup(),
      pending = deferred<Data<"m.me.update">>();
    vi.mocked(e.api.update).mockImplementationOnce(() => pending.promise);
    const first = e.controller.updateName(" 林店长 ");
    expect(e.controller.snapshot().busy).toBe("me_update");
    expect(await e.controller.updateName("林店长")).toBe(false);
    expect(e.api.update).toHaveBeenCalledTimes(1);
    pending.reject(error("CONTENT_REJECTED"));
    await first;
    expect(e.controller.snapshot().busy).toBe(null);
    expect(await e.controller.updateName("林店长")).toBe(true);
    const calls = vi.mocked(e.api.update).mock.calls;
    expect(calls[1]).toEqual(calls[0]);
    await e.controller.updateName("新的称呼");
    expect(calls[2]![1]).not.toBe(calls[1]![1]);
    expect(e.controller.snapshot().me?.user.displayName).toBe("新的称呼");
    expect(e.reloadMe).toHaveBeenCalledTimes(2);
    expect(await e.controller.updateName(" ")).toBe(false);
    expect(await e.controller.updateName("字".repeat(21))).toBe(false);
    expect(e.api.update).toHaveBeenCalledTimes(3);
    await e.controller.updateName("林店长");
    expect(calls[3]![1]).not.toBe(calls[1]![1]);
    expect(e.controller.snapshot().me?.user.displayName).toBe("林店长");
  });
  it("SMS受控失败可同key重试，成功冷却后新key；真实oldSmsCode/opaque新码送审且不留在快照", async () => {
    const e = setup();
    vi.mocked(e.api.sms).mockRejectedValueOnce(error("SMS_UNAVAILABLE", undefined, 503));
    await e.controller.sendSms();
    expect(e.controller.snapshot().error).toContain("联系客服");
    await e.controller.sendSms();
    expect(vi.mocked(e.api.sms).mock.calls[0]).toEqual(vi.mocked(e.api.sms).mock.calls[1]);
    expect(e.controller.snapshot().sms?.purpose).toBe("phone_change");
    await e.controller.sendSms();
    expect(e.api.sms).toHaveBeenCalledTimes(2);
    e.advance();
    await e.controller.sendSms();
    expect(vi.mocked(e.api.sms).mock.calls[2]).not.toEqual(vi.mocked(e.api.sms).mock.calls[1]);
    const body = { oldSmsCode: "123456", newPhoneCode: "opaque-new-code/a_1" };
    vi.mocked(e.api.changePhone).mockRejectedValueOnce(
      error("SMS_CODE_INVALID", { attemptsLeft: 3 }, 400),
    );
    await e.controller.changePhone(body);
    expect(e.controller.snapshot().error).toContain("3 次");
    await e.controller.changePhone(body);
    expect(vi.mocked(e.api.changePhone).mock.calls[1]![1]).not.toBe(
      vi.mocked(e.api.changePhone).mock.calls[0]![1],
    );
    vi.mocked(e.api.changePhone).mockRejectedValueOnce(error("NETWORK_ERROR", undefined, 0));
    await e.controller.changePhone(body);
    expect(e.controller.snapshot().phoneRetryAvailable).toBe(true);
    await e.controller.retryPhone();
    expect(vi.mocked(e.api.changePhone).mock.calls[3]).toEqual(
      vi.mocked(e.api.changePhone).mock.calls[2],
    );
    expect(e.controller.snapshot().phoneRetryAvailable).toBe(false);
    await e.controller.changePhone({ ...body, newPhoneCode: "new-authorization" });
    expect(vi.mocked(e.api.changePhone).mock.calls[4]![1]).not.toBe(
      vi.mocked(e.api.changePhone).mock.calls[3]![1],
    );
    vi.mocked(e.api.changePhone).mockRejectedValueOnce(error("NETWORK_ERROR", undefined, 0));
    await e.controller.changePhone(body);
    e.controller.discardPhoneIntent();
    expect(await e.controller.retryPhone()).toBe(false);
    expect(e.api.changePhone).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(e.controller.snapshot())).not.toMatch(
      /123456|opaque-new-code|new-authorization/,
    );
    expect(e.clear).not.toHaveBeenCalled();
    for (const [symbol, text] of [
      ["PHONE_REGION_UNSUPPORTED", "中国大陆"],
      ["PHONE_UNCHANGED", "相同"],
      ["PHONE_TAKEN", "联系客服"],
      ["WECHAT_CODE_INVALID", "重新点击"],
    ] as const)
      expect(settingsError(error(symbol))).toContain(text);
    expect(settingsError(error("SMS_CODE_INVALID", { attemptsLeft: null }))).toContain("重新获取");
  });
  it("微信游标分页去重，按真实当前身份结果清态；notice按服务器id失败保留且同key关闭", async () => {
    const e = setup(),
      me = makeMe();
    me.notices = [
      {
        userNoticeId: "notice-id",
        kind: "new_wechat_bound",
        occurredAt: "2026-10-13T00:00:00Z",
        message: "另一个设备登录",
      },
    ];
    e.setMe(me);
    await e.controller.refresh();
    vi.mocked(e.api.identities)
      .mockResolvedValueOnce({ items: [identity()], nextCursor: "cursor+?", hasMore: true })
      .mockResolvedValueOnce({
        items: [identity(), identity("second")],
        nextCursor: null,
        hasMore: false,
      });
    await e.controller.identities();
    await e.controller.moreIdentities();
    expect(e.api.identities).toHaveBeenLastCalledWith("cursor+?");
    expect(e.controller.snapshot().identities).toHaveLength(2);
    vi.mocked(e.api.acknowledge).mockRejectedValueOnce(error("NETWORK_ERROR", undefined, 0));
    await e.controller.acknowledge("notice-id");
    expect(e.controller.snapshot().me?.notices).toHaveLength(1);
    e.setMe({ ...me, notices: [] });
    await e.controller.acknowledge("notice-id");
    expect(vi.mocked(e.api.acknowledge).mock.calls[1]).toEqual(
      vi.mocked(e.api.acknowledge).mock.calls[0],
    );
    expect(e.controller.snapshot().me?.notices).toHaveLength(0);
    await e.controller.remove(identity("second"));
    expect(e.clear).not.toHaveBeenCalled();
    vi.mocked(e.api.remove).mockResolvedValueOnce({
      wechatIdentityId: "first",
      revokedSessionCount: 1,
      isCurrentSessionRevoked: true,
    });
    await e.controller.remove(identity("first", true));
    expect(e.clear).toHaveBeenCalledOnce();
    expect(e.gotoLogin).toHaveBeenCalledOnce();
    expect(
      settingsError(error("IDENTITY_TOO_NEW", { removableAt: "2026-10-20T00:00:00Z" })),
    ).toContain("2026-10-20");
  });
  it("六类注销阻断只取服务端数量；待同意也能请求注销，成功/401清态，游客零保护写", async () => {
    const e = setup(),
      blockers = [
        "subscription_active",
        "payment_open",
        "refund_open",
        "invoice_open",
        "open_order",
        "release_online",
      ].map((kind, n) => ({ kind, count: n + 1 }));
    vi.mocked(e.api.deletion).mockRejectedValueOnce(
      error("ACCOUNT_DELETION_BLOCKED", { blockers }),
    );
    e.setMe(makeMe(false, true));
    await e.controller.refresh();
    await e.controller.deletion();
    expect(e.controller.snapshot().blockers.map((row) => row.count)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(
      deletionBlockers(
        error("ACCOUNT_DELETION_BLOCKED", { blockers: [{ kind: "unknown", count: 999 }] }),
      ),
    ).toEqual([]);
    expect(e.clear).not.toHaveBeenCalled();
    await e.controller.deletion();
    expect(e.clear).toHaveBeenCalledOnce();
    const unauthorized = setup();
    vi.mocked(unauthorized.api.deletion).mockRejectedValueOnce(
      error("AUTH_REQUIRED", undefined, 401),
    );
    await unauthorized.controller.deletion();
    expect(unauthorized.clear).toHaveBeenCalledOnce();
    expect(unauthorized.gotoLogin).toHaveBeenCalledOnce();
    const guest = setup();
    guest.setToken(null);
    const page = guest.build();
    await page.refresh();
    await page.deletion();
    await page.sendSms();
    expect(guest.api.me).not.toHaveBeenCalled();
    expect(guest.api.deletion).not.toHaveBeenCalled();
    expect(page.snapshot().agreements).toHaveLength(2);
    const out = setup();
    await out.controller.logout();
    expect(out.logout).toHaveBeenCalledOnce();
  });
  it("旧GET/旧finally不能覆盖写后本人或解除新忙锁，刷新失败保成功事实并可继续", async () => {
    const e = setup(),
      read = deferred<Data<"m.me.get">>(),
      write = deferred<Data<"m.me.update">>();
    vi.mocked(e.api.me).mockImplementationOnce(() => read.promise);
    const oldRead = e.controller.refresh();
    vi.mocked(e.api.update).mockImplementationOnce(() => write.promise);
    const saving = e.controller.updateName("新称呼");
    read.resolve(makeMe());
    await oldRead;
    expect(e.controller.snapshot().busy).toBe("me_update");
    expect(e.controller.snapshot().me).toBe(null);
    const next = makeMe();
    next.user.displayName = "新称呼";
    e.setMe(next);
    write.resolve(next.user);
    await saving;
    expect(e.controller.snapshot().me?.user.displayName).toBe("新称呼");
    vi.mocked(e.api.me).mockRejectedValueOnce(error("NETWORK_ERROR", undefined, 0));
    await e.controller.updateName("再修改");
    expect(e.controller.snapshot()).toMatchObject({ success: "操作已完成", busy: null });
    await e.controller.updateName("可继续");
    expect(e.api.update).toHaveBeenCalledTimes(3);
  });
  it("token/contextRev/卸载全部废弃旧读写与迟到401，旧所有者不清新实例忙锁", async () => {
    for (const mode of ["token", "context", "dispose"] as const) {
      const e = setup(),
        write = deferred<Data<"m.me.update">>();
      vi.mocked(e.api.update).mockImplementationOnce(() => write.promise);
      const pending = e.controller.updateName("旧账号称呼");
      if (mode === "token") e.setToken("other-token");
      else if (mode === "context") e.switchStore();
      else e.controller.dispose();
      const next = e.build(),
        saving = deferred<Data<"m.me.update">>();
      vi.mocked(e.api.update).mockImplementationOnce(() => saving.promise);
      const active = next.updateName("新账号称呼");
      write.reject(error("AUTH_REQUIRED", undefined, 401));
      await pending;
      expect(e.clear).not.toHaveBeenCalled();
      expect(next.snapshot().busy).toBe("me_update");
      saving.resolve(makeMe().user);
      await active;
      expect(next.snapshot().busy).toBe(null);
      next.dispose();
    }
  });
});
