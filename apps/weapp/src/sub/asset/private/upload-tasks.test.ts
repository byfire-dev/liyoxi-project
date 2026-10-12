import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { KeyValueStorage } from "@/lib/platform";
import { ApiError } from "@/lib/request";
import type { FileStatus, Registration } from "@/lib/upload/api";
import { clientToken } from "@/lib/upload/hash";
import { createMultipartPort } from "@/lib/upload/multipart";
import type { CloudRequest, CloudResponse } from "@/lib/upload/multipart";
import { createUpload } from "@/lib/upload/queue";
import type { SelectedFile, UploadDeps } from "@/lib/upload/queue";
import { createResumeStore } from "@/lib/upload/resume";
import type { ResumeManifest, ResumeOwner } from "@/lib/upload/resume";
import { StorageKey } from "@/lib/storage";
import type { AssetCreated } from "./upload-api";
import type { UploadForm, UploadIntent } from "./upload-model";
import { createAssetUploadRecords } from "./upload-records";
import { createAssetUploadTasks } from "./upload-tasks";
import type { AssetTaskDeps } from "./upload-tasks";

const NOW = Date.parse("2026-10-12T04:00:00Z"),
  ID = "00000000-0000-4000-8000-000000000001";
const OWNER: ResumeOwner = {
  userId: "user",
  memberId: "member",
  entityId: "entity",
  storeId: "store",
  role: "owner",
  storeScope: "all",
};
const file = (name = "a.png", size = 8): SelectedFile => ({ path: `wxfile://${name}`, name, size });
const form = (...files: SelectedFile[]): UploadForm => ({
  type: "image",
  files: files.length ? files : [file()],
  textBody: "",
  note: "原说明",
  tags: ["content"],
  demandId: "demand",
});
const status = (state: FileStatus["status"] = "stored", fileId = ID): FileStatus => ({
  fileId,
  category: "store_asset",
  status: state,
  rejectReason: null,
  declaredSizeBytes: "8",
  sizeBytes: "8",
  mime: "image/png",
  moderationState: "pass",
  storedAt: null,
  uploadExpiresAt: null,
  createdAt: new Date(NOW).toISOString(),
});
const card: AssetCreated = {
  storeAssetId: ID,
  type: "image",
  title: null,
  displayStatus: "organizing",
  processingState: "processing",
  reviewState: "unreviewed",
  usability: null,
  adoptedCount: 0,
  moderationState: "pass",
  fileCount: 1,
  durationMs: null,
  pageCount: null,
  thumbnail: null,
  quote: null,
  tags: [],
  techSpecLabel: null,
  structuredItemCount: null,
  isSelectableAsReference: false,
  uploader: { actorType: "merchant", role: "owner", displayName: null, isMe: true },
  createdAt: new Date(NOW).toISOString(),
  replayed: false,
};
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
async function until(check: () => boolean) {
  for (let n = 0; n < 240 && !check(); n++) await Promise.resolve();
  expect(check()).toBe(true);
}
const failure = () =>
  new ApiError({
    error: "STATE_NOT_ALLOWED",
    message: "not pending",
    status: 409,
    requestId: "test",
  });

