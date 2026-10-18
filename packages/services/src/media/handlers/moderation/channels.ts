/** D5 §11: transmission content only; legal evidence and finished episodes are excluded. */
export type ModerationKind = "audit_image" | "audit_image_wx" | "audit_video" | "audit_text";
export interface ModerationFile {
  readonly category: string;
  readonly ext: string;
  readonly uploadActorType: string;
  readonly uploadClient: string | null;
  readonly sizeBytes: bigint | null;
}
const images = new Set(["jpg", "jpeg", "png"]);
const privateImages = new Set([
  "profile_image",
  "profile_promo",
  "store_asset",
  "channel_screenshot",
  "ticket_attachment",
]);
const videos = new Set([
  "profile_video",
  "profile_promo",
  "store_asset",
  "ad_video",
  "trailer_src",
]);
const extract = new Set(["mp3", "m4a", "wav", "aac", "pdf", "docx"]);
export const needsExtractedText = (ext: string): boolean => extract.has(ext);

export function moderationChannel(file: ModerationFile): ModerationKind | null {
  if (images.has(file.ext)) {
    if (["poster", "banner"].includes(file.category)) return "audit_image";
    if (!privateImages.has(file.category)) return null;
    return file.uploadActorType === "merchant" &&
      file.uploadClient === "weapp" &&
      file.sizeBytes !== null &&
      file.sizeBytes > 0n &&
      file.sizeBytes <= 5n * 1024n * 1024n
      ? "audit_image_wx"
      : "audit_image";
  }
  if (["mp4", "mov"].includes(file.ext) && videos.has(file.category)) return "audit_video";
  if (file.category === "store_asset" && (file.ext === "txt" || needsExtractedText(file.ext)))
    return "audit_text";
  return null;
}
