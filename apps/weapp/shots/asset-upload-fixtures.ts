import type { KeyValueStorage } from "../src/lib/platform";
import type { FileStatus, Registration, UploadApi } from "../src/lib/upload/api";
import { clientToken } from "../src/lib/upload/hash";
import { createUpload, type SelectedFile } from "../src/lib/upload/queue";
import { createResumeStore, type ResumeOwner } from "../src/lib/upload/resume";
import { StorageKey } from "../src/lib/storage";
import { useContextStore } from "../src/stores/context";
import type { AssetUploadApi } from "../src/sub/asset/private/upload-api";
import { createAssetUploadPlatform } from "../src/sub/asset/private/upload-platform";
import { createAssetUploadRecords } from "../src/sub/asset/private/upload-records";
import { createAssetUploadTasks, type AssetTaskDeps } from "../src/sub/asset/private/upload-tasks";
import type { UploadIntent, UploadType } from "../src/sub/asset/private/upload-model";
import { assetCard, assetId } from "./asset-fixtures";

type Event = { action: string; data?: unknown; key?: string; fileId?: string };
const memories = new Map<string, Map<string, unknown>>(),
  logs = new Map<string, Event[]>();
let sequence = 0;
const NOW = Date.parse("2026-10-12T02:00:00Z");
const EXPIRES = "2099-10-12T02:00:00Z";
const extension: Record<UploadType, string> = {
  image: "jpg",
  video: "mp4",
  recording: "mp3",
  audio: "m4a",
  document: "pdf",
  text: "txt",
};
const selected = (type: UploadType, n = 1): SelectedFile => ({
  path: `local-${n}`,
  name: `门店素材${n}.${extension[type]}`,
  size: 32,
  width: type === "image" ? 120 : 0,
  height: type === "image" ? 90 : 0,
  durationMs: type === "recording" ? 42000 : 0,
});
const bytes = (path: string) =>
  new Uint8Array(32).fill(path === "local-2" ? 2 : path === "wrong" ? 3 : 1);
