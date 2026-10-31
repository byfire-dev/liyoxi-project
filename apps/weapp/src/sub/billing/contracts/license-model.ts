import type { Me } from "@/lib/account-api";
import { ApiError } from "@/lib/request";
import { messageScope } from "@/stores/messages-scope";
import type { ContractDocument } from "./document";
import type {
  LicenseApi,
  LicenseCard,
  LicenseDetail,
  LicensePage,
  LicenseSummary,
} from "./license-api";

export function licenseContext(input: {
  token: string | null;
  storeId: string | null;
  contextRev: number;
  me: Me | null;
}) {
  const membership = input.me?.memberships.find((member) =>
    member.stores.some((store) => store.storeId === input.storeId),
  );
  // contract.read is a subject-level capability: an archived store's owner may still read evidence.
  const role = input.token && input.storeId ? membership?.role : null;
  return {
    key: messageScope(input),
    storeId: input.storeId,
    role: role === "owner" || role === "clerk" ? role : null,
  };
}
export type LicenseContext = ReturnType<typeof licenseContext> & { orderId?: string };
// C29: same boundary as contract/common/scalars.ts UUID_V7_PATTERN; keep the client type-only.
const orderIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const scopeKey = (context: LicenseContext) =>
  JSON.stringify([context.key, context.storeId, context.orderId ?? null]);

export interface LicenseState {
  page: LicensePage | null;
  summary: LicenseSummary | null;
  loading: boolean;
  restricted: boolean;
  error: string | null;
  selected: LicenseCard | null;
  detail: LicenseDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  documentBusy: boolean;
}
const empty = (): LicenseState => ({
  page: null,
  summary: null,
  loading: false,
  restricted: false,
  error: null,
  selected: null,
  detail: null,
  detailLoading: false,
  detailError: null,
  documentBusy: false,
});

function documentError(error: unknown) {
  if (error instanceof ApiError && error.error === "LICENSE_LETTER_NOT_READY") {
    const status = (error.details as { renderStatus?: unknown } | null)?.renderStatus;
    return status === "failed"
      ? "PDF生成失败，请联系服务经理处理后重新获取"
      : "PDF尚未生成完成，请稍后重新获取";
  }
  return "PDF暂时无法打开，请重试获取";
}

export function createLicenseModel(deps: {
  api: LicenseApi;
  document: ContractDocument;
  context(): LicenseContext;
  changed(state: LicenseState): void;
  now(): number;
}) {
  let state = empty(),
    active = false,
    generation = 0,
    detailGeneration = 0;
  let pageKey: string | null = null;
  const set = (patch: Partial<LicenseState>) => {
    state = { ...state, ...patch };
    deps.changed(state);
  };
  const guard = () => {
    const own = generation,
      captured = deps.context();
    return () => {
      const current = deps.context();
      return (
        active &&
        generation === own &&
        captured.key === current.key &&
        captured.storeId === current.storeId &&
        captured.orderId === current.orderId &&
        current.role === "owner"
      );
    };
  };
  async function load(more = false) {
    if (!active || state.loading || (more && !state.page?.hasMore)) return;
    const context = deps.context();
    if (context.role !== "owner" || !context.storeId) {
      set({ restricted: true });
      return;
    }
    if (context.orderId !== undefined && !orderIdPattern.test(context.orderId)) {
      closeDetail();
      pageKey = null;
      set({
        page: null,
        summary: null,
        loading: false,
        error: "订单参数无效，请从订单详情重新进入",
      });
      return;
    }
    const current = guard();
    const filter = { storeId: context.storeId, orderId: context.orderId, includeVoided: true };
    set({ loading: true, error: null });
    try {
      const page = await deps.api.list(
        filter,
        more ? (state.page?.nextCursor ?? undefined) : undefined,
      );
      if (!current()) return;
      if (
        page.items.some(
          (item) =>
            item.storeId !== context.storeId ||
            (context.orderId && item.orderId !== context.orderId),
        )
      )
        throw new Error("授权范围已变化");
      const summary = more ? state.summary : await deps.api.summary(filter);
      if (!current()) return;
      const items =
        more && state.page
          ? [
              ...new Map(
                [...state.page.items, ...page.items].map((item) => [item.licenseLetterId, item]),
              ).values(),
            ]
          : page.items;
      pageKey = scopeKey(context);
      set({ page: { ...page, items }, summary });
    } catch {
      if (current()) set({ error: "暂时无法加载授权书，请重试" });
    } finally {
      if (current()) set({ loading: false });
    }
  }
  function closeDetail() {
    detailGeneration++;
    deps.document.cancel();
    set({
      selected: null,
      detail: null,
      detailLoading: false,
      detailError: null,
      documentBusy: false,
    });
  }
  async function read(item: LicenseCard) {
    const context = deps.context();
    if (
      !active ||
      context.role !== "owner" ||
      scopeKey(context) !== pageKey ||
      item.storeId !== context.storeId ||
      (context.orderId && item.orderId !== context.orderId) ||
      !state.page?.items.some((candidate) => candidate === item)
    )
      return;
    const own = ++detailGeneration,
      valid = guard();
    const current = () => valid() && own === detailGeneration;
    deps.document.cancel();
    set({
      selected: item,
      detail: null,
      detailLoading: true,
      detailError: null,
      documentBusy: false,
    });
    try {
      const detail = await deps.api.get(item.licenseLetterId);
      if (!current()) return;
      if (
        detail.licenseLetterId !== item.licenseLetterId ||
        detail.storeId !== item.storeId ||
        detail.orderId !== item.orderId
      )
        throw new Error("授权范围已变化");
      set({ detail });
    } catch {
      if (current()) set({ detailError: "暂时无法加载授权详情，请重试" });
    } finally {
      if (current()) set({ detailLoading: false });
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
      pageKey = null;
      deps.changed(state);
      await load();
    },
    hide() {
      active = false;
      generation++;
      detailGeneration++;
      deps.document.cancel();
      state = empty();
      pageKey = null;
      deps.changed(state);
    },
    load,
    read,
    closeDetail,
    async openPdf(revNo?: number) {
      const detail = state.detail;
      const context = deps.context();
      if (
        !active ||
        !detail ||
        state.documentBusy ||
        context.role !== "owner" ||
        scopeKey(context) !== pageKey ||
        detail.storeId !== context.storeId
      )
        return;
      if (
        revNo === undefined
          ? !detail.canDownload
          : !detail.revisions.some((row) => row.revNo === revNo)
      )
        return;
      const own = ++detailGeneration,
        valid = guard();
      const current = () => valid() && own === detailGeneration;
      deps.document.cancel();
      set({ documentBusy: true, detailError: null });
      try {
        const signed = await deps.api.download(detail.licenseLetterId, revNo);
        if (!current()) return;
        if (
          signed.revNo !== (revNo ?? detail.currentRevNo) ||
          !signed.url ||
          !Number.isFinite(Date.parse(signed.expiresAt)) ||
          Date.parse(signed.expiresAt) <= deps.now()
        )
          throw new Error("PDF地址已失效，请重新获取");
        await deps.document.open(signed.url, current);
      } catch (error) {
        if (current()) set({ detailError: documentError(error) });
      } finally {
        if (current()) set({ documentBusy: false });
      }
    },
  };
}
export type LicenseModel = ReturnType<typeof createLicenseModel>;