function harness() {
  const values = new Map<string, unknown>(),
    gates = new Map<string, ReturnType<typeof deferred<void>>>();
  let owner = { ...OWNER },
    revision = 1,
    token = "session",
    sequence = 0,
    promotion = false;
  const scope = () => JSON.stringify([owner, revision, token]);
  const hook = async (name: string) => {
    const gate = gates.get(name);
    if (gate) await gate.promise;
  };
  const storage: KeyValueStorage = {
    get: <T>(key: string) => (values.has(key) ? (structuredClone(values.get(key)) as T) : null),
    set: vi.fn((key, value) => {
      values.set(key, structuredClone(value));
    }),
    remove: (key) => {
      values.delete(key);
    },
  };
  const records = createAssetUploadRecords(storage, () => NOW),
    resume = createResumeStore(storage, () => NOW);
  const grant: Registration = {
    fileId: ID,
    clientToken: "fingerprint",
    status: "pending",
    mode: "post",
    bucket: "incoming-1250000000",
    region: "ap-beijing",
    key: `incoming/${ID}/a.png`,
    post: {
      url: "https://storage.invalid",
      fields: { key: `incoming/${ID}/a.png`, policy: "fictional" },
    },
    sts: null,
    chunkSize: null,
    chunkParallel: null,
    expiresAt: new Date(NOW + 1800000).toISOString(),
    uploadExpiresAt: new Date(NOW + 86400000).toISOString(),
    credentialsLeft: 30,
  };
  const files = {
    register: vi.fn(async (body: Parameters<AssetTaskDeps["files"]["register"]>[0]) => {
      await hook("register");
      return { items: [{ ...grant, clientToken: body.files[0]!.clientToken }] };
    }),
    refresh: vi.fn(async () => grant),
    complete: vi.fn(async () => {
      await hook("complete");
      return status(promotion ? "promoting" : "stored");
    }),
    get: vi.fn(async () => {
      await hook("get");
      return status();
    }),
    cancel: vi.fn(async (_id: string, _key: string) => {
      await hook("cancel");
      return status("expired");
    }),
  };
  const abort = vi.fn(),
    post = vi.fn((_grant: Registration, _file: SelectedFile, progress: (value: number) => void) => {
      progress(100);
      return { done: hook("transport"), abort };
    });
  const bytes = (selected: SelectedFile) =>
    new Uint8Array(selected.size).fill(selected.name.charCodeAt(0));
  const upload: UploadDeps = {
    api: files,
    context: () => ({ token, storeId: owner.storeId, revision, scope: scope() }),
    head: vi.fn(async (path, length) => {
      await hook("head");
      return bytes(file(path.replace("wxfile://", ""), length));
    }),
    post,
    now: () => NOW,
    sleep: async () => {},
    key: (action) => `${action}:${++sequence}`,
  };
  const deps: AssetTaskDeps = {
    owner: { ...OWNER },
    scope,
    records,
    files,
    api: {
      create: vi.fn(async () => {
        await hook("create");
        return card;
      }),
    },
    fingerprint: vi.fn(async (selected) => {
      await hook("fingerprint");
      return clientToken(
        {
          ...selected,
          storeId: OWNER.storeId,
          category: "store_asset",
          width: selected.width ?? 0,
          height: selected.height ?? 0,
          durationMs: selected.durationMs ?? 0,
        },
        bytes(selected).subarray(0, 256 * 1024),
      );
    }),
    job: vi.fn((selected) => createUpload(upload, selected, "store_asset")),
    forgetResume: vi.fn((id) => resume.remove(OWNER, id)),
    key: (action) => `${action}:${++sequence}`,
    now: () => NOW,
  };
  const tasks = createAssetUploadTasks(deps);
  const saved = async (selected = file()): Promise<UploadIntent> => ({
    version: 1,
    id: "cold",
    owner: { ...OWNER },
    expiresAt: NOW + 86400000,
    createKey: "asset_create:cold",
    type: "image",
    textBody: "",
    note: "原说明",
    tags: ["content"],
    demandId: "demand",
    phase: "uploading",
    files: [
      {
        name: selected.name,
        size: selected.size,
        width: 0,
        height: 0,
        durationMs: 0,
        token: await deps.fingerprint(selected),
        fileId: null,
        cancelKey: "file_cancel:cold",
        status: "pending",
      },
    ],
  });
  return {
    deps,
    tasks,
    files,
    grant,
    upload,
    storage,
    values,
    records,
    resume,
    saved,
    abort,
    post,
    hold(name: string) {
      const gate = deferred<void>();
      gates.set(name, gate);
      return gate;
    },
    promote() {
      promotion = true;
    },
    change(key = "storeId") {
      if (key === "accessToken") token = "other-token";
      else if (key === "ctxRev") revision++;
      else owner = { ...owner, [key]: `${owner[key as keyof ResumeOwner]}-other` };
    },
    cold() {
      tasks.dispose();
      return createAssetUploadTasks(deps);
    },
  };
}

