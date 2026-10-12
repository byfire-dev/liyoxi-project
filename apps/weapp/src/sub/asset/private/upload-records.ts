import type { KeyValueStorage } from "@/lib/platform";
import { StorageKey } from "@/lib/storage";
import { sameResumeOwner, type ResumeOwner } from "@/lib/upload/resume";
import { uploadTypes, type UploadIntent } from "./upload-model";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const text = (v: unknown, max = 2048): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  !Array.from(v).some((c) => c.charCodeAt(0) < 32);
function valid(v: unknown): v is UploadIntent {
  if (
    !object(v) ||
    !exact(v, [
      "version",
      "id",
      "owner",
      "expiresAt",
      "createKey",
      "type",
      "textBody",
      "note",
      "tags",
      "demandId",
      "files",
      "phase",
    ]) ||
    !object(v.owner) ||
    !exact(v.owner, ["userId", "memberId", "entityId", "storeId", "role", "storeScope"]) ||
    !Object.values(v.owner).every((a) => text(a))
  )
    return false;
  if (
    v.version !== 1 ||
    !text(v.id) ||
    !text(v.createKey) ||
    !Number.isSafeInteger(v.expiresAt) ||
    Number(v.expiresAt) <= 0 ||
    !uploadTypes.some((type) => type === v.type) ||
    typeof v.textBody !== "string" ||
    v.textBody.length > 500 ||
    typeof v.note !== "string" ||
    v.note.length > 200 ||
    !Array.isArray(v.tags) ||
    v.tags.length > 8 ||
    !v.tags.every((a) => text(a, 100)) ||
    new Set(v.tags).size !== v.tags.length ||
    (v.demandId !== null && !text(v.demandId)) ||
    !Array.isArray(v.files) ||
    v.files.length > 9 ||
    !["uploading", "submitting", "create_unknown", "cancelling", "cancel_unknown"].includes(
      String(v.phase),
    )
  )
    return false;
  if (
    v.type === "text"
      ? !v.textBody.trim() || !!v.note || v.files.length !== 0
      : !!v.textBody || v.files.length < 1 || (v.type === "recording" && v.files.length !== 1)
  )
    return false;
  return v.files.every(
    (f) =>
      object(f) &&
      exact(f, [
        "name",
        "size",
        "width",
        "height",
        "durationMs",
        "token",
        "fileId",
        "cancelKey",
        "status",
      ]) &&
      text(f.name, 200) &&
      Number.isSafeInteger(f.size) &&
      Number(f.size) > 0 &&
      [f.width, f.height, f.durationMs].every((n) => Number.isSafeInteger(n) && Number(n) >= 0) &&
      text(f.token, 64) &&
      /^[A-Za-z0-9_-]+$/u.test(f.token) &&
      (f.fileId === null || text(f.fileId)) &&
      text(f.cancelKey) &&
      ["pending", "stored", "cancelled"].includes(String(f.status)) &&
      (f.status === "pending" || f.fileId !== null),
  );
}
export function createAssetUploadRecords(storage: KeyValueStorage, now: () => number) {
  const read = (): UploadIntent[] => {
    const value = storage.get<unknown>(StorageKey.assetUploadIntents);
    if (value === null) return [];
    if (
      !Array.isArray(value) ||
      value.length > 20 ||
      !value.every(valid) ||
      value.reduce((n, r) => n + r.files.length, 0) > 20
    )
      throw new Error("素材上传记录损坏，已阻止新上传，请保留记录联系支持");
    return value;
  };
  const write = (records: UploadIntent[]) => {
    storage.set(StorageKey.assetUploadIntents, records);
    if (JSON.stringify(read()) !== JSON.stringify(records))
      throw new Error("无法可靠保存素材任务，请检查本机存储");
  };
  return {
    list(owner: ResumeOwner): UploadIntent[] {
      return clone(read().filter((r) => sameResumeOwner(r.owner, owner)));
    },
    save(record: UploadIntent): void {
      const existing = read();
      if (
        !valid(record) ||
        record.expiresAt > now() + 86400000 ||
        (record.expiresAt <= now() &&
          !existing.some((r) => r.id === record.id && sameResumeOwner(r.owner, record.owner)))
      )
        throw new Error("素材任务记录不合格或已过期");
      const records = existing.filter(
        (r) => !(r.id === record.id && sameResumeOwner(r.owner, record.owner)),
      );
      if (
        records.length >= 20 ||
        records.reduce((n, r) => n + r.files.length, 0) + record.files.length > 20
      )
        throw new Error("本机待办文件已满20份，请先处理旧任务");
      write([...records, clone(record)]);
    },
    remove(owner: ResumeOwner, id: string): void {
      write(read().filter((r) => !(r.id === id && sameResumeOwner(r.owner, owner))));
    },
    clear(): void {
      storage.remove(StorageKey.assetUploadIntents);
      if (storage.get(StorageKey.assetUploadIntents) !== null)
        throw new Error("无法清除素材任务记录");
    },
  };
}
export type AssetUploadRecords = ReturnType<typeof createAssetUploadRecords>;
