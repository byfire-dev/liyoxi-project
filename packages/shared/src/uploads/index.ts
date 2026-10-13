// W1-07：上传分类、类型与时效的纯登记表。依据：06 第 3.1 节、m08 第 3.21 节、C61。
export type UploadBucket = "secure" | "asset" | "media" | "pub";
export type UploadScope = "platform" | "entity" | "store";
const image = ["jpg", "jpeg", "png"] as const;
const video = ["mp4", "mov"] as const;
const documentExts = ["pdf", "docx", "txt"] as const;
export const UPLOAD_LIMITS = { imageMaxMb: 5, weappVideoDefaultMaxMb: 100 } as const;
interface Category {
  bucket: UploadBucket;
  scope: UploadScope;
  exts: readonly string[];
  merchant: boolean;
  admin: boolean;
  system: boolean;
  crossStore: boolean;
  minKeepDays: number;
}
const category = (
  bucket: UploadBucket,
  scope: UploadScope,
  exts: readonly string[],
  options: Partial<Omit<Category, "bucket" | "scope" | "exts">> = {},
): Category => ({
  bucket,
  scope,
  exts,
  merchant: false,
  admin: false,
  system: false,
  crossStore: false,
  minKeepDays: 7,
  ...options,
});
export const UPLOAD_CATEGORIES = {
  kyc_license: category("secure", "entity", image, { merchant: true }),
  kyc_permit: category("secure", "store", image, { merchant: true }),
  pay_receipt: category("secure", "entity", [...image, "pdf"], { merchant: true }),
  invoice: category("secure", "entity", ["pdf", "ofd", "xml"]),
  legal_doc: category("secure", "platform", documentExts, { admin: true, system: true }),
  seal_image: category("secure", "platform", ["png"]),
  consent_digest: category("secure", "platform", ["txt"]),
  drama_license_doc: category("secure", "platform", [...image, "pdf"], {
    admin: true,
    system: true,
  }),
  evidence: category("secure", "store", image, { admin: true }),
  export: category("secure", "platform", ["xlsx", "csv"], { minKeepDays: 0 }),
  profile_image: category("asset", "store", image, { merchant: true, crossStore: true }),
  profile_video: category("asset", "store", video, { merchant: true, crossStore: true }),
  profile_promo: category("asset", "store", [...image, ...video], {
    merchant: true,
    crossStore: true,
  }),
  store_asset: category(
    "asset",
    "store",
    [...image, ...video, ...documentExts, "mp3", "m4a", "wav", "aac"],
    { merchant: true, admin: true, crossStore: true },
  ),
  channel_screenshot: category("asset", "store", image, { merchant: true }),
  ticket_attachment: category("asset", "store", image),
  video_cover: category("asset", "store", image),
  drama_master: category("media", "platform", video),
  trailer_src: category("media", "platform", video, { admin: true }),
  ad_video: category("media", "store", video),
  sample_video: category("media", "store", video, { admin: true }),
  sample_wm: category("media", "store", video),
  final_episode: category("media", "store", video, { admin: true }),
  package_zip: category("media", "store", ["zip"], { minKeepDays: 0 }),
  publish_list: category("media", "store", ["txt"]),
  trailer_out: category("pub", "platform", ["mp4"]),
  poster: category("pub", "platform", image, { admin: true, system: true }),
  banner: category("pub", "platform", image, { admin: true }),
  pay_bill: category("secure", "platform", ["csv", "txt"]),
  wecom_qr: category("asset", "platform", image),
  account_proof: category("secure", "entity", [...image, "pdf"], { admin: true }),
  portrait_auth: category("secure", "store", [...image, "pdf"], {
    merchant: true,
    admin: true,
    crossStore: true,
  }),
} as const satisfies Record<string, Category>;
export type UploadCategory = keyof typeof UPLOAD_CATEGORIES;
export const MIME_BY_EXT: Readonly<Record<string, string>> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  pdf: "application/pdf",
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  aac: "audio/aac",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  csv: "text/csv",
  xml: "application/xml",
  ofd: "application/ofd",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
export function extensionOf(name: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return ext === undefined ? null : ext;
}
export function maxUploadBytes(
  kind: UploadCategory,
  ext: string,
  client: "weapp" | "admin",
  videoMaxMb = 100,
): bigint {
  const imageMb = kind === "seal_image" || kind === "banner" ? 1 : UPLOAD_LIMITS.imageMaxMb;
  const mb = image.includes(ext as (typeof image)[number])
    ? imageMb
    : ext === "pdf" && (kind === "pay_receipt" || kind === "invoice")
      ? 10
      : ["mp4", "mov"].includes(ext)
        ? client === "weapp"
          ? Math.min(kind === "profile_video" ? 200 : videoMaxMb, videoMaxMb)
          : kind === "drama_master" || kind === "trailer_src"
            ? 500
            : 200
        : ["mp3", "m4a", "wav", "aac"].includes(ext)
          ? 50
          : 20;
  return BigInt(mb) * 1024n * 1024n;
}
export function matchesMagic(ext: string, bytes: Uint8Array): boolean {
  const at = (offset: number, values: readonly number[]) =>
    values.every((value, i) => bytes[offset + i] === value);
  const ascii = (offset: number, text: string) =>
    at(
      offset,
      [...text].map((char) => char.charCodeAt(0)),
    );
  if (ext === "jpg" || ext === "jpeg") return at(0, [0xff, 0xd8, 0xff]);
  if (ext === "png") return at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (ext === "pdf") return ascii(0, "%PDF-");
  if (["mp4", "mov", "m4a"].includes(ext)) return ascii(4, "ftyp");
  if (ext === "mp3")
    return ascii(0, "ID3") || (bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0);
  if (ext === "wav") return ascii(0, "RIFF") && ascii(8, "WAVE");
  if (ext === "aac") return bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xf6) === 0xf0;
  if (["docx", "xlsx", "zip", "ofd"].includes(ext)) return at(0, [0x50, 0x4b, 0x03, 0x04]);
  if (["txt", "csv", "xml"].includes(ext)) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return !bytes.includes(0);
    } catch {
      return false;
    }
  }
  return false;
}
export function readUrlExpiry(
  kind: UploadCategory,
  ext: string,
  now: Date,
  audience: "staff" | "merchant" = "staff",
): Date {
  const ms = now.getTime();
  const secure = UPLOAD_CATEGORIES[kind].bucket === "secure";
  const seconds =
    kind === "legal_doc"
      ? 1800
      : kind === "package_zip"
        ? 10800
        : kind === "publish_list"
          ? 900
          : secure
            ? 300
            : kind === "final_episode" || kind === "drama_master"
              ? audience === "merchant"
                ? 900
                : 1800
              : ["mp4", "mov", "mp3", "m4a", "wav", "aac"].includes(ext)
                ? 3600
                : 1800;
  return new Date(
    seconds === 1800 && !secure && image.includes(ext as (typeof image)[number])
      ? (Math.floor(ms / 1_800_000) + 2) * 1_800_000
      : ms + seconds * 1000,
  );
}
