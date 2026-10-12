/** 平台边界为显式离线替身；仍执行真实任务协调和公共 POST 队列。 */
export const ASSET_UPLOAD_SCENES = [
  "image",
  "video",
  "recording",
  "audio",
  "document",
  "text",
  "loading",
  "options-error",
  "clerk-gated",
  "partial",
  "create-unknown",
  "scope-late",
  "cancel-error",
  "resume-reselect",
  "resume-mismatch",
  "recovery-blocked",
].map((name) => ({ name: `asset-upload-${name}`, route: "sub/asset/upload/index" }));
