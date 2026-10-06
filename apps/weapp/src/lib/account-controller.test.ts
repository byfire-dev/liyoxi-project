import { describe, expect, it, vi } from "vitest";

import {
  agreements,
  bootstrap,
  makeMe,
  makeOverview,
  makeStores,
  pending,
} from "../../shots/account-fixtures";
import { createAccountApi, type AccountApi, type Data, type Me } from "./account-api";
import { accountError, createAccountController } from "./account-controller";
import { accountEntries } from "./account-entries";
import { returnTarget } from "./account-navigation";
import { accountLoginCode, rememberFirstTouch } from "./account-source";
import type { KeyValueStorage, WireRequest, WireResponse } from "./platform";
import { ApiError, createRequestLayer } from "./request";
import { StorageKey } from "./storage";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const failure = (error: ApiError["error"], status = 400) =>
  new ApiError({ error, message: error, status, requestId: "test" });
function setup(token: string | null = "lyxm_old") {
  const me = makeMe();
  const local = {
    token,
    storeId: null as string | null,
    contextRev: 0,
    now: 1_000_000,
    me: null as Me | null,
  };
  const events: string[] = [];
  const api: AccountApi = {
    bootstrap: vi.fn(async () => bootstrap),
    silent: vi.fn(async () => ({ needPhone: true, token: null, me: null })),
    phone: vi.fn(async () => ({ token: "lyxm_new", me, isNewUser: false, switchedFrom: null })),
    me: vi.fn(async () => {
      events.push("me");
      return me;
    }),
    overview: vi.fn(async () => {
      events.push("overview");
      return makeOverview(false, local.storeId === me.memberships[0]!.stores[1]!.storeId);
    }),
    logout: vi.fn(async () => null),
    agreements: vi.fn(async () => agreements.items),
    agreement: vi.fn(),
    consent: vi.fn(async () => ({ consents: [], pendingConsents: [] })),
    stores: vi.fn(async () => makeStores()),
    remember: vi.fn(async (storeId) => {
      events.push("remember");
      return { storeId };
    }),
  };
  const applyBootstrap = vi.fn();
  const returnPage = vi.fn(async () => undefined);
  const guestHome = vi.fn(async () => undefined);
  const toast = vi.fn();
  const track = vi.fn((name: string) => {
    events.push(name);
  });
  const key = vi.fn(() => "store_switch:00000000-0000-4000-8000-000000000001");
  const controller = createAccountController({
    api,
    clock: { now: () => local.now },
    token: () => local.token,
    setSession: (value, next) => {
      local.token = value;
      local.me = next;
    },
    setMe: (next) => {
      local.me = next;
    },
    clearSession: () => {
      local.token = null;
      local.me = null;
    },
    store: () => ({ currentStoreId: local.storeId, contextRev: local.contextRev }),
    setStore: (id) => {
      if (local.storeId !== id) {
        local.storeId = id;
        local.contextRev++;
        events.push("local");
      }
    },
    loginCode: async () => "local-code",
    attribution: () => ({ channelCode: "demo", inviteCode: "private-token" }),
    key,
    applyBootstrap,
    returnPage,
    guestHome,
    toast,
    track,
  });
  return {
    controller,
    api,
    local,
    events,
    applyBootstrap,
    returnPage,
    guestHome,
    toast,
    track,
    key,
  };
}
function memory(): KeyValueStorage {
  const items = new Map<string, unknown>();
  return {
    get: <T>(key: string) => (items.get(key) ?? null) as T | null,
    set: (key, value) => {
      items.set(key, value);
    },
    remove: (key) => {
      items.delete(key);
    },
  };
}

