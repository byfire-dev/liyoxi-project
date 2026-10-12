import type { SelectedFile } from "@/lib/upload/queue";
import type { ResumeOwner } from "@/lib/upload/resume";
import type { AssetCreateBody, AssetCreated } from "./upload-api";
export type UploadType = AssetCreateBody["type"];
export interface UploadForm {
  type: UploadType;
  files: SelectedFile[];
  textBody: string;
  note: string;
  tags: string[];
  demandId: string | null;
}
export interface IntentFile {
  name: string;
  size: number;
  width: number;
  height: number;
  durationMs: number;
  token: string;
  fileId: string | null;
  cancelKey: string;
  status: "pending" | "stored" | "cancelled";
}
export type IntentPhase =
  "uploading" | "submitting" | "create_unknown" | "cancelling" | "cancel_unknown";
export interface UploadIntent {
  version: 1;
  id: string;
  owner: ResumeOwner;
  expiresAt: number;
  createKey: string;
  type: UploadType;
  textBody: string;
  note: string;
  tags: string[];
  demandId: string | null;
  files: IntentFile[];
  phase: IntentPhase;
}
export type TaskPhase =
  | IntentPhase
  | "queued"
  | "failed"
  | "needs_reselect"
  | "recovery_blocked"
  | "cancel_failed"
  | "cancelled"
  | "succeeded";
export interface AssetUploadTask {
  intent: UploadIntent;
  phase: TaskPhase;
  files: { name: string; status: string; progress: number; message: string | null }[];
  message: string | null;
  result: AssetCreated | null;
}
export const uploadTypes: UploadType[] = [
  "image",
  "video",
  "recording",
  "audio",
  "document",
  "text",
];
const exts: Record<UploadType, string[]> = {
  image: ["jpg", "jpeg", "png"],
  video: ["mp4", "mov"],
  recording: ["mp3", "m4a", "wav", "aac"],
  audio: ["mp3", "m4a", "wav", "aac"],
  document: ["pdf", "docx", "txt"],
  text: [],
};
export function validateUploadForm(form: UploadForm): void {
  if (
    !uploadTypes.includes(form.type) ||
    form.tags.length > 8 ||
    new Set(form.tags).size !== form.tags.length ||
    form.tags.some((v) => !v || v.length > 100)
  )
    throw new Error("请选择最多8个不同的内容标签");
  if (form.type === "text") {
    if (!form.textBody.trim() || form.textBody.length > 500 || form.files.length || form.note)
      throw new Error("请填写1–500字文字，不附文件或补充说明");
    return;
  }
  if (
    form.textBody ||
    form.note.length > 200 ||
    form.files.length < 1 ||
    form.files.length > 9 ||
    (form.type === "recording" && form.files.length !== 1)
  )
    throw new Error("请选择合格文件，录音限一段，说明最多200字");
  for (const file of form.files) {
    const ext = /\.([a-z0-9]+)$/iu.exec(file.name)?.[1]?.toLowerCase();
    if (
      !ext ||
      !exts[form.type].includes(ext) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      (form.type === "recording" && (file.durationMs ?? 0) > 300000)
    )
      throw new Error("文件格式、大小或录音时长不合格");
  }
}
export function intentBody(intent: UploadIntent): AssetCreateBody {
  const shared = {
    type: intent.type,
    contentTagCodes: [...intent.tags],
    ...(intent.demandId ? { assetDemandId: intent.demandId } : {}),
  };
  if (intent.type === "text") return { ...shared, textBody: intent.textBody };
  if (intent.files.some((file) => file.status !== "stored" || !file.fileId))
    throw new Error("全部文件入库后才能提交素材");
  const fileIds = intent.files.map((file) => file.fileId!);
  if (new Set(fileIds).size !== fileIds.length) throw new Error("同一素材不能重复引用文件");
  return { ...shared, fileIds, ...(intent.note ? { note: intent.note } : {}) };
}
