import type { KeyValueStorage } from "../platform";
import { StorageKey } from "../storage";

export interface ResumeOwner {
  userId: string;
  memberId: string;
  entityId: string;
  storeId: string;
  role: string;
  storeScope: string;
}
export interface ResumeManifest {
  version: 1;
  owner: ResumeOwner;
  token: string;
  fileId: string;
  bucket: string;
  region: string;
  key: string;
  size: number;
  chunkSize: number;
  digests: string[];
  uploadId: string | null;
  phase: "initiating" | "uploading" | "completing" | "uploaded";
  confirmKey: string;
  expiresAt: number;
}
export class ResumeRecordError extends Error {
  constructor(
    message: string,
    readonly fileId: string,
  ) {
    super(message);
  }
}
const ownerKeys = ["userId", "memberId", "entityId", "storeId", "role", "storeScope"];
const recordKeys = [
  "version",
  "owner",
  "token",
  "fileId",
  "bucket",
  "region",
  "key",
  "size",
  "chunkSize",
  "digests",
  "uploadId",
  "phase",
  "confirmKey",
  "expiresAt",
];
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 2048 &&
  [...value].every((char) => char.charCodeAt(0) >= 32);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export const sameResumeOwner = (a: ResumeOwner, b: ResumeOwner) =>
  ownerKeys.every((key) => a[key as keyof ResumeOwner] === b[key as keyof ResumeOwner]);
function valid(value: unknown): value is ResumeManifest {
  if (
    !object(value) ||
    !exact(value, recordKeys) ||
    !object(value.owner) ||
    !exact(value.owner, ownerKeys)
  )
    return false;
  const owner = value.owner;
  if (!ownerKeys.every((key) => text(owner[key]))) return false;
  if (
    value.version !== 1 ||
    !positive(value.size) ||
    !positive(value.chunkSize) ||
    !positive(value.expiresAt)
  )
    return false;
  if (
    !["token", "fileId", "bucket", "region", "key", "confirmKey"].every((key) => text(value[key]))
  )
    return false;
  if (
    !Array.isArray(value.digests) ||
    value.digests.length !== Math.ceil(value.size / value.chunkSize) ||
    value.digests.length > 10000
  )
    return false;
  if (
    !value.digests.every((digest) => typeof digest === "string" && /^[a-f0-9]{32}$/u.test(digest))
  )
    return false;
  if (!["initiating", "uploading", "completing", "uploaded"].includes(String(value.phase)))
    return false;
  return value.phase === "initiating" ? value.uploadId === null : text(value.uploadId);
}

/** 单份有界记录表；损坏不静默当作首次上传，避免重复初始化。 */
export function createResumeStore(storage: KeyValueStorage, now: () => number) {
  const read = (): ResumeManifest[] => {
    const value = storage.get<unknown>(StorageKey.uploadResume);
    if (value === null) return [];
    if (!Array.isArray(value) || value.length > 20 || !value.every(valid))
      throw new Error("续传记录损坏，请取消原上传后重新选择");
    return value;
  };
  const write = (records: ResumeManifest[]) => {
    storage.set(StorageKey.uploadResume, records);
    const actual = read();
    if (JSON.stringify(actual) !== JSON.stringify(records))
      throw new Error("无法保存续传记录，请检查本机存储后重试");
  };
  return {
    load(owner: ResumeOwner, token: string): ResumeManifest | null {
      const records = read().filter(
        (item) => sameResumeOwner(item.owner, owner) && item.token === token,
      );
      if (records.length > 1) throw new Error("续传记录冲突，请取消原上传");
      const record = records[0];
      if (record && record.expiresAt <= now())
        throw new ResumeRecordError("原上传已过期，请取消后重新选择", record.fileId);
      return record ? (JSON.parse(JSON.stringify(record)) as ResumeManifest) : null;
    },
    save(record: ResumeManifest): void {
      if (
        !valid(record) ||
        record.expiresAt <= now() ||
        record.expiresAt > now() + 24 * 60 * 60 * 1000
      )
        throw new Error("续传记录不合格");
      const records = read().filter(
        (item) => !(sameResumeOwner(item.owner, record.owner) && item.token === record.token),
      );
      if (records.length >= 20) throw new Error("续传任务过多，请先取消旧任务");
      write([...records, JSON.parse(JSON.stringify(record)) as ResumeManifest]);
    },
    remove(owner: ResumeOwner, fileId: string): void {
      write(
        read().filter((item) => !(sameResumeOwner(item.owner, owner) && item.fileId === fileId)),
      );
    },
    clear(): void {
      storage.remove(StorageKey.uploadResume);
      if (storage.get<unknown>(StorageKey.uploadResume) !== null)
        throw new Error("无法清除续传记录");
    },
  };
}
export type ResumeStore = ReturnType<typeof createResumeStore>;
