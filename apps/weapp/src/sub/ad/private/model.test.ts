import { describe, expect, it, vi } from "vitest";
import type { Body } from "@/lib/account-api";
import { ApiError } from "@/lib/request";
import { createDeliveryGuard } from "@/stores/delivery";
import { adDetail, adQuote } from "../../../../shots/ad-fixtures";
import {
  adIdentity,
  adPlaybackSource,
  assertSameVersion,
  changeBody,
  confirmBody,
  createAdIntent,
  createAdSubmission,
  mergeAds,
  quoteIdentity,
} from "./model";
describe("广告页面业务边界", () => {
  it("播放仅使用当前广告资产的未过期地址，换资产/无渠道/过期一律拒绝", () => {
    const playable = adDetail.playable!;
    expect(adPlaybackSource(adDetail, playable, 0)).toBe(playable.sources[0]!.url);
    expect(() => adPlaybackSource(adDetail, { ...playable, playableId: "other" }, 0)).toThrow();
    expect(() =>
      adPlaybackSource(adDetail, { ...playable, expiresAt: new Date(0).toISOString() }, 0),
    ).toThrow();
    expect(() =>
      adPlaybackSource(
        {
          ...adDetail,
          currentVersion: { ...adDetail.currentVersion!, previewChannels: ["album"] },
        },
        playable,
        0,
      ),
    ).toThrow();
  });
  it("仅按真实confirmableVia确认，勾选不能代替服务端查看证据", () => {
    expect(confirmBody(adDetail, true)).toEqual({
      versionNo: 2,
      viewedVia: "weapp",
      hasViewed: true,
    });
    expect(() => confirmBody(adDetail, false)).toThrow();
    expect(() => confirmBody({ ...adDetail, confirmableVia: [] }, true)).toThrow();
    expect(() => confirmBody({ ...adDetail, hasOpenCancelRequest: true }, true)).toThrow();
    expect(confirmBody({ ...adDetail, confirmableVia: ["album", "wecom"] }, true).viewedVia).toBe(
      "album",
    );
  });
  it("收费确认绑定本次服务端积分；截图/分段受真实上限约束，正文不混入样片时间点", () => {
    expect(changeBody(adDetail, " 字幕上移 ", 0, ["stored"], null)).toEqual({
      versionNo: 2,
      note: "字幕上移",
      segmentIndex: 0,
      screenshotFileIds: ["stored"],
    });
    const paid = { ...adDetail, freeRevisionsRemaining: 0 };
    for (const accepted of [null, 44])
      expect(() => changeBody(paid, "字幕", null, [], accepted)).toThrow();
    expect(changeBody(paid, "字幕", null, [], 45).acceptChargePoints).toBe(45);
    expect(() =>
      changeBody({ ...paid, revisionUnitChargePoints: null }, "字幕", null, [], 0),
    ).toThrow();
    expect(() => changeBody(adDetail, "字幕", 4, [], null)).toThrow();
    expect(() => changeBody(adDetail, "字幕", null, ["a", "b"], null)).toThrow();
    expect(() => changeBody(adDetail, "字幕", null, ["a", "a"], null)).toThrow();
    expect(changeBody(adDetail, "字幕", null, [], null, { start: 0, end: 1000 })).toMatchObject({
      timeStartMs: 0,
      timeEndMs: 1000,
    });
    for (const interval of [
      { start: 0, end: 5001 },
      { start: NaN, end: 1000 },
      { start: 1000, end: 1000 },
    ])
      expect(() => changeBody(adDetail, "字幕", null, [], null, interval)).toThrow();
    expect(() => changeBody(adDetail, "字幕", 0, [], null, { start: 0, end: 1000 })).toThrow();
  });
  it("未知结果同正文保同key；真实价格/协议变化要重新同意，quotedAt刷新不伪造价格变动", () => {
    let keys = 0;
    const intent = createAdIntent(() => `ad-${++keys}`);
    expect(intent({ versionNo: 2, note: "字幕" })).toBe(intent({ versionNo: 2, note: "字幕" }));
    expect(intent({ versionNo: 3, note: "字幕" })).toBe("ad-2");
    expect(quoteIdentity(adQuote)).toBe(
      quoteIdentity({ ...adQuote, quotedAt: "2026-11-01T00:00:00Z" }),
    );
    expect(quoteIdentity({ ...adQuote, chargePoints: 0 })).not.toBe(
      quoteIdentity({ ...adQuote, chargePoints: null }),
    );
    expect(
      quoteIdentity({ ...adQuote, agreement: { ...adQuote.agreement, versionLabel: "v2" } }),
    ).not.toBe(quoteIdentity(adQuote));
  });
  it("换版本/换店/卸载废弃迟到结果；列表按adId归并而非页长推总数", () => {
    expect(() => assertSameVersion(adDetail, { ...adDetail, currentVersionNo: 3 })).toThrow();
    expect(adIdentity(adDetail)).not.toBe(adIdentity({ ...adDetail, status: "confirmed" }));
    let scope = "store1";
    const life = createDeliveryGuard(
      () => scope,
      () => "key",
    );
    const old = life.nextRead();
    scope = "store2";
    expect(old()).toBe(false);
    const late = life.nextRead();
    life.invalidate();
    expect(late()).toBe(false);
    const unmounted = life.nextRead();
    life.dispose();
    expect(unmounted()).toBe(false);
    expect(
      mergeAds(
        { items: [adDetail], hasMore: true, nextCursor: "cursor" },
        { items: [adDetail, { ...adDetail, adId: "different" }], hasMore: false, nextCursor: null },
      ).items.map((item) => item.adId),
    ).toEqual([adDetail.adId, "different"]);
  });
  it("创建后丢回包重放原正文/key；已知adId后GET失败只读恢复且只冻结一次", async () => {
    const submission = createAdSubmission();
    const body: Body<"m.ad.create"> = {
      type: "opening",
      durationSec: 5,
      promoPointCodes: ["product"],
      expectChargePoints: 100,
      agreementVersionId: adQuote.agreement.agreementVersionId,
      isAgreementChecked: true,
    };
    let holds = 0;
    const create = vi.fn(async () => {
      if (!holds) {
        holds++;
        throw new Error("成功回包丢失");
      }
      return { adId: adDetail.adId };
    });
    const get = vi.fn().mockRejectedValueOnce(new Error("GET失败")).mockResolvedValue(adDetail);
    submission.start(body, "original-key", () => true);
    body.promoPointCodes.push("changed-outside");
    await expect(submission.recover({ create, get }, () => true)).rejects.toThrow("成功回包丢失");
    expect(submission.pending()).toBe(true);
    await expect(submission.recover({ create, get }, () => true)).rejects.toThrow("GET失败");
    expect(await submission.recover({ create, get }, () => true)).toBe(adDetail);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1]);
    expect(create.mock.calls[0]).toEqual([
      { ...body, promoPointCodes: ["product"] },
      "original-key",
    ]);
    expect(get).toHaveBeenCalledTimes(2);
    expect(holds).toBe(1);
  });
  it("改意图或换店代次不能恢复旧结果；明确报价拒绝回到新报价流程", async () => {
    const submission = createAdSubmission();
    const body: Body<"m.ad.create"> = {
      type: "opening",
      durationSec: 5,
      promoPointCodes: ["product"],
      expectChargePoints: 100,
      agreementVersionId: adQuote.agreement.agreementVersionId,
      isAgreementChecked: true,
    };
    const get = vi.fn(async () => adDetail);
    const create = vi.fn(async () => ({ adId: adDetail.adId }));
    submission.start(body, "old", () => true);
    submission.clear();
    expect(await submission.recover({ create, get }, () => true)).toBeNull();
    let scope = "store-a:1";
    submission.start(body, "old", () => scope === "store-a:1");
    scope = "store-a:2";
    expect(submission.pending()).toBe(false);
    expect(await submission.recover({ create, get }, () => true)).toBeNull();
    expect(create).not.toHaveBeenCalled();
    let release!: (value: { adId: string }) => void;
    const delayed = () => new Promise<{ adId: string }>((resolve) => (release = resolve));
    submission.start(body, "late", () => scope === "store-a:2");
    const late = submission.recover({ create: delayed, get }, () => true);
    scope = "store-b:3";
    release({ adId: adDetail.adId });
    expect(await late).toBeNull();
    expect(get).not.toHaveBeenCalled();
    submission.start(body, "new", () => true);
    const rejected = async () => {
      throw new ApiError({
        error: "QUOTE_CHANGED",
        message: "报价更新",
        status: 409,
        requestId: "ad-test",
      });
    };
    await expect(submission.recover({ create: rejected, get }, () => true)).rejects.toThrow();
    expect(submission.pending()).toBe(false);
  });
});
