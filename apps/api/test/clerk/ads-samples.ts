import { uuidv7 } from "@liyoxi/services";
import { expect } from "vitest";
import type { TestApi } from "../../src/testing/index.js";
import type { SignedInMerchant } from "../../src/testing/merchant.js";
import { clerkVisibleKeys } from "./visible-keys.js";

type ClerkSampleContext = { clerk: SignedInMerchant; storeId: string };

const adId = uuidv7();
const ownerRequests: readonly {
  operationId: string;
  path: string;
  json?: unknown;
}[] = [
  { operationId: "m.ad.list", path: "/m/ads" },
  {
    operationId: "m.ad.create",
    path: "/m/ads",
    json: {
      type: "opening",
      durationSec: 5,
      promoPointCodes: ["service"],
      copy: "门店开场广告",
      expectChargePoints: 1,
      agreementVersionId: uuidv7(),
      isAgreementChecked: true,
    },
  },
  {
    operationId: "m.ad.quote",
    path: "/m/ads/quote",
    json: { type: "opening", durationSec: 5 },
  },
  { operationId: "m.ad.get", path: `/m/ads/${adId}` },
  {
    operationId: "m.ad.confirm",
    path: `/m/ads/${adId}/confirm`,
    json: { versionNo: 1, viewedVia: "album", hasViewed: true },
  },
  {
    operationId: "m.ad.downloadUrls",
    path: `/m/ads/${adId}/download-urls`,
    json: { versionNo: 1 },
  },
  {
    operationId: "m.ad.requestChange",
    path: `/m/ads/${adId}/request-change`,
    json: { versionNo: 1, note: "请调整广告字幕", screenshotFileIds: [] },
  },
  {
    operationId: "m.ad.submit",
    path: `/m/ads/${adId}/submit`,
    json: { copy: "补充广告文案" },
  },
];

/** Real clerk authentication must reject the eight owner-only operations before business reads. */
export const adsClerkSamples = [
  ...ownerRequests.map(({ operationId, path, json }) => ({
    operationId,
    async play(api: TestApi, context: ClerkSampleContext) {
      const response = await api.request(`/api/v1${path}`, {
        method: json === undefined ? "GET" : "POST",
        ...(json === undefined ? {} : { json }),
        headers: { ...context.clerk.withStore(context.storeId), "Idempotency-Key": uuidv7() },
      });
      const body: unknown = await response.clone().json();
      expect(response.status, operationId).toBe(403);
      expect(body).toMatchObject({ error: "ROLE_FORBIDDEN" });
      expect(body).not.toHaveProperty("data");
      clerkVisibleKeys(operationId, body);
      return response;
    },
  })),
  {
    operationId: "m.playable.get",
    expectedStatus: 404,
    async play(api: TestApi, context: ClerkSampleContext) {
      // optional/same is kind-specific: public trailers remain accessible, while ads/samples
      // require their owner. An absent asset is NOT_FOUND, not a blanket clerk-role denial.
      const response = await api.request(`/api/v1/m/playables/${uuidv7()}`, {
        headers: context.clerk.withStore(context.storeId),
      });
      const body: unknown = await response.clone().json();
      expect(response.status).toBe(404);
      expect(body).toMatchObject({ error: "NOT_FOUND" });
      expect(body).not.toHaveProperty("data");
      return response;
    },
  },
];
