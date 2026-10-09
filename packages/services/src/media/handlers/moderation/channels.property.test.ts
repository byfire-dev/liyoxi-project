import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { moderationChannel } from "./channels.js";

describe("moderation routing properties", () => {
  it("only merchant weapp images within the exact byte bound choose WX", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -1n, max: 10n * 1024n * 1024n }),
        fc.constantFrom("merchant", "staff", "system"),
        fc.constantFrom("weapp", "admin", "worker", null),
        (sizeBytes, uploadActorType, uploadClient) => {
          const channel = moderationChannel({
            category: "store_asset",
            ext: "png",
            uploadActorType,
            uploadClient,
            sizeBytes,
          });
          expect(channel === "audit_image_wx").toBe(
            uploadActorType === "merchant" &&
              uploadClient === "weapp" &&
              sizeBytes > 0n &&
              sizeBytes <= 5n * 1024n * 1024n,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
  it("legal and final-delivery evidence never gain an invented automatic audit", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          "kyc_license",
          "kyc_permit",
          "pay_receipt",
          "invoice",
          "portrait_auth",
          "drama_license_doc",
          "sample_video",
          "final_episode",
          "drama_master",
        ),
        fc.constantFrom("png", "mp4", "txt", "mp3", "pdf"),
        (category, ext) => {
          expect(
            moderationChannel({
              category,
              ext,
              uploadActorType: "merchant",
              uploadClient: "weapp",
              sizeBytes: 1024n,
            }),
          ).toBeNull();
        },
      ),
      { numRuns: 100 },
    );
  });
});
