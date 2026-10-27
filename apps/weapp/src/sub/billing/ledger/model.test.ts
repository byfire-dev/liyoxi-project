import { describe, expect, it, vi } from "vitest";
import { appDateTimeFormat } from "@liyoxi/shared/format/datetime";
import { formatSignedPoints } from "@liyoxi/shared/format/money";
import { ApiError, type RequestLayer } from "@/lib/request";
import { makeMe } from "../../../../shots/account-fixtures";
import { ledgerPage, ledgerRow } from "../../../../shots/ledger-fixtures";
import { createLedgerApi, type LedgerPage } from "./api";
import { createLedgerModel, ledgerContext, ledgerMonth } from "./model";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(
  reply: (query: URLSearchParams, call: number) => LedgerPage | Promise<LedgerPage> = () =>
    ledgerPage(),
) {
  const me = makeMe();
  const input = {
    me,
    token: "owner-token" as string | null,
    storeId: me.memberships[0]!.stores[0]!.storeId as string | null,
    contextRev: 1,
  };
  const calls: { path: string; method: string }[] = [];
  const requested = vi.fn();
  const request: RequestLayer["request"] = async <T>(
    path: string,
    options?: Parameters<RequestLayer["request"]>[1],
  ) => {
    requested();
    calls.push({ path, method: options?.method ?? "GET" });
    return (await reply(new URL(path, "https://local.invalid").searchParams, calls.length)) as T;
  };
  const model = createLedgerModel({
    api: createLedgerApi(request),
    context: () => ledgerContext(input),
    prepare: async () => {},
    now: () => new Date("2026-09-30T16:00:00.000Z"),
  });
  return { model, input, calls, request: requested };
}

