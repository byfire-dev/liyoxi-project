import { describe, expect, it, vi } from "vitest";
import type { KeyValueStorage } from "@/lib/platform";
import { StorageKey } from "@/lib/storage";
import type { ResumeOwner } from "@/lib/upload/resume";
import type { UploadIntent } from "./upload-model";
import { createAssetUploadRecords } from "./upload-records";

const NOW = 1000000;
const OWNER: ResumeOwner = {
  userId: "u",
  memberId: "m",
  entityId: "e",
  storeId: "s",
  role: "owner",
  storeScope: "all",
};
function record(id = "a", count = 1): UploadIntent {
  return {
    version: 1,
    id,
    owner: { ...OWNER },
    expiresAt: NOW + 86400000,
    createKey: `asset_create:${id}`,
    type: "image",
    textBody: "",
    note: "门店说明",
    tags: ["content"],
    demandId: null,
    phase: "uploading",
    files: Array.from({ length: count }, (_, n) => ({
      name: `${n}.png`,
      size: 8,
      width: 1,
      height: 1,
      durationMs: 0,
      token: `token_${id}_${n}`,
      fileId: null,
      cancelKey: `file_cancel:${id}:${n}`,
      status: "pending",
    })),
  };
}
function harness() {
  let value: unknown = null,
    now = NOW;
  const storage: KeyValueStorage = {
    get: <T>() => structuredClone(value) as T | null,
    set: vi.fn((_key, next) => {
      value = structuredClone(next);
    }),
    remove: vi.fn(() => {
      value = null;
    }),
  };
  return {
    storage,
    records: createAssetUploadRecords(storage, () => now),
    raw: () => value,
    corrupt: (next: unknown) => {
      value = next;
    },
    advance: () => {
      now += 86400001;
    },
  };
}

