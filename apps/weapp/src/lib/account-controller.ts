import type {
  AccountApi,
  Agreement,
  Attribution,
  Data,
  Me,
  Overview,
  PendingConsent,
  StoreList,
} from "./account-api";
import type { Clock } from "./platform";
import { ApiError } from "./request";

export interface AccountState {
  booting: boolean;
  agreementVisible: boolean;
  me: Me | null;
  overview: Overview | null;
  agreements: Agreement[];
  stores: StoreList | null;
  switching: boolean;
  consent: PendingConsent[];
  consentBusy: boolean;
  consentError: string | null;
  switchVisible: boolean;
  error: string | null;
  switchedFrom: string | null;
}
export interface AccountDeps {
  api: AccountApi;
  clock: Pick<Clock, "now">;
  token(): string | null;
  setSession(token: string, me: Me): void;
  setMe(me: Me): void;
  clearSession(): void;
  store(): { currentStoreId: string | null; contextRev: number };
  setStore(id: string | null): void;
  loginCode(): Promise<string>;
  attribution(): Attribution;
  key(): string;
  applyBootstrap(value: Data<"m.bootstrap.get">): void;
  returnPage(): Promise<void>;
  guestHome(): Promise<void>;
  toast(message: string): void;
  track(
    name: "app_launch" | "store_switch",
    props: { channelCode?: string; hasInvitation?: boolean; fromPage?: string },
  ): void;
}
const INITIAL: AccountState = {
  booting: true,
  agreementVisible: false,
  me: null,
  overview: null,
  agreements: [],
  stores: null,
  switching: false,
  consent: [],
  consentBusy: false,
  consentError: null,
  switchVisible: false,
  error: null,
  switchedFrom: null,
};
export function accountError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.error) {
      case "ACCOUNT_DISABLED":
        return "账号已停用，请联系服务经理确认账号状态";
      case "REVERIFY_REQUIRED":
        return "该号码需要再次核验，请联系服务经理处理";
      case "WECHAT_UNAVAILABLE":
        return "登录服务暂不可用，请稍后重试";
      case "WECHAT_CODE_INVALID":
        return "登录凭证已过期，请重新登录";
      case "PHONE_REGION_UNSUPPORTED":
        return "暂不支持该地区的手机号，请使用中国大陆号码";
      case "AGREEMENT_VERSION_STALE":
        return "协议已更新，请重新阅读并勾选";
      case "NOT_A_MEMBER":
        return "门店权限已变化，请重新选择门店";
      default:
        return "暂时无法加载，请重试";
    }
  }
  return "暂时无法加载，请重试";
}
function pendingFrom(value: unknown): PendingConsent[] {
  const array: unknown = Array.isArray(value)
    ? value
    : value !== null && typeof value === "object" && "pendingConsents" in value
      ? value.pendingConsents
      : [];
  if (!Array.isArray(array)) return [];
  return array.filter(
    (item): item is PendingConsent =>
      item !== null &&
      typeof item === "object" &&
      [
        "agreementKey",
        "agreementVersionId",
        "name",
        "versionLabel",
        "effectiveAt",
        "summary",
      ].every((key) => typeof (item as Record<string, unknown>)[key] === "string"),
  );
}

