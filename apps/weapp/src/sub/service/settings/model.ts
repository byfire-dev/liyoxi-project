import { ApiError } from "@/lib/request";
import { sha1 } from "@/lib/upload/hash";
import type { Agreement, Body, Computer, Data, Identity, Me, SettingsApi } from "./api";

export function settingsPortalMembership(me: Me | null, storeId: string | null) {
  return me?.memberships.find((member) => member.stores.some((store) => store.storeId === storeId));
}
export function canManageComputers(me: Me | null, storeId: string | null): boolean {
  // Archived owner stores retain portal.authorize; the backend rechecks each request.
  return Boolean(storeId && settingsPortalMembership(me, storeId)?.role === "owner");
}
export function settingsPortalIdentity(me: Me | null, storeId: string | null): string {
  const member = settingsPortalMembership(me, storeId);
  return JSON.stringify([
    me?.user.merchantUserId,
    member?.memberId,
    member?.entity.entityId,
    member?.role,
  ]);
}

const blockerLabels = {
  subscription_active: "生效套餐",
  payment_open: "未完结付款",
  refund_open: "未完结退款",
  invoice_open: "未完结开票",
  open_order: "在办订购",
  release_online: "上线中的成片",
};
export function deletionBlockers(error: unknown): { label: string; count: number }[] {
  if (!(error instanceof ApiError) || error.error !== "ACCOUNT_DELETION_BLOCKED") return [];
  const details = error.details;
  if (
    !details ||
    typeof details !== "object" ||
    !("blockers" in details) ||
    !Array.isArray(details.blockers)
  )
    return [];
  return details.blockers.flatMap((row: unknown) => {
    if (!row || typeof row !== "object" || !("kind" in row) || !("count" in row)) return [];
    const label = Object.entries(blockerLabels).find(([kind]) => kind === row.kind)?.[1];
    return label && typeof row.count === "number" && Number.isInteger(row.count) && row.count > 0
      ? [{ label, count: row.count }]
      : [];
  });
}
export function settingsError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.error === "SMS_UNAVAILABLE") return "短信验证暂不可用，换绑手机号请联系客服";
    if (error.error === "WECHAT_CODE_INVALID") return "号码授权已失效，请重新点击授权按钮";
    if (error.error === "WECHAT_UNAVAILABLE") return "手机号验证暂不可用，请稍后重试";
    if (error.error === "PHONE_REGION_UNSUPPORTED") return "暂只支持中国大陆手机号";
    if (error.error === "PHONE_UNCHANGED") return "新手机号与当前手机号相同";
    if (error.error === "PHONE_TAKEN") return "该手机号已被其他账号使用，请联系客服";
    const details = error.details;
    if (
      error.error === "SMS_CODE_INVALID" &&
      details &&
      typeof details === "object" &&
      "attemptsLeft" in details
    )
      return typeof details.attemptsLeft === "number"
        ? `验证码错误，还可尝试 ${details.attemptsLeft} 次`
        : "验证码已失效，请重新获取";
    if (
      error.error === "IDENTITY_TOO_NEW" &&
      details &&
      typeof details === "object" &&
      "removableAt" in details &&
      typeof details.removableAt === "string"
    )
      return `当前登录身份绑定时间较短，可在 ${details.removableAt} 后移除其他身份`;
    return error.message;
  }
  return "暂时未能完成，请重试";
}
export interface SettingsState {
  me: Me | null;
  agreements: Agreement[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  busy: string | null;
  success: string | null;
  identities: Identity[];
  identitiesLoaded: boolean;
  identitiesLoading: boolean;
  cursor: string | null;
  hasMore: boolean;
  identityError: string | null;
  sms: Data<"m.smsCode.create"> | null;
  resendAt: number;
  blockers: { label: string; count: number }[];
  phoneRetryAvailable: boolean;
  computers: Computer[];
  computersLoaded: boolean;
  computersLoading: boolean;
  computerError: string | null;
  computerResult: Computer | null;
}
export function createSettingsController(deps: {
  api: SettingsApi;
  scope: () => string;
  initialScope?: string;
  authenticated: () => boolean;
  portalAllowed: (me: Me | null) => boolean;
  key: (action: string) => string;
  now: () => number;
  reloadMe: () => Promise<void>;
  clear: () => void;
  gotoLogin: () => void;
  logout: () => Promise<void>;
}) {
  const scope = deps.initialScope ?? deps.scope(),
    salt = deps.key("settings_intent");
  let alive = true,
    revision = 0,
    identityRevision = 0,
    computerRevision = 0,
    owner: symbol | null = null;
  let smsIntent = 0;
  let pendingPhone: Body<"m.me.changePhone"> | null = null;
  const keys = new Map<string, string>(),
    listeners = new Set<() => void>();
  let state: SettingsState = {
    me: null,
    agreements: [],
    loading: false,
    loaded: false,
    error: null,
    busy: null,
    success: null,
    identities: [],
    identitiesLoaded: false,
    identitiesLoading: false,
    cursor: null,
    hasMore: false,
    identityError: null,
    sms: null,
    resendAt: 0,
    blockers: [],
    phoneRetryAvailable: false,
    computers: [],
    computersLoaded: false,
    computersLoading: false,
    computerError: null,
    computerResult: null,
  };
  const current = () => alive && deps.scope() === scope;
  const update = (patch: Partial<SettingsState>) => {
    if (!current()) return;
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  const signedOut = (error: unknown) => {
    if (current() && error instanceof ApiError && error.status === 401) {
      deps.clear();
      deps.gotoLogin();
      return true;
    }
    return false;
  };
  const portalAllowed = () => current() && deps.authenticated() && deps.portalAllowed(state.me);
  const clearComputers = () => {
    computerRevision++;
    update({
      computers: [],
      computersLoaded: false,
      computersLoading: false,
      computerResult: null,
    });
  };
  const computers = async (internal = false) => {
    if (!current() || (!internal && owner)) return;
    if (!portalAllowed()) {
      clearComputers();
      return;
    }
    const run = ++computerRevision;
    update({ computersLoading: true, computerError: null });
    try {
      const result = await deps.api.computers();
      if (!current() || run !== computerRevision) return;
      if (!portalAllowed()) {
        clearComputers();
        return;
      }
      // The API includes this author's active sessions throughout the current entity.
      update({ computers: result.items, computersLoaded: true });
    } catch (error) {
      if (!current() || run !== computerRevision || signedOut(error)) return;
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        clearComputers();
        update({ computerError: settingsError(error) });
        await deps.reloadMe().catch(() => undefined);
      } else update({ computerError: settingsError(error) });
    } finally {
      if (run === computerRevision) update({ computersLoading: false });
    }
  };
  const identities = async (more = false, internal = false) => {
    if (
      !current() ||
      !deps.authenticated() ||
      (!internal && owner) ||
      state.identitiesLoading ||
      (more && (!state.hasMore || !state.cursor))
    )
      return;
    const run = ++identityRevision,
      cursor = more ? state.cursor : null;
    update({ identitiesLoading: true, identityError: null });
    try {
      const page = await deps.api.identities(cursor);
      if (!current() || run !== identityRevision) return;
      const rows = more ? [...state.identities, ...page.items] : page.items;
      update({
        identities: [...new Map(rows.map((row) => [row.wechatIdentityId, row])).values()],
        cursor: page.nextCursor,
        hasMore: page.hasMore,
      });
    } catch (error) {
      if (run === identityRevision && !signedOut(error))
        update({ identityError: settingsError(error) });
    } finally {
      if (run === identityRevision) update({ identitiesLoading: false, identitiesLoaded: true });
    }
  };
  const refresh = async (internal = false) => {
    if (!current() || (!internal && owner)) return;
    const run = ++revision;
    update({ loading: true, error: null });
    try {
      const readAgreements = async () => {
        const items: Agreement[] = [];
        let cursor: string | null = null;
        do {
          const page = await deps.api.agreements(cursor);
          if (!current() || run !== revision) return [];
          items.push(...page.items);
          cursor = page.hasMore ? page.nextCursor : null;
        } while (cursor);
        return items.filter((item) => item.currentVersion);
      };
      const [me, agreements] = await Promise.all([
        deps.authenticated() ? deps.api.me() : null,
        readAgreements(),
      ]);
      if (run === revision) {
        update({ me, agreements });
        if (!portalAllowed()) clearComputers();
        else if (state.computersLoaded) await computers(true);
      }
    } catch (error) {
      if (run === revision && !signedOut(error)) update({ error: settingsError(error) });
    } finally {
      if (run === revision) update({ loading: false, loaded: true });
    }
  };
  const write = async <T>(
    action: string,
    content: unknown,
    call: (key: string) => Promise<T>,
    effect?: (result: T) => boolean | Promise<boolean>,
    onFailure?: (error: unknown) => void | Promise<void>,
  ) => {
    if (!current() || owner || !deps.authenticated()) return false;
    const mine = Symbol(action);
    owner = mine;
    revision++;
    identityRevision++;
    computerRevision++;
    update({
      busy: action,
      error: null,
      success: null,
      blockers: [],
      loading: false,
      identitiesLoading: false,
      computersLoading: false,
    });
    // keys 只保留加盐摘要；未决换绑 body 仅短期内存，按下述生命周期清理，不日志或持久化。
    const signature = `${action}:${sha1(salt + JSON.stringify(content))}`;
    const key = keys.get(signature) ?? deps.key(action);
    keys.set(signature, key);
    try {
      const result = await call(key);
      keys.delete(signature);
      if (!current()) return false;
      if (await effect?.(result)) return true;
      if (!current()) return false;
      update({ success: "操作已完成" });
      await deps.reloadMe().catch(() => undefined);
      if (!current()) return false;
      await refresh(true);
      if (state.identitiesLoaded) await identities(false, true);
      return current();
    } catch (error) {
      if (!current()) return false;
      await onFailure?.(error);
      if (!current()) return false;
      if (!signedOut(error))
        update({ error: settingsError(error), blockers: deletionBlockers(error) });
      return false;
    } finally {
      if (owner === mine) {
        owner = null;
        update({ busy: null });
      }
    }
  };
  const forgetPhone = () => {
    if (pendingPhone) keys.delete(`phone_change:${sha1(salt + JSON.stringify(pendingPhone))}`);
    pendingPhone = null;
    update({ phoneRetryAvailable: false });
  };
  const changePhone = (body: Body<"m.me.changePhone">) =>
    write(
      "phone_change",
      body,
      (key) => deps.api.changePhone(body, key),
      () => {
        forgetPhone();
        return false;
      },
      (error) => {
        if (error instanceof ApiError && (error.retryable || error.error === "NETWORK_ERROR")) {
          pendingPhone = body;
          update({ phoneRetryAvailable: true });
        } else {
          keys.delete(`phone_change:${sha1(salt + JSON.stringify(body))}`);
          forgetPhone();
        }
      },
    );
  const leave = () => {
    forgetPhone();
    deps.clear();
    deps.gotoLogin();
    return true;
  };
  return {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    refresh: () => refresh(),
    identities: () => identities(),
    moreIdentities: () => identities(true),
    canManageComputers: portalAllowed,
    computers: () => computers(),
    discardComputerIntent: () => {
      if (owner) return;
      for (const key of keys.keys()) if (key.startsWith("portal_session_revoke:")) keys.delete(key);
      update({ error: null });
    },
    closeComputers: () => {
      if (owner) return;
      computerRevision++;
      for (const key of keys.keys()) if (key.startsWith("portal_session_revoke:")) keys.delete(key);
      update({ computersLoading: false, computerResult: null });
    },
    revokeComputer: (id: string) => {
      if (
        !portalAllowed() ||
        state.computersLoading ||
        state.computerError ||
        !state.computers.some((row) => row.portalSessionId === id) ||
        state.computerResult?.portalSessionId === id
      )
        return Promise.resolve(false);
      return write(
        "portal_session_revoke",
        id,
        (key) => deps.api.revokeComputer(id, key),
        async (result) => {
          if (!portalAllowed()) {
            clearComputers();
            return true;
          }
          update({
            computerResult: result,
            success: result.revokedAt ? "已撤销这台电脑的授权" : "电脑授权状态已更新",
          });
          await computers(true);
          return true;
        },
        async (error) => {
          if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
            keys.delete(`portal_session_revoke:${sha1(salt + JSON.stringify(id))}`);
            clearComputers();
            update({ computerError: settingsError(error) });
            await deps.reloadMe().catch(() => undefined);
          }
        },
      );
    },
    updateName: (displayName: string) => {
      const value = displayName.trim();
      if ([...value].length < 1 || [...value].length > 20) {
        update({ error: "称呼须为1至20字" });
        return Promise.resolve(false);
      }
      return write("me_update", value, (key) => deps.api.update({ displayName: value }, key));
    },
    sendSms: () => {
      if (deps.now() < state.resendAt) return Promise.resolve(false);
      return write(
        "phone_sms",
        smsIntent,
        (key) => deps.api.sms(key),
        (sms) => {
          smsIntent++;
          update({
            sms,
            resendAt: deps.now() + sms.resendAfterSec * 1000,
            success: "验证码已发送至当前手机号",
          });
          return true;
        },
      );
    },
    changePhone: (data: Body<"m.me.changePhone">) => {
      if (owner) return Promise.resolve(false);
      forgetPhone();
      if (
        !/^\d{4,8}$/.test(data.oldSmsCode) ||
        !data.newPhoneCode ||
        data.newPhoneCode.length > 128
      ) {
        update({ error: "请输入当前手机号收到的验证码，并重新授权新号码" });
        return Promise.resolve(false);
      }
      return changePhone({ ...data });
    },
    retryPhone: () => (pendingPhone ? changePhone(pendingPhone) : Promise.resolve(false)),
    discardPhoneIntent: forgetPhone,
    remove: (item: Identity) =>
      write(
        "identity_remove",
        item.wechatIdentityId,
        (key) => deps.api.remove(item.wechatIdentityId, key),
        (result) => {
          return result.isCurrentSessionRevoked ? leave() : false;
        },
      ),
    acknowledge: (id: string) =>
      write("notice_acknowledge", id, (key) => deps.api.acknowledge(id, key)),
    deletion: () => write("account_deletion", true, (key) => deps.api.deletion(key), leave),
    logout: () =>
      write(
        "account_logout",
        true,
        async () => {
          await deps.logout();
        },
        () => true,
      ),
    dispose: () => {
      alive = false;
      revision++;
      identityRevision++;
      computerRevision++;
      owner = null;
      pendingPhone = null;
      keys.clear();
      listeners.clear();
    },
  };
}
export type SettingsController = ReturnType<typeof createSettingsController>;