const status = (id: string, value: FileStatus["status"]): FileStatus => ({
  fileId: id,
  category: "store_asset",
  status: value,
  rejectReason: null,
  declaredSizeBytes: "32",
  sizeBytes: "32",
  mime: "image/jpeg",
  moderationState: "pass",
  storedAt: value === "stored" ? new Date(NOW).toISOString() : null,
  uploadExpiresAt: EXPIRES,
  createdAt: new Date(NOW).toISOString(),
});
export async function createAssetUploadFixture(
  scene: string,
  scope: () => string | null,
  owner: ResumeOwner,
) {
  const events = logs.get(scene) ?? [],
    values = memories.get(scene) ?? new Map<string, unknown>(),
    pending = new Set<() => void>();
  logs.set(scene, events);
  memories.set(scene, values);
  let held = true,
    createFailed = false,
    cancelFailed = false,
    partialFailed = false,
    optionsFailed = false;
  const storage: KeyValueStorage = {
    get: <T>(key: string) => (values.get(key) ?? null) as T | null,
    set: (key, value) => {
      values.set(key, JSON.parse(JSON.stringify(value)));
    },
    remove: (key) => {
      values.delete(key);
    },
  };
  const records = createAssetUploadRecords(storage, () => NOW),
    registered = new Map<string, Registration>(),
    stored = new Set<string>();
  const fingerprint = (file: SelectedFile) =>
    Promise.resolve(
      clientToken(
        {
          ...file,
          storeId: owner.storeId,
          category: "store_asset",
          width: file.width ?? 0,
          height: file.height ?? 0,
          durationMs: file.durationMs ?? 0,
        },
        bytes(file.path),
      ),
    );
  const key = (action: string) => `${action}:${++sequence}`;
  const files: UploadApi = {
    async register(body) {
      events.push({ action: "register", data: body });
      return {
        items: body.files.map((file) => {
          let ticket = registered.get(file.clientToken);
          if (!ticket) {
            const id = assetId(100 + registered.size);
            ticket = {
              fileId: id,
              clientToken: file.clientToken,
              status: "pending",
              mode: "post",
              bucket: "offline",
              region: "offline",
              key: `incoming/${id}`,
              post: { url: "https://offline.invalid", fields: {} },
              sts: null,
              chunkSize: null,
              chunkParallel: null,
              expiresAt: EXPIRES,
              uploadExpiresAt: EXPIRES,
              credentialsLeft: 30,
            };
            registered.set(file.clientToken, ticket);
          }
          return ticket;
        }),
      };
    },
    async get(id) {
      events.push({ action: "get", fileId: id });
      return status(id, stored.has(id) ? "stored" : "pending");
    },
    async complete(id, confirmKey) {
      events.push({ action: "complete", fileId: id, key: confirmKey });
      stored.add(id);
      return status(id, "stored");
    },
    async cancel(id, cancelKey) {
      events.push({ action: "cancel", fileId: id, key: cancelKey });
      if (scene.endsWith("cancel-error") && !cancelFailed) {
        cancelFailed = true;
        throw new Error("取消回执丢失");
      }
      return status(id, "expired");
    },
    async refresh(id) {
      const ticket = [...registered.values()].find((item) => item.fileId === id);
      if (!ticket) throw new Error("无原登记");
      return ticket;
    },
  };
  const api: AssetUploadApi = {
    async create(body, createKey) {
      events.push({ action: "create", data: body, key: createKey });
      if (scene.endsWith("create-unknown") && !createFailed) {
        createFailed = true;
        throw new Error("提交回执丢失");
      }
      return {
        ...assetCard(1, body.type),
        displayStatus: "organizing",
        processingState: "processing",
        fileCount: body.fileIds?.length ?? 0,
        replayed: createFailed,
      };
    },
    async demands(cursor) {
      events.push({ action: "demands", data: cursor ?? null });
      if (scene.endsWith("loading")) await new Promise<void>(() => {});
      if (scene.endsWith("options-error") && !optionsFailed) {
        optionsFailed = true;
        throw new Error("需求暂时不可用");
      }
      const ids = cursor ? [9, 10] : [9];
      return {
        items: ids.map((n) => ({
          assetDemandId: assetId(n),
          title: n === 9 ? "本周门店日常" : "服务细节",
          shootingNote: "记录真实门店与服务",
          dueDate: "2026-10-20",
          status: "open",
          isOverdue: false,
          createdByName: "交付经理",
          receivedCount: 1,
          myUploadCount: 0,
          createdAt: new Date(NOW).toISOString(),
        })),
        hasMore: !cursor,
        nextCursor: cursor ? null : "opaque:需求+1",
      };
    },
    async tags() {
      return [
        {
          code: "store",
          name: "门店环境",
          parentCode: null,
          description: null,
          tags: [],
          position: 1,
          isSelectable: true,
          ext: { dimension: "content" },
        },
      ];
    },
  };
  const deps: AssetTaskDeps = {
    owner,
    scope,
    records,
    api,
    files,
    fingerprint,
    key,
    now: () => NOW,
    forgetResume: (id) => createResumeStore(storage, () => NOW).remove(owner, id),
    job: (file) =>
      createUpload(
        {
          api: files,
          context: () => ({ token: scope(), storeId: owner.storeId, revision: 0 }),
          head: async (path) => bytes(path),
          now: () => NOW,
          sleep: async () => {},
          key,
          post: (ticket, local, progress) => {
            events.push({ action: "post", fileId: ticket.fileId });
            progress(25);
            let reject!: (reason: Error) => void;
            const done = new Promise<void>((resolve, fail) => {
              reject = fail;
              const finish = () => {
                pending.delete(finish);
                if (scene.endsWith("partial") && local.path === "local-2" && !partialFailed) {
                  partialFailed = true;
                  fail(new Error("第二份传输失败"));
                } else {
                  progress(100);
                  resolve();
                }
              };
              if (held) pending.add(finish);
              else finish();
            });
            return { done, abort: () => reject(new Error("原传输已停止")) };
          },
        },
        file,
        "store_asset",
      ),
  };
  const seed = async () => {
    const file = selected("image"),
      token = await fingerprint(file);
    const intent: UploadIntent = {
      version: 1,
      id: "cold-intent",
      owner,
      expiresAt: NOW + 86400000,
      createKey: "cold-create",
      type: "image",
      textBody: "",
      note: "",
      tags: [],
      demandId: null,
      files: [
        {
          name: file.name,
          size: file.size,
          width: 120,
          height: 90,
          durationMs: 0,
          token,
          fileId: scene.endsWith("recovery-blocked") ? assetId(100) : null,
          cancelKey: "cold-cancel",
          status: "pending",
        },
      ],
      phase: "uploading",
    };
    records.save(intent);
  };
  const control = {
    events,
    release: () => {
      held = false;
      [...pending].forEach((run) => run());
    },
    changeScope: () => useContextStore.setState((state) => ({ contextRev: state.contextRev + 1 })),
  };
  (globalThis as { __LYX_ASSET_UPLOAD_CONTROL__?: typeof control }).__LYX_ASSET_UPLOAD_CONTROL__ =
    control;
  const platform = (current: () => boolean) =>
    createAssetUploadPlatform({
      current,
      prepare: async (file) => file,
      choose: async (type) =>
        scene.endsWith("resume-mismatch")
          ? [{ ...selected(type), path: "wrong" }]
          : scene.endsWith("partial")
            ? [selected(type), selected(type, 2)]
            : [selected(type)],
      authorizeRecord: async () => {},
      record: () => {
        let resolve!: (file: SelectedFile) => void;
        return {
          done: new Promise<SelectedFile>((done) => {
            resolve = done;
          }),
          stop: () => resolve(selected("recording")),
        };
      },
      play: () => ({ stop: () => {} }),
    });
  if (
    scene.endsWith("resume-reselect") ||
    scene.endsWith("resume-mismatch") ||
    scene.endsWith("recovery-blocked")
  ) {
    if (!records.list(owner).length) await seed();
    if (scene.endsWith("recovery-blocked"))
      storage.set(StorageKey.uploadResume, [{ malformed: true }]);
  }
  return { api, platform, tasks: createAssetUploadTasks(deps) };
}