/** 无平台依赖的编排；所有业务 DTO 均来自生成契约。 */
export function createAccountController(deps: AccountDeps) {
  let state = { ...INITIAL };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<AccountState>) => {
    state = { ...state, ...patch };
    listeners.forEach((run) => run());
  };
  let bootstrapFlight: Promise<Data<"m.bootstrap.get">> | null = null;
  let startFlight: Promise<void> | null = null;
  let consentFlight: Promise<boolean> | null = null;
  let resolveConsent: ((accepted: boolean) => void) | null = null;
  let refusedAt: number | null = null;
  let generation = 0;
  const switchKeys = new Map<string, string>();
  const api = deps.api;
  const finishConsent = (accepted: boolean) => {
    const resolve = resolveConsent;
    resolveConsent = null;
    consentFlight = null;
    update({ consent: [], consentBusy: false, consentError: null });
    resolve?.(accepted);
  };
  const applyMe = (me: Me, preferred?: string | null) => {
    deps.setMe(me);
    const stores = me.memberships.flatMap((item) => item.stores);
    const candidate = preferred ?? deps.store().currentStoreId;
    const selected =
      stores.find((item) => item.storeId === candidate)?.storeId ??
      me.memberships
        .map((item) => item.lastStoreId)
        .find((id) => id && stores.some((item) => item.storeId === id)) ??
      stores[0]?.storeId ??
      null;
    if (selected !== deps.store().currentStoreId) {
      deps.setStore(selected);
      update({ overview: null, stores: null });
    }
    update({ me });
    if (me.pendingConsents.length) void controller.askConsent(me.pendingConsents);
  };
  const adoptSession = (token: string, me: Me) => {
    if (state.me && state.me.user.merchantUserId !== me.user.merchantUserId) {
      generation += 1;
      switchKeys.clear();
      finishConsent(false);
      update({
        overview: null,
        stores: null,
        error: null,
        switchedFrom: null,
        switching: false,
        switchVisible: false,
      });
    }
    update({ error: null, overview: null, stores: null });
    deps.setSession(token, me);
    applyMe(me);
  };
  const controller = {
    snapshot: () => state,
    subscribe: (run: () => void) => {
      listeners.add(run);
      return () => {
        listeners.delete(run);
      };
    },
    bootstrap: () => {
      bootstrapFlight ??= api
        .bootstrap()
        .then((value) => {
          deps.applyBootstrap(value);
          return value;
        })
        .finally(() => {
          bootstrapFlight = null;
        });
      return bootstrapFlight;
    },
    async start() {
      startFlight ??= (async () => {
        const epoch = generation;
        let preferred: string | null = null;
        try {
          preferred = (await controller.bootstrap()).context?.storeId ?? null;
        } catch {
          /* 默认/缓存继续可用 */
        }
        if (epoch !== generation) return;
        try {
          if (deps.token()) await controller.reloadMe(preferred);
          else await controller.silentLogin(await deps.loginCode());
        } catch (error) {
          update({ error: accountError(error) });
        } finally {
          update({ booting: false });
        }
        const source = deps.attribution();
        deps.track("app_launch", {
          ...(source.channelCode ? { channelCode: source.channelCode } : {}),
          hasInvitation: Boolean(source.inviteCode),
        });
      })();
      return startFlight;
    },
    async silentLogin(loginCode: string): Promise<"ok" | "needPhone" | "failed"> {
      const epoch = generation;
      const result = await api.silent(loginCode);
      if (epoch !== generation) return "failed";
      if (result.needPhone || !result.token || !result.me) return "needPhone";
      adoptSession(result.token, result.me);
      return "ok";
    },
    async reloadMe(preferred?: string | null) {
      const epoch = generation;
      const token = deps.token();
      const revision = deps.store().contextRev;
      const me = await api.me();
      if (
        epoch === generation &&
        token === deps.token() &&
        token &&
        revision === deps.store().contextRev
      )
        applyMe(me, preferred);
    },
    async loadMine() {
      if (!deps.token()) {
        update({ overview: null, me: null, error: null });
        return;
      }
      await controller.reloadMe();
      const selected = deps.store();
      const token = deps.token();
      if (!selected.currentStoreId) {
        update({ overview: null });
        return;
      }
      try {
        const overview = await api.overview();
        const current = deps.store();
        if (
          current.contextRev === selected.contextRev &&
          current.currentStoreId === selected.currentStoreId &&
          token === deps.token()
        )
          update({ overview, error: null });
      } catch (error) {
        if (selected.contextRev === deps.store().contextRev && token === deps.token())
          update({ error: accountError(error) });
      }
    },
    async loadAgreements() {
      const agreements = await api.agreements();
      update({ agreements });
      return agreements;
    },
    agreement: api.agreement,
    showAgreement: (visible: boolean) => update({ agreementVisible: visible }),
    async phoneLogin(phone: string, agreed: boolean) {
      if (!agreed) throw new Error("请先阅读并勾选下方协议");
      if (!/^1\d{10}$/.test(phone)) throw new Error("请填写有效的11位手机号");
      const current = state.agreements.filter((item) => item.currentVersion !== null);
      if (!current.length || current.length > 2) throw new Error("协议暂不可用，请重新加载");
      const epoch = generation;
      try {
        const result = await api.phone({
          loginCode: await deps.loginCode(),
          phoneCode: phone,
          consents: current.map((item) => ({
            agreementKey: item.agreementKey,
            agreementVersionId: item.currentVersion!.agreementVersionId,
          })),
          attribution: deps.attribution(),
        });
        if (epoch !== generation) return;
        adoptSession(result.token, result.me);
        if (result.switchedFrom) update({ switchedFrom: result.switchedFrom.phoneMask });
        await deps.returnPage();
      } catch (error) {
        if (error instanceof ApiError && error.error === "AGREEMENT_VERSION_STALE") {
          await controller.loadAgreements().catch(() => undefined);
        }
        throw error;
      }
    },
    clear() {
      generation += 1;
      deps.clearSession();
      deps.setStore(null);
      switchKeys.clear();
      finishConsent(false);
      update({ ...INITIAL, booting: false });
    },
    async logout() {
      try {
        if (deps.token()) await api.logout();
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401))
          deps.toast("已退出本机账号，网络恢复后可重新登录");
      } finally {
        controller.clear();
        await deps.guestHome();
      }
    },
    askConsent(details: unknown): Promise<boolean> {
      const pending = pendingFrom(details);
      if (refusedAt !== null && deps.clock.now() - refusedAt < 30_000)
        return Promise.resolve(false);
      if (!pending.length) return Promise.resolve(false);
      const merged = new Map(state.consent.map((item) => [item.agreementKey, item]));
      for (const item of pending) {
        const previous = merged.get(item.agreementKey);
        if (!previous || item.effectiveAt >= previous.effectiveAt)
          merged.set(item.agreementKey, item);
      }
      update({ consent: [...merged.values()] });
      consentFlight ??= new Promise((resolve) => {
        resolveConsent = resolve;
      });
      return consentFlight;
    },
    async acceptConsent() {
      if (state.consentBusy || !state.consent.length) return;
      const epoch = generation;
      update({ consentBusy: true, consentError: null });
      try {
        const receipt = await api.consent(state.consent.slice(0, 2));
        if (epoch !== generation) return;
        update({ consent: receipt.pendingConsents });
        await controller.reloadMe();
        if (!state.consent.length) finishConsent(true);
      } catch (error) {
        if (error instanceof ApiError && error.error === "AGREEMENT_VERSION_STALE")
          await controller.reloadMe().catch(() => undefined);
        if (epoch === generation) update({ consentError: accountError(error) });
      } finally {
        if (epoch === generation) update({ consentBusy: false });
      }
    },
    async refuseConsent() {
      if (state.consentBusy) return;
      refusedAt = deps.clock.now();
      finishConsent(false);
      await controller.logout();
    },
    async openSwitcher() {
      update({ switchVisible: true });
      const epoch = generation;
      const revision = deps.store().contextRev;
      try {
        const stores = await api.stores();
        if (epoch === generation && revision === deps.store().contextRev)
          update({ stores, error: null });
      } catch (error) {
        if (epoch === generation && revision === deps.store().contextRev)
          update({ error: accountError(error) });
      }
    },
    closeSwitcher: () => update({ switchVisible: false }),
    dismissSwitchNotice: () => update({ switchedFrom: null }),
    async switchStore(storeId: string, name: string, fromPage: string) {
      if (
        state.switching ||
        !state.me?.memberships.some((item) =>
          item.stores.some((store) => store.storeId === storeId),
        )
      )
        return;
      const key = switchKeys.get(storeId) ?? deps.key();
      switchKeys.set(storeId, key);
      deps.setStore(storeId);
      update({ overview: null, stores: null, switching: true, error: null });
      const selected = deps.store();
      try {
        await controller.loadMine();
        await api.remember(storeId, key);
        switchKeys.delete(storeId);
      } catch {
        if (selected.contextRev === deps.store().contextRev)
          deps.toast("门店已切换，本次选择暂未保存");
      } finally {
        if (selected.contextRev === deps.store().contextRev && deps.token()) {
          deps.track("store_switch", { fromPage });
          deps.toast(`已切换到 ${name}`);
          update({ switching: false, switchVisible: false });
        }
      }
    },
  };
  return controller;
}
export type AccountController = ReturnType<typeof createAccountController>;