describe("账户启动与登录", () => {
  it("有令牌先引导再 me，不静默；优先服务端有效门店，未知门店回退", async () => {
    const env = setup();
    const second = makeMe().memberships[0]!.stores[1]!.storeId;
    vi.mocked(env.api.bootstrap).mockResolvedValue({ ...bootstrap, context: { storeId: second } });
    await Promise.all([env.controller.start(), env.controller.start()]);
    expect(env.api.bootstrap).toHaveBeenCalledTimes(1);
    expect(env.api.me).toHaveBeenCalledTimes(1);
    expect(env.api.silent).not.toHaveBeenCalled();
    expect(env.local.storeId).toBe(second);
    expect(env.track).toHaveBeenCalledWith("app_launch", {
      channelCode: "demo",
      hasInvitation: true,
    });
    expect(JSON.stringify(env.track.mock.calls)).not.toContain("private-token");
    const missing = setup();
    vi.mocked(missing.api.bootstrap).mockResolvedValue({
      ...bootstrap,
      context: { storeId: "missing" },
    });
    await missing.controller.start();
    expect(missing.local.storeId).toBe(makeMe().memberships[0]!.lastStoreId);
  });
  it("无令牌静默 needPhone 保持游客；静默成功恢复账号；引导失败仍恢复", async () => {
    const guest = setup(null);
    await guest.controller.start();
    expect(guest.api.me).not.toHaveBeenCalled();
    expect(guest.api.silent).toHaveBeenCalledWith("local-code");
    expect(guest.local.token).toBeNull();
    const restored = setup(null);
    vi.mocked(restored.api.bootstrap).mockRejectedValue(new Error("offline"));
    vi.mocked(restored.api.silent).mockResolvedValue({
      needPhone: false,
      token: "lyxm_new",
      me: makeMe(),
    });
    await restored.controller.start();
    expect(restored.local.token).toBe("lyxm_new");
    expect(restored.controller.snapshot().me?.user.phoneMask).toBe("138****8000");
  });
  it("静默与手机号公共请求不带鉴权，静默401不启动递归恢复", async () => {
    const silentLogin = vi.fn(async () => "failed" as const);
    const sent: WireRequest[] = [];
    const layer = createRequestLayer({
      baseUrl: "https://api.example.test",
      send: async (request) => {
        sent.push(request);
        return {
          statusCode: 401,
          header: {},
          data: {
            error: "AUTH_REQUIRED",
            code: 40100,
            message: "expired",
            retryable: false,
            requestId: "test",
          },
        };
      },
      clock: { now: () => 0, sleep: async () => undefined },
      uuid: () => "00000000-0000-4000-8000-000000000001",
      client: () => ({ platform: "devtools", version: "1.0.0", envVersion: "develop" }),
      getToken: () => "old",
      getStoreId: () => null,
      recover: { silentLogin },
    });
    const api = createAccountApi(layer.request);
    await expect(api.silent("code")).rejects.toMatchObject({ error: "AUTH_REQUIRED" });
    await expect(
      api.phone({ loginCode: "code", phoneCode: "13800138000", consents: [] }),
    ).rejects.toMatchObject({ error: "AUTH_REQUIRED" });
    expect(silentLogin).not.toHaveBeenCalled();
    expect(sent.every((request) => !request.header.Authorization)).toBe(true);
  });
  it("首触连空来源也占位；固定本机码仅用于登录码取不到且不存号码", async () => {
    const storage = memory();
    expect(rememberFirstTouch(storage)).toEqual({});
    expect(rememberFirstTouch(storage, { scene: 1047, query: { inviteCode: "late" } })).toEqual({});
    const source = memory();
    expect(
      rememberFirstTouch(source, {
        scene: 1047,
        query: { channelCode: "demo", inviteCode: "first", phone: "13800138000" },
      }),
    ).toEqual({ scene: 1047, channelCode: "demo", inviteCode: "first" });
    expect(rememberFirstTouch(source, { query: { channelCode: "later" } }).channelCode).toBe(
      "demo",
    );
    const login = vi.fn(async () => {
      throw new Error("unavailable");
    });
    expect(await accountLoginCode(source, login, () => "one")).toBe("local-one");
    expect(await accountLoginCode(source, login, () => "two")).toBe("local-one");
    expect(
      await accountLoginCode(
        source,
        async () => "real",
        () => "three",
      ),
    ).toBe("real");
    expect(JSON.stringify(source.get(StorageKey.attribution))).not.toContain("13800138000");
  });
  it("未勾选与无效号码不请求；过期版本重拉；成功回原页面并账号切换只提示一次", async () => {
    const env = setup(null);
    await env.controller.loadAgreements();
    await expect(env.controller.phoneLogin("13800138000", false)).rejects.toThrow(
      "请先阅读并勾选下方协议",
    );
    await expect(env.controller.phoneLogin("12", true)).rejects.toThrow("11位手机号");
    expect(env.api.phone).not.toHaveBeenCalled();
    vi.mocked(env.api.phone).mockRejectedValueOnce(failure("AGREEMENT_VERSION_STALE"));
    await expect(env.controller.phoneLogin("13800138000", true)).rejects.toMatchObject({
      error: "AGREEMENT_VERSION_STALE",
    });
    expect(env.api.agreements).toHaveBeenCalledTimes(2);
    vi.mocked(env.api.phone).mockResolvedValue({
      token: "new",
      me: makeMe(),
      isNewUser: false,
      switchedFrom: { phoneMask: "139****9000" },
    });
    await env.controller.phoneLogin("13800138000", true);
    expect(env.api.phone).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phoneCode: "13800138000",
        attribution: { channelCode: "demo", inviteCode: "private-token" },
        consents: agreements.items.map((item) => ({
          agreementKey: item.agreementKey,
          agreementVersionId: item.currentVersion!.agreementVersionId,
        })),
      }),
    );
    expect(env.returnPage).toHaveBeenCalledTimes(1);
    expect(env.controller.snapshot().switchedFrom).toBe("139****9000");
    env.controller.dismissSwitchNotice();
    await env.controller.loadMine();
    expect(env.controller.snapshot().switchedFrom).toBeNull();
  });
  it.each([
    "ACCOUNT_DISABLED",
    "REVERIFY_REQUIRED",
    "WECHAT_UNAVAILABLE",
    "PHONE_REGION_UNSUPPORTED",
    "WECHAT_CODE_INVALID",
  ] as const)("%s 有说明且登录文案无禁词", (error) => {
    expect(accountError(failure(error))).not.toBe("暂时无法加载，请重试");
    expect(accountError(failure(error))).not.toContain("微信");
  });
  it("原非标签页保留查询编码；未知/登录页回我的；未落地菜单隐藏", () => {
    expect(
      returnTarget({
        route: "pages/agreement/index",
        query: { id: "a/b", extra: "中文", no: false },
      }),
    ).toEqual({ tab: false, url: "/pages/agreement/index?id=a%2Fb&extra=%E4%B8%AD%E6%96%87" });
    expect(returnTarget({ route: "pages/home/index", query: { ignored: "x" } })).toEqual({
      tab: true,
      url: "/pages/home/index",
    });
    expect(returnTarget({ route: "sub/service/settings/index" })).toEqual({
      tab: true,
      url: "/pages/mine/index",
    });
    expect(accountEntries("owner")).toEqual([]);
    expect(accountEntries("clerk")).toEqual([]);
  });
});

