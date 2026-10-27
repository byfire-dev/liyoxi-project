import type { Data } from "../src/lib/account-api";
import { ApiError, type RequestLayer } from "../src/lib/request";

type Page = Data<"m.pointLedgerEntry.list">;
export function ledgerRow(overrides: Partial<Page["items"][number]> = {}): Page["items"][number] {
  return {
    rowKey: "00000000-0000-4000-8000-000000000101:plan",
    category: "gain",
    opType: "grant",
    lotKind: "plan",
    deltaPoints: 2160,
    occurredAt: "2026-09-30T16:00:00.000Z",
    bizDate: "2026-10-01",
    title: "发放本期套餐积分",
    remark: "专业版 · 本期套餐积分",
    formula: null,
    storeName: null,
    refNo: "FK202610010000001",
    itemCount: 1,
    holdStatus: null,
    ...overrides,
  };
}
export function ledgerPage(month = "2026-10", overrides: Partial<Page> = {}): Page {
  return {
    items: [
      ledgerRow(),
      ledgerRow({
        rowKey: "00000000-0000-4000-8000-000000000102:addon",
        category: "use",
        opType: "hold",
        lotKind: "addon",
        deltaPoints: -180,
        title: "订购《巷口那家店》",
        remark: "示例门店 · LYX202610010000001",
        storeName: "示例门店",
        refNo: "LYX202610010000001",
        holdStatus: "held",
      }),
      ledgerRow({
        rowKey: "00000000-0000-4000-8000-000000000103:none",
        category: "other",
        opType: "suspend",
        lotKind: null,
        deltaPoints: 0,
        title: "停用加购积分",
        remark: null,
        formula: null,
        refNo: null,
      }),
    ].map((row) => ({ ...row, bizDate: `${month}-01`, occurredAt: `${month}-01T00:00:00+08:00` })),
    hasMore: false,
    nextCursor: null,
    month,
    prevMonth: "2026-09",
    firstEntryAt: "2026-07-31T16:00:00.000Z",
    ...overrides,
  };
}
export function offlineLedgerRequest(scene: string): RequestLayer["request"] {
  let attempts = 0;
  return async <T>(path: string, options?: Parameters<RequestLayer["request"]>[1]) => {
    const evidence = globalThis as { __LYX_LEDGER_CALLS__?: { path: string; method: string }[] };
    evidence.__LYX_LEDGER_CALLS__ ??= [];
    evidence.__LYX_LEDGER_CALLS__.push({ path, method: options?.method ?? "GET" });
    const url = new URL(path, "https://local.invalid");
    if (url.pathname !== "/m/point-ledger-entries" || (options?.method && options.method !== "GET"))
      throw new Error("流水样张只允许本域GET");
    if (scene === "ledger-clerk") throw new Error("店员不应请求流水");
    if (scene === "ledger-loading") return new Promise<T>(() => {});
    if (scene === "ledger-forbidden")
      throw new ApiError({
        error: "ROLE_FORBIDDEN",
        status: 403,
        message: "仅老板可操作",
        requestId: "shot",
      });
    if (scene === "ledger-error" && attempts++ === 0) throw new Error("固定读取失败");
    const month = url.searchParams.get("month")!;
    let page = ledgerPage(month);
    if (scene === "ledger-empty")
      page = ledgerPage(month, { items: [], prevMonth: null, firstEntryAt: null });
    if (scene === "ledger-more")
      page = url.searchParams.has("cursor")
        ? ledgerPage(month, {
            items: [
              ledgerRow(),
              ledgerRow({
                rowKey: "second-page",
                title: "加购积分到账",
                lotKind: "addon",
                deltaPoints: 500,
              }),
            ],
            prevMonth: null,
          })
        : ledgerPage(month, { items: [ledgerRow()], hasMore: true, nextCursor: "opaque+/=page2" });
    if (scene === "ledger-filters")
      page = ledgerPage(month, {
        items:
          url.searchParams.get("tab") === "use" ? [ledgerPage(month).items[1]!] : [ledgerRow()],
        prevMonth: month === "2026-09" ? null : "2026-09",
      });
    return page as T;
  };
}
