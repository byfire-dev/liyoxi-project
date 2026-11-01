import { expect, it, vi } from "vitest";
import type { RequestLayer, RequestOptions } from "@/lib/request";
vi.mock("@/lib/runtime", () => ({ request: vi.fn() }));
import { createAdApi } from "./api";
it("所有广告读写走实际typed路径，写口保留key，现签口无幂等缓存", async () => {
  const calls: { path: string; options?: RequestOptions }[] = [];
  const send: RequestLayer["request"] = async <T>(
    path: string,
    options?: RequestOptions,
  ): Promise<T> => {
    calls.push({ path, options });
    return null as T;
  };
  const api = createAdApi(send);
  await api.list("all", "next+/?");
  await api.get("ad/id");
  await api.quote({ type: "opening", durationSec: 5 });
  const body = {
    type: "opening" as const,
    durationSec: 5,
    promoPointCodes: ["product"],
    expectChargePoints: 100,
    agreementVersionId: "agreement",
    isAgreementChecked: true,
  };
  await api.create(body, "same-key");
  await api.create(body, "same-key");
  await api.confirm("ad", { versionNo: 2, viewedVia: "weapp", hasViewed: true }, "confirm-key");
  await api.change("ad", { versionNo: 2, note: "字幕", acceptChargePoints: 45 }, "change-key");
  await api.submit("ad", { addReferenceStoreAssetIds: ["asset"] }, "submit-key");
  await api.download("ad", 2);
  await api.playable("play/id");
  expect(calls.map((call) => call.path)).toEqual([
    "/m/ads?tab=all&limit=20&cursor=next%2B%2F%3F",
    "/m/ads/ad%2Fid",
    "/m/ads/quote",
    "/m/ads",
    "/m/ads",
    "/m/ads/ad/confirm",
    "/m/ads/ad/request-change",
    "/m/ads/ad/submit",
    "/m/ads/ad/download-urls",
    "/m/playables/play%2Fid",
  ]);
  expect(calls[3]).toEqual(calls[4]);
  expect(calls[6]?.options).toMatchObject({
    method: "POST",
    idempotencyKey: "change-key",
    data: { acceptChargePoints: 45 },
  });
  expect(calls[8]?.options).toEqual({ method: "POST", data: { versionNo: 2 } });
  expect(calls[9]?.options).toBeUndefined();
});
