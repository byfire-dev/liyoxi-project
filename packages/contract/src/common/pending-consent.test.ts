import { expect, expectTypeOf, it } from "vitest";
import type { z } from "../zod.js";
import { PendingConsentSchema } from "./pending-consent.js";
import type { PendingConsent } from "./pending-consent.types.js";
import { COMMON_ERROR_DETAILS } from "./error-details.js";

it("公共纯 TS 类型与 Zod 输出双向同构；428 与引导没有占位结构", () => {
  expect(PendingConsentSchema.safeParse({ agreementKey: "user" }).success).toBe(false);
  expect(
    COMMON_ERROR_DETAILS.CONSENT_REQUIRED.safeParse({ pendingConsents: [{ agreementKey: "user" }] })
      .success,
  ).toBe(false);
  expectTypeOf<z.infer<typeof PendingConsentSchema>>().toEqualTypeOf<PendingConsent>();
  expectTypeOf<z.infer<typeof COMMON_ERROR_DETAILS.CONSENT_REQUIRED>>().toEqualTypeOf<{
    pendingConsents: PendingConsent[];
  }>();
});
