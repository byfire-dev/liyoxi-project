import { describe, expect, it } from "vitest";
import { moderationChannel, needsExtractedText } from "./channels.js";

const file = (category: string, ext: string, extra = {}) => ({
  category,
  ext,
  uploadActorType: "merchant",
  uploadClient: "weapp",
  sizeBytes: 5n * 1024n * 1024n,
  ...extra,
});

describe("formal moderation channel matrix", () => {
  it.each([
    "profile_image",
    "profile_promo",
    "store_asset",
    "channel_screenshot",
    "ticket_attachment",
  ])("%s merchant images up to 5MiB prefer WX", (category) => {
    expect(moderationChannel(file(category, "png"))).toBe("audit_image_wx");
    expect(moderationChannel(file(category, "png", { sizeBytes: 5n * 1024n * 1024n + 1n }))).toBe(
      "audit_image",
    );
    expect(
      moderationChannel(file(category, "png", { uploadActorType: "staff", uploadClient: "admin" })),
    ).toBe("audit_image");
  });
  it.each(["profile_video", "profile_promo", "store_asset", "ad_video", "trailer_src"])(
    "%s videos use CI, never WX",
    (category) => expect(moderationChannel(file(category, "mp4"))).toBe("audit_video"),
  );
  it.each(["poster", "banner"])("public %s always uses CI", (category) => {
    expect(moderationChannel(file(category, "jpg"))).toBe("audit_image");
  });
  it.each([
    "kyc_license",
    "kyc_permit",
    "pay_receipt",
    "invoice",
    "portrait_auth",
    "drama_license_doc",
    "sample_video",
    "final_episode",
    "drama_master",
  ])("%s does not acquire an invented full-content audit", (category) =>
    expect(moderationChannel(file(category, "png"))).toBeNull(),
  );
  it.each(["mp3", "m4a", "wav", "aac", "pdf", "docx"])(
    "%s requires actual extracted text and cannot treat original bytes as text",
    (ext) => {
      expect(moderationChannel(file("store_asset", ext))).toBe("audit_text");
      expect(needsExtractedText(ext)).toBe(true);
    },
  );
  it("stored UTF8 text is a real text source", () => {
    expect(moderationChannel(file("store_asset", "txt"))).toBe("audit_text");
    expect(needsExtractedText("txt")).toBe(false);
  });
});
