import { expect, it, vi } from "vitest";
import type { Data } from "@/lib/account-api";
import { ApiError, type RequestLayer } from "@/lib/request";
import { makeMe } from "../../../../shots/account-fixtures";
import {
  BILLING_ID,
  billingAgreements,
  billingPolicy,
  billingQuote,
  billingWallet,
  offlineBillingRequest,
} from "../../../../shots/billing-fixtures";
import { createTopupApi } from "./api";
import {
  createTopupModel,
  purchaseContext,
  topupBody,
  topupBlock,
  topupConfirmationKey,
} from "./model";
import { createPurchaseApi } from "../plan-pick/api";
import { planPurchaseBody, quoteConfirmationKey, quoteTermLabel } from "../plan-pick/model";

const wallet = () => ({
  ...billingWallet("wallet-active"),
  topUp: { canTopUp: true, blockReason: null },
});
const packs: Data<"m.pointPack.list"> = {
  items: [
    { pointPackId: BILLING_ID, points: 1000, priceFen: 9900 },
    { pointPackId: "null-price", points: 2000, priceFen: null },
    { pointPackId: "zero-price", points: 100, priceFen: 0 },
  ],
};
function setup() {
  const input = {
    me: makeMe(),
    token: "owner-token" as string | null,
    storeId: makeMe().memberships[0]!.stores[0]!.storeId,
    contextRev: 1,
  };
  const calls: string[] = [];
  const response = vi.fn(async (path: string): Promise<unknown> => {
    if (path === "/m/wallet") return wallet();
    if (path === "/m/purchase-policy") return billingPolicy;
    if (path === "/m/point-packs") return packs;
    if (path.startsWith("/m/agreements?")) return billingAgreements;
    throw new Error("unexpected route");
  });
  const call: RequestLayer["request"] = async <T>(path: string) => {
    calls.push(path);
    return (await response(path)) as T;
  };
  const api = createTopupApi(call);
  const model = createTopupModel({
    api,
    prepare: async () => {},
    context: () => purchaseContext(input),
  });
  return { model, input, calls, response, api };
}
it("只读真实wallet/policy/pack DTO与topup协议scene；null与0保留", async () => {
  const h = setup();
  await h.model.show();
  expect(h.calls).toEqual([
    "/m/wallet",
    "/m/purchase-policy",
    "/m/point-packs",
    "/m/agreements?scene=topup&limit=50",
  ]);
  expect(h.model.snapshot().packs.map((p) => p.priceFen)).toEqual([9900, null, 0]);
  h.model.select("null-price");
  expect(h.model.snapshot().selected).toBe(BILLING_ID);
  h.model.select("zero-price");
  expect(h.model.snapshot().selected).toBe("zero-price");
  expect(topupBody(h.model.snapshot(), "bank_transfer")).toBeNull();
});
it.each(["offline_contract", "hidden"] as const)(
  "%s不请求积分包/协议也不能构造购买",
  async (mode) => {
    const h = setup();
    h.response.mockImplementation(async (path) =>
      path === "/m/wallet" ? wallet() : { ...billingPolicy, mode },
    );
    await h.model.show();
    expect(h.calls).toEqual(["/m/wallet", "/m/purchase-policy"]);
    expect(topupBlock(h.model.snapshot())).toContain("暂未开放");
    expect(topupBody(h.model.snapshot(), "bank_transfer")).toBeNull();
  },
);
it("正式clerk-view none/游客零本域请求，真实403仍进入受限态", async () => {
  const h = setup();
  h.input.me.memberships[0]!.role = "clerk";
  await h.model.show();
  expect(h.calls).toEqual([]);
  expect(h.model.snapshot().restricted).toBe(true);
  h.model.hide();
  h.input.me.memberships[0]!.role = "owner";
  h.input.token = null;
  await h.model.show();
  expect(h.calls).toEqual([]);
  h.model.hide();
  h.input.token = "owner";
  h.response.mockRejectedValue(
    new ApiError({ error: "ROLE_FORBIDDEN", status: 403, message: "forbidden", requestId: "test" }),
  );
  await h.model.show();
  expect(h.model.snapshot().restricted).toBe(true);
  expect(h.model.snapshot().packs).toEqual([]);
});
it("服务端不可加购原因拦截；归档老板保持主体级能力，角色/ctxRev变化改变scope", () => {
  const h = setup(),
    before = purchaseContext(h.input);
  h.input.contextRev++;
  expect(purchaseContext(h.input).key).not.toBe(before.key);
  h.input.me.memberships[0]!.stores[0]!.lifecycle = "archived";
  expect(purchaseContext(h.input).allowed).toBe(true);
  for (const blockReason of ["no_active_plan", "refund_in_progress", "not_offered"] as const)
    expect(
      topupBlock({
        wallet: { ...wallet(), topUp: { canTopUp: false, blockReason } },
        policy: billingPolicy,
      }),
    ).not.toBeNull();
});
it("刷新清旧选择与同意事实；切店/卸载的旧响应和旧finally不得回写或解新锁", async () => {
  const h = setup();
  let release!: (v: unknown) => void;
  h.response.mockImplementationOnce(
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const old = h.model.show();
  await Promise.resolve();
  await Promise.resolve();
  h.model.hide();
  h.input.contextRev++;
  const next = h.model.show();
  await next;
  expect(h.model.snapshot().selected).toBe(BILLING_ID);
  release({ ...wallet(), topUp: { canTopUp: false, blockReason: "refund_in_progress" } });
  await old;
  expect(h.model.snapshot().wallet?.topUp.canTopUp).toBe(true);
  expect(h.model.snapshot().loading).toBe(false);
  h.model.hide();
  expect(h.model.isCurrent()).toBe(false);
  expect(h.model.snapshot().agreements).toEqual([]);
});
it("同意当前协议才生成typed创建体，渠道禁用/协议换版会产生不同确认事实", async () => {
  const h = setup();
  await h.model.show();
  const state = h.model.snapshot();
  const body = topupBody(state, "bank_transfer");
  expect(body).toEqual({
    pointPackId: BILLING_ID,
    channel: "bank_transfer",
    expectAmountFen: 9900,
    agreementVersionIds: billingAgreements.items.map((d) => d.currentVersion!.agreementVersionId),
  });
  expect(topupBody(state, "wechat_jsapi")).toBeNull();
  expect(topupBody({ ...state, agreements: [] }, "bank_transfer")).toBeNull();
  const changed = structuredClone(state);
  changed.agreements[0]!.currentVersion!.agreementVersionId = "new-version";
  expect(topupBody(changed, "bank_transfer")).not.toEqual(body);
});
it("续费/升级/降级仅消费真实quote，意图与精确降级影响回传；滚动期限不误作币价变更", () => {
  for (const action of ["subscribe", "renew", "renew_upgrade", "upgrade", "downgrade"] as const) {
    const quote = {
      ...billingQuote,
      action,
      downgradeImpact: action === "downgrade" ? { storesToRemove: 1, membersToRemove: 0 } : null,
    };
    const selection = {
      planId: quote.planId,
      intent: action === "upgrade" ? ("upgrade_now" as const) : ("renew_next_term" as const),
    };
    const body = planPurchaseBody(quote, selection, billingAgreements.items, "bank_transfer", true);
    expect(body?.expectAmountFen).toBe(quote.payFen);
    expect(body?.intent).toBe(selection.intent);
    if (action === "downgrade") {
      expect(
        planPurchaseBody(quote, selection, billingAgreements.items, "bank_transfer", false),
      ).toBeNull();
      expect(body?.acknowledgedDowngradeImpact).toEqual({ storesToRemove: 1, membersToRemove: 0 });
    }
  }
  expect(quoteConfirmationKey({ ...billingQuote, quotedAt: "new", validUntil: "new" })).toBe(
    quoteConfirmationKey(billingQuote),
  );
  expect(quoteConfirmationKey({ ...billingQuote, planRevisionId: "changed" })).not.toBe(
    quoteConfirmationKey(billingQuote),
  );
  expect(quoteConfirmationKey({ ...billingQuote, payFen: 1 })).not.toBe(
    quoteConfirmationKey(billingQuote),
  );
});

it("同ID同价格但积分数变更必须重新确认，不把创建body相同当作所见事实相同", async () => {
  const h = setup();
  await h.model.show();
  const seen = h.model.snapshot(),
    fresh = {
      ...seen,
      packs: seen.packs.map((p) => ({ ...p, points: p.points === 1000 ? 100 : p.points })),
    };
  expect(topupBody(fresh, "bank_transfer")).toEqual(topupBody(seen, "bank_transfer"));
  expect(topupConfirmationKey(fresh, "bank_transfer")).not.toBe(
    topupConfirmationKey(seen, "bank_transfer"),
  );
});

it("升级actual空newTerm沿用服务端当前周期，不回显开通新周期", async () => {
  const quote = await createPurchaseApi(offlineBillingRequest("plan-upgrade")).quote({
    planId: BILLING_ID,
    intent: "upgrade_now",
  });
  expect(quote.newTerm).toBeNull();
  expect(quote.firstGrantDate).toBeNull();
  expect(quoteTermLabel(quote)).toBe(`沿用当前周期至 ${quote.upgrade!.currentTermEndDate}`);
  expect(quoteTermLabel(billingQuote)).toBe("2026-10-06 至 2026-11-05");
  expect(quoteTermLabel({ ...billingQuote, newTerm: null })).toBe("以付款结果为准");
});
