import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  billingAgreements,
  billingPayment,
  billingPolicy,
  billingQuote,
} from "../../../../shots/billing-fixtures";
import { ApiError } from "@/lib/request";
import {
  changedQuote,
  agreementStale,
  reloadPurchaseConfirmation,
  createPurchaseIntent,
  enabledChannels,
  existingOrder,
  paymentView,
  purchaseAgreements,
} from "./model";
const body = {
  planId: billingQuote.planId,
  months: 1,
  channel: "bank_transfer" as const,
  expectAmountFen: billingQuote.payFen,
  agreementVersionIds: [billingQuote.planId],
};
const created = () => ({ ...billingPayment("bank-waiting"), replayed: false });
describe("套餐确认与付款结果", () => {
  it("协议换版只刷新真实协议与报价，再确认才以新版本新键建单", async () => {
    const stale = new ApiError({
      error: "AGREEMENT_VERSION_STALE",
      message: "stale",
      status: 409,
      requestId: "r",
    });
    expect(agreementStale(stale)).toBe(true);
    expect(agreementStale(new Error("stale"))).toBe(false);
    const versions = billingAgreements.items.map((doc, i) => ({
      ...doc,
      currentVersion: doc.currentVersion
        ? {
            ...doc.currentVersion,
            agreementVersionId: `00000000-0000-4000-8000-00000000000${i + 2}`,
          }
        : null,
    }));
    const create = vi.fn().mockRejectedValueOnce(stale).mockResolvedValue(created());
    await expect(
      createPurchaseIntent({ create, detail: vi.fn() }, body, "before-stale").submit(),
    ).rejects.toBe(stale);
    const agreements = vi.fn().mockResolvedValue(versions),
      quote = vi.fn().mockResolvedValue(billingQuote);
    const refreshed = await reloadPurchaseConfirmation(
      { agreements, quote },
      { planId: body.planId, months: body.months },
    );
    expect(agreements).toHaveBeenCalledOnce();
    expect(quote).toHaveBeenCalledWith({ planId: body.planId, months: body.months });
    expect(create).toHaveBeenCalledOnce();
    const ids = purchaseAgreements(refreshed.quote.policy, refreshed.agreements).map(
      (v) => v.currentVersion.agreementVersionId,
    );
    expect(ids).not.toEqual(body.agreementVersionIds);
    await createPurchaseIntent(
      { create, detail: vi.fn() },
      { ...body, agreementVersionIds: ids },
      "after-reconfirm",
    ).submit();
    expect(create.mock.calls.map((v) => v[1])).toEqual(["before-stale", "after-reconfirm"]);
    expect(create.mock.calls[1]![0].agreementVersionIds).toEqual(ids);
  });
  it("仅渲染服务端启用渠道与当次购买协议，不按端或金额筛选", () => {
    expect(enabledChannels(billingPolicy).map((v) => v.code)).toEqual(["bank_transfer"]);
    expect(
      enabledChannels({
        ...billingPolicy,
        channels: billingPolicy.channels.map((v) => ({ ...v, isEnabled: true })),
      }),
    ).toHaveLength(2);
    expect(
      purchaseAgreements(billingPolicy, billingAgreements.items).map((v) => v.agreementKey),
    ).toEqual(["member", "points"]);
    expect(
      purchaseAgreements(
        billingPolicy,
        billingAgreements.items.map((v) => ({ ...v, consentMode: "checkbox" })),
      ),
    ).toHaveLength(0);
  });
  it("失败重试沿用确认键，同步双点只建一次", async () => {
    let release!: () => void;
    const create = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return created();
    });
    const intent = createPurchaseIntent({ create, detail: vi.fn() }, body, "same-intent");
    const first = intent.submit();
    expect(await intent.submit()).toBeNull();
    release();
    await first;
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(body, "same-intent");
    const retry = vi.fn().mockRejectedValueOnce(new Error("timeout")).mockResolvedValue(created());
    const next = createPurchaseIntent({ create: retry, detail: vi.fn() }, body, "retry-key");
    await expect(next.submit()).rejects.toThrow("timeout");
    await next.submit();
    expect(retry.mock.calls.map((v) => v[1])).toEqual(["retry-key", "retry-key"]);
  });
  it("账号为null补读同张详情，详情读取失败不重建交易", async () => {
    const replay = created();
    replay.bankAccount!.accountNo = null;
    const create = vi.fn().mockResolvedValue(replay),
      detail = vi
        .fn()
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValue(billingPayment("bank-waiting"));
    const intent = createPurchaseIntent({ create, detail }, body, "replay-key");
    await expect(intent.submit()).rejects.toThrow("network");
    await intent.submit();
    expect(create).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(2);
    expect(detail).toHaveBeenLastCalledWith(replay.paymentOrderId);
  });
  it("QUOTE_CHANGED消费返回报价，重新确认是新键；已有单只引导指定结果", async () => {
    const quote = { ...billingQuote, payFen: 610000 };
    const error = new ApiError({
      error: "QUOTE_CHANGED",
      message: "changed",
      status: 409,
      requestId: "r",
      details: { kind: "plan", quote, amountFen: quote.payFen },
    });
    expect(changedQuote(error)).toEqual(quote);
    const create = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(created());
    await expect(
      createPurchaseIntent({ create, detail: vi.fn() }, body, "old-key").submit(),
    ).rejects.toBe(error);
    await createPurchaseIntent(
      { create, detail: vi.fn() },
      { ...body, expectAmountFen: quote.payFen },
      "new-key",
    ).submit();
    expect(create.mock.calls.map((v) => v[1])).toEqual(["old-key", "new-key"]);
    expect(
      existingOrder(
        new ApiError({
          error: "OPEN_ORDER_EXISTS",
          message: "open",
          status: 409,
          requestId: "r",
          details: { paymentOrderId: "existing-id" },
        }),
      ),
    ).toBe("existing-id");
  });
  it("门店或登录上下文变化，建单迟到结果与补读都废弃", async () => {
    let current = true,
      release!: () => void;
    const replay = created();
    replay.bankAccount!.accountNo = null;
    const detail = vi.fn();
    const create = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return replay;
    });
    const intent = createPurchaseIntent({ create, detail }, body, "store-intent", () => current);
    const pending = intent.submit();
    current = false;
    release();
    expect(await pending).toBeNull();
    expect(detail).not.toHaveBeenCalled();
    expect(await intent.submit()).toBeNull();
  });
  it("六种结果仅按服务端事实与actions，无轮询或调查单", () => {
    const scenes = [
      "bank-waiting",
      "payment-waiting",
      "payment-rejected",
      "payment-active",
      "payment-processing",
      "payment-cancelled",
    ];
    expect(scenes.map((v) => paymentView(billingPayment(v)).title)).toEqual([
      "待上传转账凭证",
      "待财务确认",
      "凭证被驳回",
      "套餐已开通",
      "已收到付款，正在处理",
      "付款已取消",
    ]);
    const rejected = billingPayment("payment-rejected");
    rejected.actions = [];
    expect(paymentView(rejected).canUpload).toBe(false);
    const source = readFileSync(new URL("../../order/result/payment.tsx", import.meta.url), "utf8");
    expect(source).not.toMatch(/setInterval|query-payment|payment-orders.*query/);
  });
  it("购买源码没有平台、金额门槛、版本判断；策略隐藏整货架与主按钮", () => {
    for (const file of ["index.tsx", "model.ts", "../wallet/index.tsx", "../wallet/model.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /\b(?:ios|android|harmony|appVersion|clientVersion|wechatSingleLimitFen|amountGteFen|amountLtFen)\b/,
      );
      expect(source).not.toMatch(/(?:payFen|amountFen|monthlyFeeFen)\s*[<>]=?\s*\d/);
    }
    const source = readFileSync(new URL("index.tsx", import.meta.url), "utf8");
    expect(source).toContain("!purchaseVisible(activePolicy)");
    expect(source).toContain("enabledChannels(activePolicy).map");
  });
});
