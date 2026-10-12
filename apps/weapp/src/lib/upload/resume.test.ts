import { describe, expect, it, vi } from "vitest";
import type { KeyValueStorage } from "../platform";
import { StorageKey } from "../storage";
import { createResumeStore, sameResumeOwner } from "./resume";
import type { ResumeManifest, ResumeOwner } from "./resume";

const NOW = Date.parse("2026-10-12T04:00:00Z"),
  DAY = 86_400_000;
const owner = (): ResumeOwner => ({
  userId: "user-1",
  memberId: "member-1",
  entityId: "entity-1",
  storeId: "store-1",
  role: "owner",
  storeScope: "all",
});
const manifest = (): ResumeManifest => ({
  version: 1,
  owner: owner(),
  token: "fingerprint",
  fileId: "00000000-0000-4000-8000-000000000001",
  bucket: "test-media-1250000000",
  region: "ap-beijing",
  key: "incoming/00000000-0000-4000-8000-000000000001/clip.mp4",
  size: 9,
  chunkSize: 8,
  digests: ["0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210"],
  uploadId: "upload-1",
  phase: "uploading",
  confirmKey: "file_complete:original",
  expiresAt: NOW + DAY,
});
function memory() {
  const values = new Map<string, unknown>();
  const storage: KeyValueStorage = {
    get: <T>(key: string): T | null =>
      values.has(key) ? (structuredClone(values.get(key)) as T) : null,
    set: vi.fn((key, value) => {
      values.set(key, structuredClone(value));
    }),
    remove: vi.fn((key) => {
      values.delete(key);
    }),
  };
  return { values, storage, store: createResumeStore(storage, () => NOW) };
}

