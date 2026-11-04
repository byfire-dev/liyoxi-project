import { describe, expect, it, vi } from "vitest";
import { makeMe, agreements } from "../../../../shots/account-fixtures";
import { ApiError, type RequestLayer } from "@/lib/request";
import { createSettingsApi, type Computer, type Me } from "./api";
import { canManageComputers, createSettingsController, settingsPortalIdentity } from "./model";

const NOW = "2026-11-04T00:00:00.000Z";
const failure = (error: ApiError["error"], status: number) =>
  new ApiError({
    error,
    status,
    message: "受控错误",
    requestId: "settings-test",
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(clerk = false) {
  let me = makeMe(clerk),
    token: string | null = "unit-session",
    revision = 1,
    sequence = 0;
  let storeId: string | null = me.memberships[0]!.stores[0]!.storeId;
  let rows: Computer[] = me.memberships[0]!.stores.map((store, index) => ({
    portalSessionId: `session-${index}`,
    storeId: store.storeId,
    storeName: store.name,
    grantScope: "store",
    browser: index ? "Safari · macOS" : "Chrome · Windows",
    regionHint: null,
    authorizedAt: NOW,
    expiresAt: "2026-11-04T02:00:00.000Z",
    revokedAt: null,
  }));
  const sent = vi.fn<(...args: Parameters<RequestLayer["request"]>) => void>();
  const send: RequestLayer["request"] = async <T>(
    path: string,
    options?: Parameters<RequestLayer["request"]>[1],
  ) => {
    sent(path, options);
    let data: unknown;
    if (path === "/m/me") data = options?.method === "PATCH" ? me.user : me;
    else if (path.startsWith("/m/agreements?")) data = agreements;
    else if (path === "/m/portal-sessions") data = { items: [...rows] };
    else if (path.endsWith("/revoke")) {
      const id = decodeURIComponent(path.split("/").at(-2)!);
      const row = rows.find((item) => item.portalSessionId === id);
      if (!row) throw failure("NOT_FOUND", 404);
      data = { ...row, revokedAt: NOW };
      rows = rows.filter((item) => item.portalSessionId !== id);
    } else throw new Error("unexpected settings operation");
    return data as T;
  };
  const api = createSettingsApi(send);
  const scope = () =>
    JSON.stringify([token, revision, storeId, settingsPortalIdentity(me, storeId)]);
  const clear = vi.fn(() => {
    token = null;
  });
  const gotoLogin = vi.fn(),
    reloadMe = vi.fn(async () => {}),
    logout = vi.fn(async () => {});
  const build = () =>
    createSettingsController({
      api,
      scope,
      authenticated: () => Boolean(token),
      portalAllowed: (latest) =>
        canManageComputers(latest, storeId) && canManageComputers(me, storeId),
      key: (action) => `${action}:${++sequence}`,
      now: () => Date.parse(NOW),
      clear,
      gotoLogin,
      reloadMe,
      logout,
    });
  return {
    api,
    sent,
    controller: build(),
    build,
    clear,
    gotoLogin,
    reloadMe,
    rows: () => rows,
    getMe: () => me,
    setMe: (next: Me) => {
      me = next;
    },
    guest: () => {
      token = null;
    },
    changeToken: () => {
      token = "next-unit-session";
    },
    switchStore: () => {
      storeId = me.memberships[0]!.stores[1]!.storeId;
      revision++;
    },
  };
}

describe("W6-10 设置页电脑授权的实际契约与所有权", () => {
  it("权限取当前门店成员身份，老板停用店仍可管理；店员、无门店及移除成员拒绝", () => {
    const me = makeMe(),
      store = me.memberships[0]!.stores[0]!;
    expect(canManageComputers(me, store.storeId)).toBe(true);
    store.lifecycle = "archived";
    expect(canManageComputers(me, store.storeId)).toBe(true);
    const owner = settingsPortalIdentity(me, store.storeId);
    me.memberships[0]!.role = "clerk";
    expect(canManageComputers(me, store.storeId)).toBe(false);
    expect(settingsPortalIdentity(me, store.storeId)).not.toBe(owner);
    expect(canManageComputers(makeMe(), null)).toBe(false);
    expect(canManageComputers(makeMe(), "foreign-store")).toBe(false);
    expect(canManageComputers(null, store.storeId)).toBe(false);
    expect(canManageComputers({ ...makeMe(), memberships: [] }, store.storeId)).toBe(false);
  });

  it("只在打开后GET，保留主体内其他门店项目；GET新代次胜出且零写", async () => {
    const e = setup();
    const list = vi.spyOn(e.api, "computers");
    await e.controller.refresh();
    expect(list).not.toHaveBeenCalled();
    await e.controller.computers();
    expect(e.controller.snapshot().computers).toEqual(e.rows());
    expect(e.controller.snapshot().computers.map((row) => row.storeId)).toHaveLength(2);
    const older = deferred<{ items: Computer[] }>();
    list.mockImplementationOnce(() => older.promise).mockResolvedValueOnce({ items: [] });
    const read = e.controller.computers();
    await e.controller.computers();
    older.resolve({ items: e.rows() });
    await read;
    expect(e.controller.snapshot()).toMatchObject({
      computers: [],
      computersLoaded: true,
      computersLoading: false,
    });
    expect(e.sent.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });

  it("游客、店员和未在真实列表的id均不发电脑写；无权限也不发列表", async () => {
    for (const mode of ["clerk", "guest"] as const) {
      const e = setup(mode === "clerk");
      if (mode === "guest") e.guest();
      const page = e.build();
      const list = vi.spyOn(e.api, "computers"),
        revoke = vi.spyOn(e.api, "revokeComputer");
      await page.refresh();
      await page.computers();
      expect(await page.revokeComputer("session-0")).toBe(false);
      expect(list).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
    }
    const e = setup(),
      revoke = vi.spyOn(e.api, "revokeComputer");
    await e.controller.refresh();
    await e.controller.computers();
    expect(await e.controller.revokeComputer("foreign-session")).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("吊销同步拒双击，失败同意图重用key，真实回执后GET；新对象用新key", async () => {
    const e = setup();
    await e.controller.refresh();
    await e.controller.computers();
    const first = deferred<Computer>();
    const revoke = vi.spyOn(e.api, "revokeComputer").mockImplementationOnce(() => first.promise);
    const pending = e.controller.revokeComputer("session-0");
    expect(e.controller.snapshot().busy).toBe("portal_session_revoke");
    expect(await e.controller.revokeComputer("session-0")).toBe(false);
    expect(revoke).toHaveBeenCalledTimes(1);
    first.reject(failure("NETWORK_ERROR", 0));
    await pending;
    expect(e.controller.snapshot().computers).toHaveLength(2);
    expect(e.controller.snapshot().computerResult).toBeNull();
    expect(await e.controller.revokeComputer("session-0")).toBe(true);
    expect(revoke.mock.calls[1]).toEqual(revoke.mock.calls[0]);
    expect(e.controller.snapshot().computerResult?.revokedAt).toBe(NOW);
    expect(e.controller.snapshot().computers.map((row) => row.portalSessionId)).toEqual([
      "session-1",
    ]);
    expect(e.sent.mock.calls.at(-1)?.[0]).toBe("/m/portal-sessions");
    expect(await e.controller.revokeComputer("session-0")).toBe(false);
    await e.controller.revokeComputer("session-1");
    expect(revoke.mock.calls[2]![1]).not.toBe(revoke.mock.calls[1]![1]);
  });

  it("POST成功而GET失败保真实回执；刷新只能重读，不能重发已成功的吊销", async () => {
    const e = setup();
    await e.controller.refresh();
    await e.controller.computers();
    const revoke = vi.spyOn(e.api, "revokeComputer");
    vi.spyOn(e.api, "computers").mockRejectedValueOnce(failure("NETWORK_ERROR", 0));
    expect(await e.controller.revokeComputer("session-0")).toBe(true);
    expect(e.controller.snapshot()).toMatchObject({
      busy: null,
      success: "已撤销这台电脑的授权",
      computerError: "受控错误",
    });
    expect(e.controller.snapshot().computerResult?.revokedAt).toBe(NOW);
    expect(await e.controller.revokeComputer("session-0")).toBe(false);
    await e.controller.computers();
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(e.controller.snapshot().computers.map((row) => row.portalSessionId)).toEqual([
      "session-1",
    ]);
    expect(e.controller.snapshot().computerError).toBeNull();
  });

  it("200已过期回执不伪造revokedAt；取消失败意图后重新确认生成新key", async () => {
    const e = setup();
    await e.controller.refresh();
    await e.controller.computers();
    const revoke = vi
      .spyOn(e.api, "revokeComputer")
      .mockRejectedValueOnce(failure("NETWORK_ERROR", 0));
    await e.controller.revokeComputer("session-0");
    e.controller.discardComputerIntent();
    const expired = { ...e.rows()[0]!, expiresAt: NOW, revokedAt: null };
    revoke.mockResolvedValueOnce(expired);
    vi.spyOn(e.api, "computers").mockResolvedValueOnce({ items: [] });
    await e.controller.revokeComputer("session-0");
    expect(revoke.mock.calls[1]![1]).not.toBe(revoke.mock.calls[0]![1]);
    expect(e.controller.snapshot().computerResult).toEqual(expired);
    expect(e.controller.snapshot().success).toBe("电脑授权状态已更新");
  });

  it("403/404清旧列表和确认事实并重读身份，不乐观注销或重放无效目标", async () => {
    for (const status of [403, 404]) {
      const e = setup();
      await e.controller.refresh();
      await e.controller.computers();
      const revoke = vi
        .spyOn(e.api, "revokeComputer")
        .mockRejectedValueOnce(failure(status === 403 ? "ROLE_FORBIDDEN" : "NOT_FOUND", status));
      expect(await e.controller.revokeComputer("session-0")).toBe(false);
      expect(e.controller.snapshot()).toMatchObject({
        computers: [],
        computerResult: null,
        computerError: "受控错误",
        success: null,
      });
      expect(e.reloadMe).toHaveBeenCalledOnce();
      expect(await e.controller.revokeComputer("session-0")).toBe(false);
      expect(revoke).toHaveBeenCalledTimes(1);
    }
  });

  it("当前401走公共清态/登录；旧token、门店、资格或卸载的迟到401不清新会话", async () => {
    const e = setup();
    await e.controller.refresh();
    vi.spyOn(e.api, "computers").mockRejectedValueOnce(failure("AUTH_REQUIRED", 401));
    await e.controller.computers();
    expect(e.clear).toHaveBeenCalledOnce();
    expect(e.gotoLogin).toHaveBeenCalledOnce();
    const currentWrite = setup();
    await currentWrite.controller.refresh();
    await currentWrite.controller.computers();
    vi.spyOn(currentWrite.api, "revokeComputer").mockRejectedValueOnce(
      failure("AUTH_REQUIRED", 401),
    );
    expect(await currentWrite.controller.revokeComputer("session-0")).toBe(false);
    expect(currentWrite.clear).toHaveBeenCalledOnce();
    expect(currentWrite.gotoLogin).toHaveBeenCalledOnce();
    for (const mode of ["token", "store", "role", "dispose"] as const) {
      const old = setup();
      await old.controller.refresh();
      await old.controller.computers();
      const reply = deferred<Computer>();
      vi.spyOn(old.api, "revokeComputer").mockImplementationOnce(() => reply.promise);
      const pending = old.controller.revokeComputer("session-0");
      if (mode === "token") old.changeToken();
      else if (mode === "store") old.switchStore();
      else if (mode === "role") old.setMe(makeMe(true));
      else old.controller.dispose();
      const next = old.build();
      await next.refresh();
      reply.reject(failure("AUTH_REQUIRED", 401));
      await pending;
      expect(old.clear).not.toHaveBeenCalled();
      expect(old.gotoLogin).not.toHaveBeenCalled();
      expect(next.snapshot().busy).toBeNull();
      expect(old.controller.canManageComputers()).toBe(false);
    }
  });

  it("关闭与换资格废弃迟到列表；其他本人写不能被旧列表响应覆盖", async () => {
    const e = setup();
    await e.controller.refresh();
    const late = deferred<{ items: Computer[] }>();
    vi.spyOn(e.api, "computers").mockImplementationOnce(() => late.promise);
    const read = e.controller.computers();
    e.controller.closeComputers();
    late.resolve({ items: e.rows() });
    await read;
    expect(e.controller.snapshot()).toMatchObject({ computers: [], computersLoading: false });
    const beforeWrite = deferred<{ items: Computer[] }>();
    vi.mocked(e.api.computers).mockImplementationOnce(() => beforeWrite.promise);
    const oldRead = e.controller.computers();
    await e.controller.updateName("保留原设置");
    beforeWrite.resolve({ items: e.rows() });
    await oldRead;
    expect(e.controller.snapshot().computers).toEqual([]);
    expect(e.controller.snapshot().success).toBe("操作已完成");
    const changed = setup();
    await changed.controller.refresh();
    const lostOwner = deferred<{ items: Computer[] }>();
    vi.spyOn(changed.api, "computers").mockImplementationOnce(() => lostOwner.promise);
    const oldOwnerRead = changed.controller.computers();
    changed.setMe(makeMe(true));
    lostOwner.resolve({ items: changed.rows() });
    await oldOwnerRead;
    expect(changed.controller.snapshot().computers).toEqual([]);
    expect(changed.controller.canManageComputers()).toBe(false);
  });
});
