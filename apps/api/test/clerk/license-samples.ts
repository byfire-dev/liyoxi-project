import { uuidv7 } from "@liyoxi/services";
import { expect } from "vitest";
import type { TestApi } from "../../src/testing/index.js";
import type { SignedInMerchant } from "../../src/testing/merchant.js";
import { clerkVisibleKeys } from "./visible-keys.js";

type ClerkSampleContext = { clerk: SignedInMerchant; storeId: string };

const letterId = uuidv7();
const requests = [
  ["m.licenseLetter.list", "GET", "/m/license-letters"],
  ["m.licenseLetter.summary", "GET", "/m/license-letters/summary"],
  ["m.licenseLetter.get", "GET", `/m/license-letters/${letterId}`],
  ["m.licenseLetter.downloadUrls", "POST", `/m/license-letters/${letterId}/download-urls`],
] as const;

/** Real clerk authentication must deny all four owner-only operations before reading document facts. */
export const licenseClerkSamples = requests.map(([operationId, method, path]) => ({
  operationId,
  async play(api: TestApi, context: ClerkSampleContext) {
    const response = await api.request(`/api/v1${path}`, {
      method,
      ...(method === "POST" ? { json: { revNo: 1 } } : {}),
      headers: context.clerk.withStore(context.storeId),
    });
    const body: unknown = await response.clone().json();
    expect(response.status, operationId).toBe(403);
    expect(body).toMatchObject({ error: "ROLE_FORBIDDEN" });
    expect(body).not.toHaveProperty("data");
    // The common harness skips visible-key golden rows for owner-only routes; still scan their errors.
    clerkVisibleKeys(operationId, body);
    return response;
  },
}));