describe("素材任务真实队列与业务提交边界", () => {
  it("传输100%与promoting均不创建；stored后原body/key提交并保留整理中卡片", async () => {
    const h = harness(),
      transport = h.hold("transport"),
      stored = h.hold("get");
    h.promote();
    const input = form(),
      id = await h.tasks.enqueue(input);
    input.note = "后改";
    input.tags.push("later");
    await until(() => h.post.mock.calls.length === 1);
    expect(h.tasks.snapshot().tasks[0]!.files[0]).toMatchObject({
      progress: 100,
      status: "uploading",
    });
    expect(h.deps.api.create).not.toHaveBeenCalled();
    transport.resolve();
    await until(() => h.files.get.mock.calls.length === 1);
    expect(h.tasks.snapshot().tasks[0]!.files[0]!.status).toBe("storing");
    expect(h.deps.api.create).not.toHaveBeenCalled();
    stored.resolve();
    await until(() => h.tasks.snapshot().tasks[0]?.phase === "succeeded");
    expect(h.deps.api.create).toHaveBeenCalledExactlyOnceWith(
      {
        type: "image",
        fileIds: [ID],
        note: "原说明",
        contentTagCodes: ["content"],
        assetDemandId: "demand",
      },
      h.tasks.snapshot().tasks[0]!.intent.createKey,
    );
    expect(h.tasks.snapshot().tasks[0]!.result).toEqual(card);
    expect(h.records.list(OWNER)).toEqual([]);
    h.tasks.forget(id!);
    expect(h.tasks.snapshot().tasks).toEqual([]);
  });
  it("部分成功保留stored，重试只上传失败文件；同文件不能在待办中重复登记", async () => {
    const h = harness();
    vi.mocked(h.files.register).mockImplementation(async (body) => ({
      items: [
        {
          ...h.grant,
          fileId: body.files[0]!.fileName === "a.png" ? ID : "file-b",
          clientToken: body.files[0]!.clientToken,
        },
      ],
    }));
    h.files.complete
      .mockResolvedValueOnce(status())
      .mockRejectedValueOnce(new Error("second failed"))
      .mockResolvedValueOnce(status("stored", "file-b"));
    const id = await h.tasks.enqueue(form(file(), file("b.png")));
    await until(() => h.tasks.snapshot().tasks[0]?.phase === "failed");
    expect(h.tasks.snapshot().tasks[0]!.intent.files.map((item) => item.status)).toEqual([
      "stored",
      "pending",
    ]);
    expect(h.deps.api.create).not.toHaveBeenCalled();
    expect(await h.tasks.enqueue(form())).toBeNull();
    h.tasks.clearError();
    await h.tasks.retry(id!);
    expect(h.files.get).toHaveBeenCalledWith(ID);
    expect(h.post).toHaveBeenCalledTimes(2);
    expect(h.deps.api.create).toHaveBeenCalledTimes(1);
    expect(h.tasks.snapshot().tasks[0]!.intent.files.map((item) => item.fileId)).toEqual([
      ID,
      "file-b",
    ]);
  });
  it("create回执未知保留body、fileIds、createKey，取消不误报成功，重试不重传", async () => {
    const h = harness();
    vi.mocked(h.deps.api.create).mockRejectedValueOnce(new Error("receipt lost"));
    const id = await h.tasks.enqueue(form());
    await until(() => h.tasks.snapshot().tasks[0]?.phase === "create_unknown");
    const first = vi.mocked(h.deps.api.create).mock.calls[0]!;
    await h.tasks.cancel(id!);
    expect(h.files.cancel).not.toHaveBeenCalled();
    expect(h.records.list(OWNER)[0]!.phase).toBe("create_unknown");
    await h.tasks.retry(id!);
    expect(vi.mocked(h.deps.api.create).mock.calls[1]).toEqual(first);
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.files.register).toHaveBeenCalledTimes(1);
    expect(h.tasks.snapshot().tasks[0]!.phase).toBe("succeeded");
  });
  it.each([
    "userId",
    "memberId",
    "entityId",
    "storeId",
    "role",
    "storeScope",
    "ctxRev",
    "accessToken",
  ])("%s改变立即隐藏旧任务、停止传输；返回原owner需要冷重选", async (key) => {
    const h = harness(),
      gate = h.hold("transport");
    await h.tasks.enqueue(form());
    await until(() => h.post.mock.calls.length === 1);
    h.change(key);
    expect(h.tasks.snapshot().tasks).toEqual([]);
    expect(h.abort).toHaveBeenCalledTimes(1);
    gate.resolve();
    await Promise.resolve();
    expect(h.deps.api.create).not.toHaveBeenCalled();
    expect(await h.tasks.enqueue(form())).toBeNull();
    const cold = createAssetUploadTasks({
      ...h.deps,
      scope: () => "original-owner-new-generation",
    });
    expect(cold.snapshot().tasks[0]!.phase).toBe("needs_reselect");
    expect(h.post).toHaveBeenCalledTimes(1);
    cold.dispose();
  });
  it.each(["fingerprint", "head", "register", "transport", "complete", "get", "create"])(
    "%s的await之后不能把旧结果写回新scope",
    async (boundary) => {
      const h = harness(),
        gate = h.hold(boundary);
      if (boundary === "get") h.promote();
      const pending = h.tasks.enqueue(form());
      if (boundary === "fingerprint")
        await until(() => vi.mocked(h.deps.fingerprint).mock.calls.length === 1);
      else
        await until(() =>
          boundary === "head"
            ? vi.mocked(h.upload.head).mock.calls.length > 0
            : boundary === "transport"
              ? h.post.mock.calls.length > 0
              : boundary === "create"
                ? vi.mocked(h.deps.api.create).mock.calls.length > 0
                : h.files[boundary as "get" | "register" | "complete"].mock.calls.length > 0,
        );
      h.change("ctxRev");
      gate.resolve();
      await pending;
      await Promise.resolve();
      expect(h.tasks.snapshot().tasks).toEqual([]);
      expect(h.records.list(OWNER).every((entry) => entry.phase !== "create_unknown")).toBe(true);
      if (boundary !== "create") expect(h.deps.api.create).not.toHaveBeenCalled();
      else expect(h.deps.api.create).toHaveBeenCalledTimes(1);
    },
  );
  it("fingerprint等待中双击单飞；unsubscribe不dispose持有任务", async () => {
    const h = harness(),
      gate = h.hold("fingerprint"),
      notify = vi.fn(),
      unsubscribe = h.tasks.subscribe(notify);
    const pending = h.tasks.enqueue(form());
    expect(await h.tasks.enqueue(form())).toBeNull();
    unsubscribe();
    gate.resolve();
    await pending;
    await until(() => h.tasks.snapshot().tasks[0]?.phase === "succeeded");
    expect(h.deps.fingerprint).toHaveBeenCalledTimes(1);
    expect(h.deps.job).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });
  it("文字直接创建，存储写读失败或坏意图表零job/零create", async () => {
    const h = harness();
    await h.tasks.enqueue({ ...form(), type: "text", files: [], textBody: "文字", note: "" });
    await until(() => h.tasks.snapshot().tasks[0]?.phase === "succeeded");
    expect(h.files.register).not.toHaveBeenCalled();
    expect(h.deps.job).not.toHaveBeenCalled();
    const broken = harness();
    vi.mocked(broken.storage.set).mockImplementation(() => {});
    expect(await broken.tasks.enqueue(form())).toBeNull();
    expect(broken.deps.job).not.toHaveBeenCalled();
    expect(broken.deps.api.create).not.toHaveBeenCalled();
    const corrupt = harness();
    corrupt.values.set(StorageKey.assetUploadIntents, [{ invalid: true }]);
    const cold = corrupt.cold();
    expect(cold.snapshot().error).toMatch(/损坏/u);
    expect(await cold.enqueue(form())).toBeNull();
    expect(corrupt.files.register).not.toHaveBeenCalled();
    cold.dispose();
  });
  it("冷启动不凭旧路径上传；错指纹拒绝，正确重选走原队列", async () => {
    const h = harness(),
      record = await h.saved();
    h.records.save(record);
    const cold = h.cold();
    expect(cold.snapshot().tasks[0]!.phase).toBe("needs_reselect");
    expect(h.deps.job).not.toHaveBeenCalled();
    await cold.reselect("cold", 0, file("different.png"));
    expect(h.deps.job).not.toHaveBeenCalled();
    expect(cold.snapshot().tasks[0]!.message).toMatch(/不一致/u);
    await cold.reselect("cold", 0, file());
    expect(cold.snapshot().tasks[0]!.phase).toBe("succeeded");
    expect(h.deps.job).toHaveBeenCalledTimes(1);
    cold.dispose();
  });
  it.each(["promoting", "block"])("冷stored引用变成%s不创建", async (remote) => {
    const h = harness(),
      record = await h.saved();
    record.files[0]!.status = "stored";
    record.files[0]!.fileId = ID;
    h.records.save(record);
    h.files.get.mockResolvedValue({
      ...status(remote === "promoting" ? "promoting" : "stored"),
      moderationState: remote === "block" ? "block" : "pass",
    });
    const cold = h.cold();
    await cold.retry("cold");
    expect(h.deps.api.create).not.toHaveBeenCalled();
    expect(cold.snapshot().tasks[0]!.phase).toBe("failed");
    cold.dispose();
  });
  it("过期待办不能恢复上传但保留可信fileId供取消", async () => {
    const h = harness(),
      record = await h.saved();
    record.expiresAt = NOW + 1;
    record.files[0]!.fileId = ID;
    h.records.save(record);
    const cold = createAssetUploadTasks({ ...h.deps, now: () => NOW + 2 });
    await cold.retry("cold");
    expect(h.deps.job).not.toHaveBeenCalled();
    expect(h.deps.api.create).not.toHaveBeenCalled();
    await cold.cancel("cold");
    expect(h.files.cancel).toHaveBeenCalledWith(ID, "file_cancel:cold");
    cold.dispose();
  });
});