describe("商家积分流水actual DTO与分页", () => {
  it("只GET真实query，rowKey去重不按单号/标题合并、不改服务端排序，保留0与null", async () => {
    const h = setup((query) =>
      query.has("cursor")
        ? ledgerPage("2026-10", {
            items: [
              ledgerRow(),
              ledgerRow({
                rowKey: "same-operation:addon",
                deltaPoints: 0,
                lotKind: null,
                remark: null,
                formula: null,
              }),
            ],
            prevMonth: null,
          })
        : ledgerPage("2026-10", { hasMore: true, nextCursor: "opaque+/=page2" }),
    );
    await h.model.show();
    const first = h.model.snapshot().page!.items.map((row) => row.rowKey);
    await h.model.more();
    const page = h.model.snapshot().page!;
    expect(page.items.map((row) => row.rowKey)).toEqual([...first, "same-operation:addon"]);
    expect(page.items.at(-1)).toMatchObject({
      deltaPoints: 0,
      lotKind: null,
      remark: null,
      formula: null,
    });
    expect(formatSignedPoints(page.items.at(-1)!.deltaPoints)).toBe("0");
    expect(page.items.at(-1)).not.toHaveProperty("valueFen");
    expect(h.calls).toEqual([
      { path: "/m/point-ledger-entries?tab=all&month=2026-10&limit=20", method: "GET" },
      {
        path: "/m/point-ledger-entries?tab=all&month=2026-10&cursor=opaque%2B%2F%3Dpage2&limit=20",
        method: "GET",
      },
    ]);
    await h.model.more();
    expect(h.calls).toHaveLength(2);
  });
  it("北京时间跨UTC/月末和跨年，月筛选/服务端prevMonth/清除均发真实过滤且清旧cursor", async () => {
    expect(ledgerMonth(new Date("2026-09-30T15:59:59Z"))).toBe("2026-09");
    expect(ledgerMonth(new Date("2026-09-30T16:00:00Z"))).toBe("2026-10");
    expect(ledgerMonth(new Date("2026-12-31T16:00:00Z"))).toBe("2027-01");
    const h = setup((query) =>
      ledgerPage(query.get("month")!, { hasMore: true, nextCursor: "old", prevMonth: "2026-08" }),
    );
    await h.model.show();
    expect(appDateTimeFormat.dateTime(h.model.snapshot().page!.items[0]!.occurredAt)).toBe(
      "10-01 00:00",
    );
    expect(appDateTimeFormat.date(h.model.snapshot().page!.firstEntryAt!)).toBe("2026-08-01");
    await h.model.filter("use", "2026-09");
    expect(h.model.snapshot().filter).toEqual({ tab: "use", month: "2026-09" });
    await h.model.previous();
    expect(h.model.snapshot().filter).toEqual({ tab: "use", month: "2026-08" });
    await h.model.clear();
    expect(h.model.snapshot().filter).toEqual({ tab: "all", month: "2026-10" });
    await h.model.clear();
    await h.model.filter("all", "2026-11");
    await h.model.filter("all", "2026-13");
    expect(h.calls).toHaveLength(4);
    expect(
      h.calls.every(
        (call) => !new URL(call.path, "https://local.invalid").searchParams.has("cursor"),
      ),
    ).toBe(true);
  });
  it("首屏错误可重试，空结果有成功page，真实403不降级成空结果", async () => {
    const h = setup((_q, call) => {
      if (call === 1) throw new Error("offline");
      return ledgerPage("2026-10", { items: [], prevMonth: null, firstEntryAt: null });
    });
    await h.model.show();
    expect(h.model.snapshot()).toMatchObject({
      loading: false,
      page: null,
      error: "暂时无法加载积分流水，请重试",
    });
    await h.model.refresh();
    expect(h.model.snapshot()).toMatchObject({
      error: null,
      page: { items: [], hasMore: false, firstEntryAt: null },
    });
    const denied = setup(() => {
      throw new ApiError({
        error: "ROLE_FORBIDDEN",
        status: 403,
        requestId: "test",
        message: "forbidden",
      });
    });
    await denied.model.show();
    expect(denied.model.snapshot()).toMatchObject({
      restricted: true,
      page: null,
      error: null,
      loading: false,
    });
    expect(denied.calls).toHaveLength(1);
  });
  it("同一事件周期重复加载被同步锁拦住；分页失败保留原行/游标并能重试", async () => {
    const pending = deferred<LedgerPage>(),
      entered = deferred<void>();
    const h = setup((q, call) => {
      if (call === 1) return ledgerPage("2026-10", { hasMore: true, nextCursor: "retry" });
      if (call === 2) {
        entered.resolve();
        return pending.promise;
      }
      expect(q.get("cursor")).toBe("retry");
      return ledgerPage("2026-10", { prevMonth: null });
    });
    const initial = h.model.show();
    await h.model.refresh();
    await initial;
    const more = h.model.more();
    await entered.promise;
    await h.model.more();
    expect(h.calls).toHaveLength(2);
    pending.reject(new Error("offline"));
    await more;
    expect(h.model.snapshot()).toMatchObject({
      moreBusy: false,
      moreError: "暂时无法加载更多流水，请重试",
      page: { nextCursor: "retry", hasMore: true },
    });
    expect(h.model.snapshot().page!.items).toHaveLength(3);
    await h.model.more();
    expect(h.model.snapshot().moreError).toBeNull();
    expect(h.calls).toHaveLength(3);
  });
  it.each(["success", "error"])(
    "刷新废弃旧分页%s，旧finally不释放新请求锁，新页游标生效",
    async (result) => {
      const old = deferred<LedgerPage>(),
        fresh = deferred<LedgerPage>(),
        oldEntered = deferred<void>(),
        freshEntered = deferred<void>();
      const h = setup((_query, call) => {
        if (call === 1) return ledgerPage("2026-10", { hasMore: true, nextCursor: "old" });
        if (call === 2) {
          oldEntered.resolve();
          return old.promise;
        }
        if (call === 3) {
          freshEntered.resolve();
          return fresh.promise;
        }
        return ledgerPage("2026-10", { items: [], prevMonth: null });
      });
      await h.model.show();
      const more = h.model.more();
      await oldEntered.promise;
      const refresh = h.model.refresh();
      await freshEntered.promise;
      expect(h.model.snapshot()).toMatchObject({ page: null, loading: true, moreBusy: false });
      if (result === "success")
        old.resolve(ledgerPage("2026-10", { items: [ledgerRow({ rowKey: "stale" })] }));
      else old.reject(new Error("stale error"));
      await more;
      expect(h.model.snapshot()).toMatchObject({
        page: null,
        loading: true,
        error: null,
        moreError: null,
      });
      await h.model.refresh();
      expect(h.calls).toHaveLength(3);
      fresh.resolve(
        ledgerPage("2026-10", {
          items: [ledgerRow({ rowKey: "new" })],
          hasMore: true,
          nextCursor: "new",
        }),
      );
      await refresh;
      await h.model.more();
      expect(h.calls.at(-1)!.path).toContain("cursor=new");
      expect(h.model.snapshot().page!.items.map((row) => row.rowKey)).toEqual(["new"]);
    },
  );
  it("过滤变化清屏/游标，旧首屏不能覆盖新过滤", async () => {
    const old = deferred<LedgerPage>(),
      entered = deferred<void>();
    const h = setup((q, call) => {
      if (call === 1) {
        entered.resolve();
        return old.promise;
      }
      return ledgerPage(q.get("month")!, { items: [], prevMonth: null });
    });
    const first = h.model.show();
    await entered.promise;
    await h.model.filter("expire", "2026-08");
    old.resolve(ledgerPage());
    await first;
    expect(h.model.snapshot()).toMatchObject({
      filter: { tab: "expire", month: "2026-08" },
      page: { month: "2026-08", items: [] },
      loading: false,
    });
  });
});