describe("非凭证素材意图journal", () => {
  it("完整白名单可读回；save/list均不保留调用方可变引用", () => {
    const h = harness(),
      input = record();
    h.records.save(input);
    input.files[0]!.name = "changed";
    input.owner.storeId = "other";
    const loaded = h.records.list(OWNER);
    expect(loaded[0]).toEqual(record());
    loaded[0]!.files[0]!.name = "mutated";
    expect(h.records.list(OWNER)[0]).toEqual(record());
    expect(h.storage.set).toHaveBeenCalledWith(StorageKey.assetUploadIntents, [record()]);
  });
  it.each(["userId", "memberId", "entityId", "storeId", "role", "storeScope"] as const)(
    "owner的%s不同即隔离，remove不波及另一个owner",
    (key) => {
      const h = harness(),
        other = { ...OWNER, [key]: `${OWNER[key]}-other` };
      h.records.save(record());
      h.records.save({ ...record(), owner: other });
      expect(h.records.list(other)).toHaveLength(1);
      h.records.remove(OWNER, "a");
      expect(h.records.list(OWNER)).toEqual([]);
      expect(h.records.list(other)).toHaveLength(1);
    },
  );
  it.each(["accessToken", "path", "post", "sts", "url", "secret", "progress"])(
    "拒绝顶层额外字段 %s",
    (key) => {
      const h = harness();
      expect(() => h.records.save({ ...record(), [key]: "sensitive" })).toThrow();
      expect(h.storage.set).not.toHaveBeenCalled();
    },
  );
  it.each(["accessToken", "path", "sts", "etag"])("拒绝文件额外字段 %s", (key) => {
    const h = harness(),
      input = record();
    Object.assign(input.files[0]!, { [key]: "sensitive" });
    expect(() => h.records.save(input)).toThrow();
    expect(h.storage.set).not.toHaveBeenCalled();
  });
  it("owner额外字段也拒绝；合法持久化不包含凭证或临时路径", () => {
    const h = harness();
    expect(() =>
      h.records.save(Object.assign(record(), { owner: { ...OWNER, accessToken: "secret" } })),
    ).toThrow();
    h.records.save(record());
    expect(JSON.stringify(h.raw())).not.toMatch(/accessToken|wxfile|https:|sts|post/u);
  });
  it.each([
    { version: 2 },
    { phase: "succeeded" },
    { expiresAt: NOW },
    { expiresAt: NOW + 86400001 },
    { tags: ["same", "same"] },
    { files: [] },
    { type: "text", textBody: "文字" },
    { note: "字".repeat(201) },
    { demandId: "" },
  ])("拒绝不合格新记录 %#", (patch) => {
    const h = harness();
    expect(() => h.records.save({ ...record(), ...patch } as UploadIntent)).toThrow();
    expect(h.storage.set).not.toHaveBeenCalled();
  });
  it.each([
    { size: 0 },
    { size: 1.5 },
    { width: -1 },
    { durationMs: -1 },
    { token: "bad/token" },
    { status: "stored", fileId: null },
    { status: "cancelled", fileId: null },
  ])("拒绝不合格文件元数据 %#", (patch) => {
    const h = harness(),
      input = record();
    Object.assign(input.files[0]!, patch);
    expect(() => h.records.save(input)).toThrow();
    expect(h.storage.set).not.toHaveBeenCalled();
  });
  it("20个文件总容量，不按意图数错误放行21个文件", () => {
    const h = harness();
    h.records.save(record("a", 9));
    h.records.save(record("b", 9));
    h.records.save(record("c", 2));
    expect(h.records.list(OWNER).flatMap((item) => item.files)).toHaveLength(20);
    expect(() => h.records.save(record("d"))).toThrow(/20/u);
    h.records.save({ ...record("c", 2), note: "更新同意图不额外占位" });
    expect(h.records.list(OWNER)).toHaveLength(3);
  });
  it("纯文字意图也有20条上限", () => {
    const h = harness();
    for (let n = 0; n < 20; n++)
      h.records.save({ ...record(`${n}`, 0), type: "text", textBody: "文字", note: "" });
    expect(() =>
      h.records.save({ ...record("overflow", 0), type: "text", textBody: "文字", note: "" }),
    ).toThrow(/20/u);
  });
  it("过期旧意图保留供确认取消，不当成空表或新建许可", () => {
    const h = harness();
    h.records.save(record());
    h.advance();
    expect(h.records.list(OWNER)[0]!.expiresAt).toBe(NOW + 86400000);
    h.records.save({ ...record(), phase: "cancel_unknown" });
    expect(h.records.list(OWNER)[0]!.phase).toBe("cancel_unknown");
    expect(() => h.records.save(record("new"))).toThrow(/过期/u);
  });
  it.each([
    {},
    "invalid",
    [record(), { invalid: true }],
    Array.from({ length: 21 }, () => record()),
  ])("整表损坏不当空表，不能删一项掩盖其他损坏 %#", (value) => {
    const h = harness();
    h.corrupt(value);
    expect(() => h.records.list(OWNER)).toThrow(/损坏/u);
    expect(() => h.records.remove(OWNER, "a")).toThrow(/损坏/u);
    expect(h.storage.set).not.toHaveBeenCalled();
    expect(h.raw()).toEqual(value);
  });
  it.each(["drop", "alter"])("写后严格读回发现%s", (mode) => {
    const h = harness();
    vi.mocked(h.storage.set).mockImplementation((_key, value) => {
      if (mode === "alter") h.corrupt([{ ...(value as UploadIntent[])[0]!, note: "corrupt" }]);
    });
    expect(() => h.records.save(record())).toThrow(/保存/u);
  });
  it("读取异常传播，清除也必须读回确认", () => {
    const h = harness();
    h.records.save(record());
    vi.mocked(h.storage.remove).mockImplementation(() => {});
    expect(() => h.records.clear()).toThrow(/清除/u);
    expect(h.records.list(OWNER)).toHaveLength(1);
    h.storage.get = () => {
      throw new Error("disk unavailable");
    };
    expect(() => h.records.list(OWNER)).toThrow("disk unavailable");
  });
});