describe("取消是独立稳定意图", () => {
  it("停止传输后等在途结束才cancel；失败保留fileId/key，不开放重选", async () => {
    const h = harness(),
      transport = h.hold("transport");
    const id = await h.tasks.enqueue(form());
    await until(() => h.post.mock.calls.length === 1);
    h.files.cancel.mockRejectedValueOnce(new Error("cancel receipt lost"));
    const pending = h.tasks.cancel(id!);
    expect(h.abort).toHaveBeenCalledTimes(1);
    expect(h.files.cancel).not.toHaveBeenCalled();
    transport.resolve();
    await pending;
    expect(h.tasks.snapshot().tasks[0]!.phase).toBe("cancel_failed");
    const original = h.files.cancel.mock.calls[0]!;
    await h.tasks.reselect(id!, 0, file());
    expect(h.deps.job).toHaveBeenCalledTimes(1);
    expect(h.deps.forgetResume).not.toHaveBeenCalled();
    await h.tasks.cancel(id!);
    expect(h.files.cancel.mock.calls[1]).toEqual(original);
    expect(h.tasks.snapshot().tasks[0]!.phase).toBe("cancelled");
    expect(h.deps.api.create).not.toHaveBeenCalled();
    expect(h.deps.forgetResume).toHaveBeenCalledExactlyOnceWith(ID);
  });
  it("登记回执未知无fileId时，以原token/原登记体取回后取消，绝不启动新job", async () => {
    const h = harness();
    h.files.register.mockRejectedValueOnce(new Error("register lost"));
    const id = await h.tasks.enqueue(form());
    await until(() => h.tasks.snapshot().tasks[0]?.phase === "failed");
    const original = h.files.register.mock.calls[0]!;
    await h.tasks.cancel(id!);
    expect(h.files.register.mock.calls[1]).toEqual(original);
    expect(h.files.cancel).toHaveBeenCalledTimes(1);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.deps.job).toHaveBeenCalledTimes(1);
    expect(h.tasks.snapshot().tasks[0]!.phase).toBe("cancelled");
  });
  it.each(["promoting", "stored", "expired"] as const)(
    "STATE_NOT_ALLOWED回查%s，只expired确认为取消",
    async (remote) => {
      const h = harness(),
        record = await h.saved();
      record.files[0]!.fileId = ID;
      h.records.save(record);
      h.files.cancel.mockRejectedValueOnce(failure());
      h.files.get.mockResolvedValue(status(remote));
      const cold = h.cold();
      await cold.cancel("cold");
      expect(cold.snapshot().tasks[0]!.phase).toBe(
        remote === "promoting" ? "cancel_failed" : "cancelled",
      );
      expect(h.deps.forgetResume).toHaveBeenCalledTimes(remote === "expired" ? 1 : 0);
      expect(h.deps.api.create).not.toHaveBeenCalled();
      if (remote === "stored") expect(cold.snapshot().tasks[0]!.message).toMatch(/1份已入库/u);
      cold.dispose();
    },
  );
  it("坏公共journal不能通过取消清整表；保持recovery_blocked并禁止重新上传", async () => {
    const h = harness(),
      record = await h.saved();
    record.files[0]!.fileId = ID;
    h.records.save(record);
    h.values.set(StorageKey.uploadResume, [{ malformed: true }]);
    const cold = h.cold();
    await cold.cancel("cold");
    expect(h.files.cancel).toHaveBeenCalledWith(ID, record.files[0]!.cancelKey);
    expect(cold.snapshot().tasks[0]!.phase).toBe("recovery_blocked");
    expect(h.values.get(StorageKey.uploadResume)).toEqual([{ malformed: true }]);
    await cold.cancel("cold");
    expect(cold.snapshot().tasks[0]!.phase).toBe("recovery_blocked");
    expect(h.values.get(StorageKey.uploadResume)).toEqual([{ malformed: true }]);
    expect(h.records.list(OWNER)).toHaveLength(1);
    expect(h.deps.forgetResume).toHaveBeenCalledTimes(2);
    expect(h.files.cancel).toHaveBeenCalledTimes(1);
    await cold.reselect("cold", 0, file());
    await cold.retry("cold");
    expect(h.deps.job).not.toHaveBeenCalled();
    expect(h.deps.api.create).not.toHaveBeenCalled();
    cold.dispose();
  });
  it.each(["register", "cancel"] as const)(
    "取消%s await期间换账号，迟到成功不清原记录",
    async (boundary) => {
      const h = harness(),
        record = await h.saved();
      record.files[0]!.fileId = boundary === "cancel" ? ID : null;
      h.records.save(record);
      const gate = h.hold(boundary),
        cold = h.cold(),
        work = cold.cancel("cold");
      await until(() => h.files[boundary].mock.calls.length === 1);
      h.change("userId");
      gate.resolve();
      await work;
      expect(cold.snapshot().tasks).toEqual([]);
      expect(h.records.list(OWNER)).toHaveLength(1);
      expect(h.deps.forgetResume).not.toHaveBeenCalled();
      if (boundary === "register") expect(h.files.cancel).not.toHaveBeenCalled();
      cold.dispose();
    },
  );
  it("重选的指纹迟到，不能在确认取消后创建新job", async () => {
    const h = harness(),
      record = await h.saved();
    record.files[0]!.fileId = ID;
    h.records.save(record);
    const cold = h.cold(),
      gate = h.hold("fingerprint");
    const pending = cold.reselect("cold", 0, file());
    await until(() => vi.mocked(h.deps.fingerprint).mock.calls.length === 2);
    await cold.cancel("cold");
    gate.resolve();
    await pending;
    expect(cold.snapshot().tasks[0]!.phase).toBe("cancelled");
    expect(h.deps.job).not.toHaveBeenCalled();
    expect(h.deps.api.create).not.toHaveBeenCalled();
    cold.dispose();
  });
});