describe("身份、范围与生命周期", () => {
  it("已加载后切店，React重新激活前的旧事件零请求，新店首页不带旧游标", async () => {
    const h = setup(() => ledgerPage("2026-10", { hasMore: true, nextCursor: "old-store" }));
    await h.model.show();
    h.input.storeId = h.input.me.memberships[0]!.stores[1]!.storeId;
    await h.model.more();
    await h.model.refresh();
    expect(h.calls).toHaveLength(1);
    await h.model.show();
    expect(h.calls).toHaveLength(2);
    expect(h.calls.at(-1)!.path).not.toContain("cursor");
  });
  it("独立ledger.read能力：clerk/游客/无门店零流水请求及禁用字段读取，归档owner允许主体级读", async () => {
    const h = setup(() => {
      throw new Error("受限身份不能触达DTO");
    });
    h.input.me = makeMe(true);
    await h.model.show();
    expect(h.model.snapshot().restricted).toBe(true);
    expect(h.request).not.toHaveBeenCalled();
    h.model.hide();
    h.input.token = null;
    await h.model.show();
    expect(h.request).not.toHaveBeenCalled();
    const owner = setup();
    owner.input.me.memberships[0]!.stores[0]!.lifecycle = "archived";
    await owner.model.show();
    expect(owner.calls).toHaveLength(1);
    const key = ledgerContext(owner.input).key;
    owner.input.me.memberships[0]!.role = "clerk";
    expect(ledgerContext(owner.input)).toMatchObject({ allowed: false });
    expect(ledgerContext(owner.input).key).not.toBe(key);
  });
  it.each(["store", "revision", "token", "identity", "role", "unmount"])(
    "%s变化使旧成功/错误与finally失效，新操作继续",
    async (change) => {
      const old = deferred<LedgerPage>(),
        fresh = deferred<LedgerPage>(),
        entered = deferred<void>(),
        newEntered = deferred<void>();
      const h = setup((_q, call) => {
        if (call === 1) {
          entered.resolve();
          return old.promise;
        }
        if (call === 2) {
          newEntered.resolve();
          return fresh.promise;
        }
        return ledgerPage();
      });
      const initial = h.model.show();
      await entered.promise;
      if (change === "store") h.input.storeId = h.input.me.memberships[0]!.stores[1]!.storeId;
      if (change === "revision") h.input.contextRev++;
      if (change === "token") h.input.token = "new-token";
      if (change === "identity") h.input.me.user.merchantUserId = "different-user";
      if (change === "role") h.input.me.memberships[0]!.role = "clerk";
      // React重新激活前，旧页面事件不能带旧游标去请求新上下文。
      if (change !== "unmount") {
        await h.model.more();
        expect(h.calls).toHaveLength(1);
      }
      h.model.hide();
      if (change === "role") h.input.me = makeMe();
      const next = h.model.show();
      await newEntered.promise;
      old.reject(new Error("old context"));
      await initial;
      expect(h.model.snapshot()).toMatchObject({ loading: true, page: null, error: null });
      await h.model.refresh();
      expect(h.calls).toHaveLength(2);
      fresh.resolve(ledgerPage());
      await next;
      expect(h.model.snapshot()).toMatchObject({ loading: false, error: null, restricted: false });
      await h.model.refresh();
      expect(h.calls).toHaveLength(3);
    },
  );
  it("卸载后的迟到成功零回写", async () => {
    const old = deferred<LedgerPage>(),
      entered = deferred<void>();
    const h = setup(() => {
      entered.resolve();
      return old.promise;
    });
    const loading = h.model.show();
    await entered.promise;
    h.model.hide();
    const listener = vi.fn();
    h.model.subscribe(listener);
    old.resolve(ledgerPage());
    await loading;
    expect(listener).not.toHaveBeenCalled();
    expect(h.model.snapshot().page).toBeNull();
  });
});
