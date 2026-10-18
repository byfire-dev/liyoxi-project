import type { Me } from "@/lib/account-api";
import { messageScope } from "@/stores/messages-scope";
import type { ContractsApi, SignedItem, SignedPage, Version } from "./api";
import type { ContractDocument } from "./document";

export function contractContext(input: {
  token: string | null;
  storeId: string | null;
  contextRev: number;
  me: Me | null;
}): { key: string; role: "owner" | "clerk" | null } {
  const member = input.me?.memberships.find((item) =>
    item.stores.some((store) => store.storeId === input.storeId && store.lifecycle === "active"),
  );
  return {
    key: messageScope(input),
    role:
      input.token && member?.role === "owner"
        ? "owner"
        : input.token && member?.role === "clerk"
          ? "clerk"
          : null,
  };
}
const sceneNames: Readonly<Record<string, string>> = {
  login: "登录确认",
  reconsent: "版本更新确认",
  member_join: "加入门店",
  plan_purchase: "购买套餐",
  topup: "加购积分",
  order_submit: "订购短剧",
  ad_request: "申请广告",
};
export const sceneLabel = (scene: string) => sceneNames[scene] ?? "协议确认";

export interface ContractsState {
  page: SignedPage | null;
  total: number | null;
  loading: boolean;
  error: string | null;
  selected: SignedItem | null;
  body: Omit<Version, "pdf"> | null;
  bodyLoading: boolean;
  documentBusy: boolean;
  detailError: string | null;
}
const empty = (): ContractsState => ({
  page: null,
  total: null,
  loading: false,
  error: null,
  selected: null,
  body: null,
  bodyLoading: false,
  documentBusy: false,
  detailError: null,
});

export function createContractsModel(deps: {
  api: ContractsApi;
  document: ContractDocument;
  context(): { key: string; role: "owner" | "clerk" | null };
  changed(state: ContractsState): void;
  now(): number;
}) {
  let state = empty(),
    active = false,
    generation = 0,
    detailGeneration = 0;
  const set = (patch: Partial<ContractsState>) => {
    state = { ...state, ...patch };
    deps.changed(state);
  };
  const guard = () => {
    const own = generation,
      key = deps.context().key;
    return () => active && generation === own && deps.context().key === key;
  };
  async function load(more = false) {
    if (!active || state.loading || (more && !state.page?.hasMore)) return;
    const context = deps.context(),
      current = guard();
    if (!context.role) {
      set({ error: "请先登录并选择可访问的门店" });
      return;
    }
    set({ loading: true, error: null });
    try {
      const page = await deps.api.list(more ? (state.page?.nextCursor ?? undefined) : undefined);
      if (!current()) return;
      if (page.viewerRole !== context.role) throw new Error("当前身份已变化");
      const summary = !more && page.viewerRole === "owner" ? await deps.api.summary() : null;
      if (!current()) return;
      if (more && state.page?.viewerRole === page.viewerRole) {
        if (page.viewerRole === "owner" && state.page.viewerRole === "owner")
          page.items = [...state.page.items, ...page.items];
        else if (page.viewerRole === "clerk" && state.page.viewerRole === "clerk")
          page.items = [...state.page.items, ...page.items];
      }
      set({ page, total: page.viewerRole === "owner" ? (summary?.all ?? state.total) : null });
    } catch {
      if (current()) set({ error: "暂时无法加载已签协议，请重试" });
    } finally {
      if (current()) set({ loading: false });
    }
  }
  async function read(item: SignedItem) {
    if (!active || !state.page?.items.some((candidate) => candidate === item)) return;
    const own = ++detailGeneration,
      current = guard();
    deps.document.cancel();
    set({ selected: item, body: null, bodyLoading: true, documentBusy: false, detailError: null });
    try {
      const version = await deps.api.version(item.consentedVersion.agreementVersionId);
      if (!current() || own !== detailGeneration) return;
      if (version.agreementVersionId !== item.consentedVersion.agreementVersionId)
        throw new Error("协议版本不一致");
      const { pdf: _pdf, ...body } = version;
      set({ body });
    } catch {
      if (current() && own === detailGeneration)
        set({ detailError: "暂时无法加载所签版本，请重试" });
    } finally {
      if (current() && own === detailGeneration) set({ bodyLoading: false });
    }
  }
  return {
    snapshot: () => state,
    async show() {
      active = true;
      generation++;
      detailGeneration++;
      deps.document.cancel();
      state = empty();
      await load();
    },
    hide() {
      active = false;
      generation++;
      detailGeneration++;
      deps.document.cancel();
      state = empty();
      deps.changed(state);
    },
    load,
    read,
    closeDetail() {
      detailGeneration++;
      deps.document.cancel();
      set({
        selected: null,
        body: null,
        bodyLoading: false,
        documentBusy: false,
        detailError: null,
      });
    },
    async openPdf() {
      const item = state.selected;
      if (!active || !item || state.documentBusy) return;
      const own = detailGeneration,
        valid = guard();
      const current = () => valid() && own === detailGeneration;
      set({ documentBusy: true, detailError: null });
      try {
        // 正文 GET 的地址不保存、不复用；每次点击都现签同一已签版本。
        const version = await deps.api.version(item.consentedVersion.agreementVersionId);
        if (!current()) return;
        if (
          version.agreementVersionId !== item.consentedVersion.agreementVersionId ||
          !version.pdf.url ||
          !Number.isFinite(Date.parse(version.pdf.expiresAt)) ||
          Date.parse(version.pdf.expiresAt) <= deps.now()
        )
          throw new Error("PDF暂不可用");
        await deps.document.open(version.pdf.url, current);
      } catch {
        if (current()) set({ detailError: "PDF暂时无法打开，请重试" });
      } finally {
        if (current()) set({ documentBusy: false });
      }
    },
  };
}