function cloudHarness() {
  const h = harness(),
    data = new Uint8Array(262145).fill(7),
    chunk = 131072;
  Object.assign(h.grant, {
    mode: "multipart",
    post: null,
    chunkSize: chunk,
    chunkParallel: 4,
    sts: {
      tmpSecretId: "fictional-ak",
      tmpSecretKey: "fictional-key",
      sessionToken: "fictional-token",
      startTime: new Date(NOW - 60000).toISOString(),
      expiredTime: h.grant.expiresAt,
    },
  });
  const selected = file("a.png", data.length),
    calls: CloudRequest[] = [],
    parts = new Map<number, string>();
  const pending: { part: number; tag: string; resolve: (value: CloudResponse) => void }[] = [];
  const reply = (xml: string, headers: Record<string, string> = {}): CloudResponse => ({
    statusCode: 200,
    data: xml,
    headers,
  });
  const send = vi.fn((request: CloudRequest) => {
    calls.push(request);
    const url = new URL(request.url);
    let done: Promise<CloudResponse>;
    if (request.method === "PUT") {
      expect(request.data).toBeInstanceOf(ArrayBuffer);
      const bytes = new Uint8Array(request.data as ArrayBuffer),
        part = Number(url.searchParams.get("partNumber"));
      expect(bytes).toEqual(data.subarray((part - 1) * chunk, Math.min(part * chunk, data.length)));
      const tag = createHash("md5").update(bytes).digest("hex");
      expect(request.headers["content-md5"]).toBe(Buffer.from(tag, "hex").toString("base64"));
      const gate = deferred<CloudResponse>();
      pending.push({ part, tag, resolve: gate.resolve });
      done = gate.promise;
    } else if (request.method === "GET") {
      const rows = [...parts]
        .sort(([a], [b]) => a - b)
        .map(
          ([part, tag]) =>
            `<Part><PartNumber>${part}</PartNumber><Size>${Math.min(chunk, data.length - (part - 1) * chunk)}</Size><ETag>"${tag}"</ETag></Part>`,
        )
        .join("");
      done = Promise.resolve(
        reply(
          `<ListPartsResult><Bucket>${h.grant.bucket}</Bucket><Key>${h.grant.key}</Key><UploadId>upload-1</UploadId><PartNumberMarker>0</PartNumberMarker><NextPartNumberMarker>0</NextPartNumberMarker><MaxParts>100</MaxParts><IsTruncated>false</IsTruncated>${rows}</ListPartsResult>`,
        ),
      );
    } else
      done = Promise.resolve(
        reply(
          url.searchParams.has("uploads")
            ? `<InitiateMultipartUploadResult><Bucket>${h.grant.bucket}</Bucket><Key>${h.grant.key}</Key><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>`
            : `<CompleteMultipartUploadResult><Bucket>${h.grant.bucket}</Bucket><Key>${h.grant.key}</Key><ETag>"${"a".repeat(32)}-3"</ETag></CompleteMultipartUploadResult>`,
        ),
      );
    return { done, abort: vi.fn() };
  });
  const read = vi.fn(async (_path: string, offset: number, length: number) =>
    data.slice(offset, offset + length),
  );
  const port = createMultipartPort({
    owner: () => OWNER,
    resume: h.resume,
    read,
    send,
    refresh: h.files.refresh,
    now: () => NOW,
  });
  h.upload.multipart = port;
  h.upload.head = async (_path, length) => data.slice(0, length);
  h.deps.fingerprint = async (value) =>
    clientToken(
      {
        ...value,
        storeId: OWNER.storeId,
        category: "store_asset",
        width: 0,
        height: 0,
        durationMs: 0,
      },
      data.subarray(0, 256 * 1024),
    );
  h.deps.forgetResume = vi.fn((id) => port.forget(id));
  const acknowledge = (index: number) => {
    const item = pending[index]!;
    parts.set(item.part, item.tag);
    item.resolve(reply("", { ETag: `"${item.tag}"` }));
  };
  return { ...h, data, chunk, selected, send, calls, pending, read, acknowledge, port };
}