describe("分块恢复记录：严格、无凭证、可验证持久化", () => {
  it.each(["initiating", "uploading", "completing", "uploaded"] as const)(
    "%s：写后读回且新实例恢复原确认键",
    (phase) => {
      const h = memory(),
        record = { ...manifest(), phase, uploadId: phase === "initiating" ? null : "upload-1" };
      h.store.save(record);
      const reopened = createResumeStore(h.storage, () => NOW);
      expect(reopened.load(owner(), record.token)).toEqual(record);
      expect(h.storage.set).toHaveBeenCalledExactlyOnceWith(StorageKey.uploadResume, [record]);
      const raw = JSON.stringify(h.values.get(StorageKey.uploadResume));
      for (const forbidden of [
        "tmpSecret",
        "sessionToken",
        "Authorization",
        "accessToken",
        "filePath",
        "wxfile://",
      ])
        expect(raw).not.toContain(forbidden);
    },
  );

  it("save和load都断开可变引用，改本地对象不能篡改原分块证据", () => {
    const h = memory(),
      record = manifest(),
      original = structuredClone(record);
    h.store.save(record);
    record.digests[0] = "a".repeat(32);
    record.owner.role = "clerk";
    const restored = h.store.load(owner(), original.token)!;
    expect(restored).toEqual(original);
    restored.digests[1] = "b".repeat(32);
    restored.owner.storeId = "foreign";
    expect(h.store.load(owner(), original.token)).toEqual(original);
  });

  it.each(["userId", "memberId", "entityId", "storeId", "role", "storeScope"] as const)(
    "%s变化即不是同一归属；不读取原记录也不删除别人的任务",
    (field) => {
      const h = memory(),
        record = manifest();
      h.store.save(record);
      const other = { ...owner(), [field]: "changed" };
      expect(sameResumeOwner(owner(), other)).toBe(false);
      expect(h.store.load(other, record.token)).toBeNull();
      h.store.remove(other, record.fileId);
      expect(h.store.load(owner(), record.token)).toEqual(record);
      expect(h.store.load(owner(), "different-token")).toBeNull();
    },
  );

  it.each([0, -1, DAY + 1])("过期/超出24小时边界 %i 不保存", (offset) => {
    const h = memory();
    expect(() => h.store.save({ ...manifest(), expiresAt: NOW + offset })).toThrow();
    expect(h.storage.set).not.toHaveBeenCalled();
  });
  it("到期等于当前毫秒拒绝恢复，绝不把旧记录当作首次上传", () => {
    const h = memory(),
      record = manifest();
    h.store.save(record);
    const later = createResumeStore(h.storage, () => record.expiresAt);
    expect(() => later.load(owner(), record.token)).toThrow("过期");
    expect(h.values.get(StorageKey.uploadResume)).toEqual([record]);
  });

  it.each([
    { title: "陌生顶层", patch: { extra: true } },
    { title: "STS", patch: { sts: { tmpSecretKey: "fictional" } } },
    { title: "会话令牌", patch: { accessToken: "fictional-session" } },
    { title: "本机路径", patch: { path: "wxfile://tmp/video" } },
    { title: "版本", patch: { version: 2 } },
    { title: "非法phase", patch: { phase: "stored" } },
    { title: "无UploadId", patch: { uploadId: null } },
    { title: "非整数size", patch: { size: 1.5 } },
    { title: "零chunk", patch: { chunkSize: 0 } },
    { title: "摘要数量", patch: { digests: ["a".repeat(32)] } },
    { title: "摘要格式", patch: { digests: ["g".repeat(32), "a".repeat(32)] } },
    { title: "owner陌生字段", patch: { owner: { ...owner(), accessToken: "fictional" } } },
  ])("$title：损坏记录严格拒绝读写", ({ patch }) => {
    const h = memory(),
      bad = { ...manifest(), ...patch };
    expect(() => h.store.save(bad as ResumeManifest)).toThrow();
    expect(h.storage.set).not.toHaveBeenCalled();
    h.values.set(StorageKey.uploadResume, [bad]);
    expect(() => h.store.load(owner(), "fingerprint")).toThrow("损坏");
  });

  it.each(["read", "set", "silent_set", "readback", "remove", "silent_remove"] as const)(
    "%s失败不报告持久化成功",
    (mode) => {
      const h = memory();
      if (mode === "read")
        h.storage.get = () => {
          throw new Error("read denied");
        };
      if (mode === "set")
        h.storage.set = () => {
          throw new Error("disk full");
        };
      if (mode === "silent_set") h.storage.set = () => {};
      if (mode === "readback")
        h.storage.set = (key) => {
          h.values.set(key, []);
        };
      if (mode === "remove" || mode === "silent_remove") {
        h.store.save(manifest());
        h.storage.remove =
          mode === "remove"
            ? () => {
                throw new Error("remove denied");
              }
            : () => {};
        expect(() => h.store.clear()).toThrow();
      } else expect(() => h.store.save(manifest())).toThrow();
    },
  );

  it("重复owner/token不是首次上传；20项上限保留旧任务，删除只匹配完整owner/file", () => {
    const h = memory(),
      record = manifest();
    h.values.set(StorageKey.uploadResume, [record, { ...record, fileId: "other" }]);
    expect(() => h.store.load(owner(), record.token)).toThrow("冲突");
    h.values.delete(StorageKey.uploadResume);
    for (let n = 0; n < 20; n++)
      h.store.save({ ...record, token: `token-${n}`, fileId: `file-${n}` });
    const before = structuredClone(h.values.get(StorageKey.uploadResume));
    expect(() => h.store.save({ ...record, token: "token-20" })).toThrow("过多");
    expect(h.values.get(StorageKey.uploadResume)).toEqual(before);
    h.store.remove(owner(), "file-7");
    expect(h.store.load(owner(), "token-7")).toBeNull();
    expect(h.store.load(owner(), "token-8")?.fileId).toBe("file-8");
    h.values.set(StorageKey.accessToken, "fictional-access-token");
    h.store.clear();
    expect(h.values.has(StorageKey.uploadResume)).toBe(false);
    expect(h.values.get(StorageKey.accessToken)).toBe("fictional-access-token");
  });
});