describe("重新同意与门店上下文", () => {
  it("切换登录账号废弃旧账号的同意回执与缓存，不阻塞新账号", async () => {
    const env = setup();
    await env.controller.start();
    await env.controller.loadMine();
    const waiting = env.controller.askConsent([pending]);
    const late = deferred<Data<"m.agreementConsent.create">>();
    vi.mocked(env.api.consent).mockReturnValueOnce(late.promise);
    const accepting = env.controller.acceptConsent();
    await env.controller.loadAgreements();
    const next = { ...makeMe(), user: { ...makeMe().user, merchantUserId: "next-user" } };
    vi.mocked(env.api.phone).mockResolvedValueOnce({
      token: "next",
      me: next,
      isNewUser: false,
      switchedFrom: { phoneMask: "138****8000" },
    });
    await env.controller.phoneLogin("13900139000", true);
    await expect(waiting).resolves.toBe(false);
    late.resolve({ consents: [], pendingConsents: [pending] });
    await accepting;
    expect(env.controller.snapshot().me?.user.merchantUserId).toBe("next-user");
    expect(env.controller.snapshot().consentBusy).toBe(false);
    expect(env.controller.snapshot().consent).toEqual([]);
    expect(env.controller.snapshot().overview).toBeNull();
  });
  it("五个真实请求层428共用一个弹层；同意完成后保留请求编号/幂等键各重放一次", async () => {
    const env = setup();
    const sent: WireRequest[] = [];
    let accepted = false;
    vi.mocked(env.api.consent).mockImplementation(async () => {
      accepted = true;
      return { consents: [], pendingConsents: [] };
    });
    let count = 0;
    const ask = vi.fn(env.controller.askConsent);
    const layer = createRequestLayer({
      baseUrl: "https://api.example.test",
      clock: { now: () => env.local.now, sleep: async () => undefined },
      uuid: () => `00000000-0000-4000-8000-${String(++count).padStart(12, "0")}`,
      client: () => ({ platform: "devtools", version: "1.0.0", envVersion: "develop" }),
      getToken: () => env.local.token,
      getStoreId: () => env.local.storeId,
      recover: { askConsent: ask },
      send: async (request) => {
        sent.push(request);
        const response: WireResponse = accepted
          ? { statusCode: 200, header: {}, data: { code: 0, message: "ok", data: request.url } }
          : {
              statusCode: 428,
              header: {},
              data: {
                error: "CONSENT_REQUIRED",
                code: 42800,
                message: "consent",
                requestId: "test",
                retryable: false,
                details: { pendingConsents: [pending] },
              },
            };
        return response;
      },
    });
    const requests = Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        layer.request(`/m/test/${i}`, { method: "POST", idempotencyKey: `test:${i}` }),
      ),
    );
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    expect(sent).toHaveLength(5);
    expect(env.controller.snapshot().consent).toEqual([pending]);
    const meFlight = env.controller.askConsent([pending]);
    await env.controller.acceptConsent();
    await expect(meFlight).resolves.toBe(true);
    expect(await requests).toHaveLength(5);
    expect(env.api.consent).toHaveBeenCalledTimes(1);
    for (const first of sent.slice(0, 5)) {
      const replay = sent.slice(5).find((request) => request.url === first.url)!;
      expect(replay.header["X-Request-Id"]).toBe(first.header["X-Request-Id"]);
      expect(replay.header["Idempotency-Key"]).toBe(first.header["Idempotency-Key"]);
    }
    expect(env.controller.snapshot().consent).toEqual([]);
  });
  it("合并me与428且只用最新版；拒绝只能退出，30秒静默；协议正文可读后仍阻断", async () => {
    const env = setup();
    const first = env.controller.askConsent([pending]);
    const newer = { ...pending, agreementVersionId: "new", effectiveAt: "2026-11-01T00:00:00Z" };
    const same = env.controller.askConsent({ pendingConsents: [newer] });
    expect(same).toBe(first);
    expect(env.controller.snapshot().consent).toEqual([newer]);
    env.controller.showAgreement(true);
    expect(env.controller.snapshot().consent).toEqual([newer]);
    env.controller.showAgreement(false);
    await env.controller.refuseConsent();
    await expect(first).resolves.toBe(false);
    expect(env.local.token).toBeNull();
    expect(env.guestHome).toHaveBeenCalledTimes(1);
    await expect(env.controller.askConsent([pending])).resolves.toBe(false);
    expect(env.controller.snapshot().consent).toEqual([]);
    env.local.now += 30_000;
    const next = env.controller.askConsent([pending]);
    expect(env.controller.snapshot().consent).toEqual([pending]);
    env.controller.clear();
    await expect(next).resolves.toBe(false);
  });
  it("同意失败留在阻断层；仍有待签协议不提前重放，晚到回执不能恢复退出的账号", async () => {
    const env = setup();
    const waiting = env.controller.askConsent([pending]);
    vi.mocked(env.api.consent).mockRejectedValueOnce(failure("NETWORK_ERROR", 0));
    await env.controller.acceptConsent();
    expect(env.controller.snapshot().consentError).toBeTruthy();
    expect(env.controller.snapshot().consent).toHaveLength(1);
    vi.mocked(env.api.consent).mockResolvedValueOnce({ consents: [], pendingConsents: [pending] });
    vi.mocked(env.api.me).mockResolvedValueOnce(makeMe(false, true));
    await env.controller.acceptConsent();
    expect(env.controller.snapshot().consent).toHaveLength(1);
    const late = deferred<Data<"m.agreementConsent.create">>();
    vi.mocked(env.api.consent).mockReturnValueOnce(late.promise);
    const accepting = env.controller.acceptConsent();
    env.controller.clear();
    late.resolve({ consents: [], pendingConsents: [] });
    await accepting;
    await expect(waiting).resolves.toBe(false);
    expect(env.controller.snapshot().me).toBeNull();
  });
  it("切店先本地/清缓存再重拉/记住/埋点；记住失败不回滚且重试沿用键；旧overview不能覆盖", async () => {
    const env = setup();
    await env.controller.start();
    await env.controller.loadMine();
    const late = deferred<Data<"m.me.overview.get">>();
    vi.mocked(env.api.overview).mockReturnValueOnce(late.promise);
    const oldRead = env.controller.loadMine();
    await vi.waitFor(() => expect(env.api.overview).toHaveBeenCalledTimes(2));
    env.events.length = 0;
    vi.mocked(env.api.remember).mockRejectedValue(failure("NETWORK_ERROR", 0));
    const second = makeMe().memberships[0]!.stores[1]!.storeId;
    const switching = env.controller.switchStore(second, "南山店", "mine");
    expect(env.controller.snapshot().overview).toBeNull();
    await switching;
    expect(env.events).toEqual(["local", "me", "overview", "store_switch"]);
    expect(env.local.storeId).toBe(second);
    expect(env.controller.snapshot().overview?.currentStore.storeId).toBe(second);
    late.resolve(makeOverview());
    await oldRead;
    expect(env.controller.snapshot().overview?.currentStore.storeId).toBe(second);
    await env.controller.switchStore(second, "南山店", "mine");
    expect(env.key).toHaveBeenCalledTimes(1);
    expect(vi.mocked(env.api.remember).mock.calls.map((call) => call[1])).toEqual([
      env.key.mock.results[0]!.value,
      env.key.mock.results[0]!.value,
    ]);
    expect(env.toast).toHaveBeenCalledWith("门店已切换，本次选择暂未保存");
    expect(env.toast).toHaveBeenCalledWith("已切换到 南山店");
  });
  it("迟到me/门店列表与退出后的静默结果不能覆盖新上下文；无门店不取聚合", async () => {
    const env = setup();
    await env.controller.start();
    const late = deferred<Me>();
    vi.mocked(env.api.me).mockReturnValueOnce(late.promise);
    const reading = env.controller.reloadMe();
    const second = makeMe().memberships[0]!.stores[1]!.storeId;
    await env.controller.switchStore(second, "南山店", "mine");
    late.resolve({ ...makeMe(), memberships: [] });
    await reading;
    expect(env.local.storeId).toBe(second);
    const stores = deferred<Data<"m.store.list">>();
    vi.mocked(env.api.stores).mockReturnValueOnce(stores.promise);
    const opening = env.controller.openSwitcher();
    env.controller.clear();
    stores.resolve(makeStores());
    await opening;
    expect(env.controller.snapshot().stores).toBeNull();
    const silent = deferred<Data<"m.session.create">>();
    vi.mocked(env.api.silent).mockReturnValueOnce(silent.promise);
    const restore = env.controller.silentLogin("code");
    env.controller.clear();
    silent.resolve({ needPhone: false, token: "late", me: makeMe() });
    await expect(restore).resolves.toBe("failed");
    expect(env.local.token).toBeNull();
    const unbound = setup();
    vi.mocked(unbound.api.me).mockResolvedValue({ ...makeMe(), memberships: [] });
    await unbound.controller.loadMine();
    expect(unbound.api.overview).not.toHaveBeenCalled();
    expect(unbound.controller.snapshot().me?.memberships).toEqual([]);
  });
  it("退出的401与网络失败都清令牌、当前门店、概要和聚合", async () => {
    for (const error of [failure("AUTH_REQUIRED", 401), failure("NETWORK_ERROR", 0)]) {
      const env = setup();
      await env.controller.start();
      await env.controller.loadMine();
      vi.mocked(env.api.logout).mockRejectedValue(error);
      await env.controller.logout();
      expect(env.local.token).toBeNull();
      expect(env.local.storeId).toBeNull();
      expect(env.local.me).toBeNull();
      expect(env.controller.snapshot().overview).toBeNull();
      expect(env.guestHome).toHaveBeenCalledTimes(1);
    }
  });
});