describe("controller → createUpload → createMultipartPort真实协议链", () => {
  it("真XML/ListParts/独立MD5、最多两片、远端确认进度；云合并仍等服务端stored", async () => {
    const h = cloudHarness(),
      stored = h.hold("get");
    h.promote();
    await h.tasks.enqueue(form(h.selected));
    await until(() => h.pending.length === 2);
    for (let n = 0; n < 12; n++) await Promise.resolve();
    expect(h.pending.map((item) => item.part)).toEqual([1, 2]);
    expect(h.tasks.snapshot().tasks[0]!.files[0]!.progress).toBe(0);
    expect(h.deps.api.create).not.toHaveBeenCalled();
    h.acknowledge(0);
    await until(() => h.pending.length === 3);
    expect(h.tasks.snapshot().tasks[0]!.files[0]!.progress).toBeGreaterThan(0);
    h.acknowledge(1);
    h.acknowledge(2);
    await until(() => h.files.get.mock.calls.length === 1);
    expect(h.tasks.snapshot().tasks[0]!.files[0]).toMatchObject({
      progress: 100,
      status: "storing",
    });
    expect(h.deps.api.create).not.toHaveBeenCalled();
    stored.resolve();
    await until(() => h.tasks.snapshot().tasks[0]?.phase === "succeeded");
    expect(h.calls.map((request) => request.method)).toEqual([
      "POST",
      "GET",
      "PUT",
      "PUT",
      "PUT",
      "GET",
      "POST",
    ]);
    expect(h.calls.at(-1)!.data).toContain("<CompleteMultipartUpload>");
    expect(h.read.mock.calls).toContainEqual([h.selected.path, 262144, 1]);
    expect(h.files.complete).toHaveBeenCalledTimes(1);
    expect(h.deps.api.create).toHaveBeenCalledTimes(1);
    expect(h.post).not.toHaveBeenCalled();
    expect(h.values.get(StorageKey.uploadResume)).toEqual([]);
    expect(h.records.list(OWNER)).toEqual([]);
    expect(JSON.stringify(h.tasks.snapshot())).not.toMatch(/fictional-key|sessionToken|wxfile/u);
  });
  it.each(["initiating", "corrupt", "suffix", "completing"])(
    "冷恢复%s禁止盲Init或创建，保留原fileId",
    async (mode) => {
      const h = cloudHarness(),
        record = await h.saved(h.selected),
        token = record.files[0]!.token;
      record.files[0]!.fileId = ID;
      h.records.save(record);
      const manifest: ResumeManifest = {
        version: 1,
        owner: OWNER,
        token,
        fileId: ID,
        bucket: h.grant.bucket,
        region: h.grant.region,
        key: h.grant.key,
        size: h.data.length,
        chunkSize: h.chunk,
        digests: [0, 1, 2].map((n) =>
          createHash("md5")
            .update(h.data.subarray(n * h.chunk, Math.min((n + 1) * h.chunk, h.data.length)))
            .digest("hex"),
        ),
        uploadId: mode === "initiating" ? null : "upload-1",
        phase:
          mode === "initiating" ? "initiating" : mode === "completing" ? "completing" : "uploading",
        confirmKey: "file_complete:original",
        expiresAt: NOW + 86400000,
      };
      h.resume.save(manifest);
      if (mode === "corrupt") h.values.set(StorageKey.uploadResume, [{ bad: true }]);
      if (mode === "suffix") h.data[h.data.length - 1] = 9;
      if (mode === "completing") {
        h.send.mockImplementation((request) => {
          h.calls.push(request);
          expect(request.method).toBe("GET");
          return {
            done: Promise.resolve({
              statusCode: 404,
              headers: {},
              data: "<Error><Code>NoSuchUpload</Code></Error>",
            }),
            abort: vi.fn(),
          };
        });
        h.files.complete.mockRejectedValue(
          new ApiError({
            error: "UPLOAD_NOT_FOUND",
            message: "unconfirmed",
            status: 409,
            requestId: "test",
          }),
        );
      }
      h.files.get.mockResolvedValue(status("pending"));
      const cold = h.cold();
      expect(h.send).not.toHaveBeenCalled();
      await cold.reselect("cold", 0, h.selected);
      expect(h.deps.api.create).not.toHaveBeenCalled();
      expect(cold.snapshot().tasks[0]!.intent.files[0]!.fileId).toBe(ID);
      await cold.retry("cold");
      expect(h.send).toHaveBeenCalledTimes(mode === "completing" ? 1 : 0);
      expect(h.calls.filter((request) => new URL(request.url).searchParams.has("uploads"))).toEqual(
        [],
      );
      expect(h.files.complete).toHaveBeenCalledTimes(mode === "completing" ? 2 : 0);
      expect(h.deps.api.create).not.toHaveBeenCalled();
      cold.dispose();
    },
  );
});
