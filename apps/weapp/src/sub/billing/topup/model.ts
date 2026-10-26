import { capabilityByKey } from "@liyoxi/contract/authz";
import type { Agreement, Body, Data, Me } from "@/lib/account-api";
import { ApiError } from "@/lib/request";
import { messageScope } from "@/stores/messages-scope";
import { purchaseVisible } from "../wallet/model";
import type { TopupApi } from "./api";
import { purchaseAgreements } from "../plan-pick/model";

/** 与正式能力表同源；角色和门店生命周期也参与迟到回调的上下文身份。 */
export function purchaseContext(
  input: {
    token: string | null;
    storeId: string | null;
    contextRev: number;
    me: Me | null;
  },
  key: "points.topup" | "plan.purchase" = "points.topup",
) {
  const member = input.me?.memberships.find((m) =>
    m.stores.some((s) => s.storeId === input.storeId),
  );
  const store = member?.stores.find((s) => s.storeId === input.storeId);
  const capability = capabilityByKey(key);
  const access =
    member?.role === "owner"
      ? store?.lifecycle === "archived"
        ? capability?.archivedOwner
        : store?.lifecycle === "active"
          ? capability?.owner
          : undefined
      : member?.role === "clerk"
        ? capability?.clerk
        : undefined;
  return { key: messageScope(input), allowed: !!input.token && access?.allowed === true };
}
export interface TopupState {
  wallet: Data<"m.wallet.get"> | null;
  policy: Data<"m.purchasePolicy.get"> | null;
  packs: Data<"m.pointPack.list">["items"];
  agreements: Agreement[];
  selected: string | null;
  loading: boolean;
  restricted: boolean;
  error: string | null;
}
export function topupBlock(state: Pick<TopupState, "wallet" | "policy">): string | null {
  if (!state.policy || !purchaseVisible(state.policy)) return "暂未开放在线购买，请联系服务经理";
  if (!state.wallet?.topUp.canTopUp) {
    switch (state.wallet?.topUp.blockReason) {
      case "no_active_plan":
        return "开通有效套餐后可加购积分";
      case "refund_in_progress":
        return "退款处理中，暂不能加购积分";
      default:
        return "暂未开放积分加购，请联系服务经理";
    }
  }
  return null;
}
export function topupBody(
  state: Pick<TopupState, "wallet" | "policy" | "packs" | "agreements" | "selected">,
  channel: string,
): Body<"m.paymentOrder.create"> | null {
  const policy = state.policy;
  if (
    !policy ||
    topupBlock(state) ||
    (channel !== "bank_transfer" && channel !== "wechat_jsapi") ||
    !policy.channels.some((c) => c.code === channel && c.isEnabled)
  )
    return null;
  const pack = state.packs.find((p) => p.pointPackId === state.selected);
  const docs = purchaseAgreements(policy, state.agreements);
  if (
    !pack ||
    pack.priceFen === null ||
    pack.priceFen <= 0 ||
    docs.length === 0 ||
    docs.length !== policy.copy.agreementKeys.length
  )
    return null;
  return {
    pointPackId: pack.pointPackId,
    channel,
    expectAmountFen: pack.priceFen,
    agreementVersionIds: docs.map((doc) => doc.currentVersion.agreementVersionId),
  };
}
/** 确认的是所见积分数与价格，不仅是创建接口接收的字段。 */
export function topupConfirmationKey(
  state: Parameters<typeof topupBody>[0],
  channel: string,
): string | null {
  const body = topupBody(state, channel);
  const pack = state.packs.find((item) => item.pointPackId === state.selected);
  return body && pack ? JSON.stringify({ ...body, points: pack.points }) : null;
}
export function createTopupModel(deps: {
  api: TopupApi;
  prepare(): Promise<unknown>;
  context(): { key: string; allowed: boolean };
}) {
  const empty = (): TopupState => ({
    wallet: null,
    policy: null,
    packs: [],
    agreements: [],
    selected: null,
    loading: false,
    restricted: false,
    error: null,
  });
  let state = empty(),
    active = false,
    generation = 0,
    scope = "";
  const listeners = new Set<() => void>();
  const set = (patch: Partial<TopupState>) => {
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  async function refresh() {
    if (!active || scope !== deps.context().key || state.loading) return;
    const own = ++generation;
    const current = () => active && own === generation && scope === deps.context().key;
    set({ ...empty(), loading: true });
    try {
      await deps.prepare();
      if (!current()) return;
      if (!deps.context().allowed) {
        set({ restricted: true });
        return;
      }
      const [wallet, policy] = await Promise.all([deps.api.wallet(), deps.api.policy()]);
      if (!current()) return;
      set({ wallet, policy });
      if (topupBlock({ wallet, policy })) return;
      const [packs, agreements] = await Promise.all([deps.api.packs(), deps.api.agreements()]);
      if (current())
        set({
          packs: packs.items,
          agreements,
          selected: packs.items.find((p) => p.priceFen !== null)?.pointPackId ?? null,
        });
    } catch (failure) {
      if (!current()) return;
      if (
        failure instanceof ApiError &&
        [
          "ROLE_FORBIDDEN",
          "PERMISSION_DENIED",
          "NOT_A_MEMBER",
          "STORE_ARCHIVED",
          "NOT_FOUND",
        ].includes(failure.error)
      )
        set({ restricted: true, wallet: null, packs: [], agreements: [] });
      else set({ error: "暂时无法加载积分包，请重试" });
    } finally {
      if (current()) set({ loading: false });
    }
  }
  return {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    show() {
      if (active && scope === deps.context().key) return Promise.resolve();
      active = true;
      scope = deps.context().key;
      state = empty();
      return refresh();
    },
    hide() {
      active = false;
      generation++;
      state = empty();
    },
    refresh,
    isCurrent: () => active && scope === deps.context().key && deps.context().allowed,
    select(id: string) {
      if (
        active &&
        scope === deps.context().key &&
        state.packs.some((p) => p.pointPackId === id && p.priceFen !== null)
      )
        set({ selected: id });
    },
  };
}
