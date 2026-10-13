import { describe, expect, it, vi } from "vitest";
import { ApiError, type RequestLayer } from "@/lib/request";
import type { FileStatus, UploadApi } from "@/lib/upload/api";
import type { SelectedFile, UploadJob, UploadState } from "@/lib/upload/queue";
import { assetDetail, assetId } from "../../../../shots/asset-fixtures";
import type { AssetDetail } from "./api";
import { createAssetDetailActions } from "./detail-actions";
import { createAssetDetailApi, type AssetDetailApi } from "./detail-api";
import type { PortraitPorts } from "./portrait-platform";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const error = (symbol: string, status: number) =>
  new ApiError({ error: symbol, status, message: "private URL", requestId: "test" });
const result = (id = assetId(101), patch: Partial<FileStatus> = {}): FileStatus => ({
  fileId: id,
  category: "portrait_auth",
  status: "stored",
  rejectReason: null,
  declaredSizeBytes: "32",
  sizeBytes: "32",
  mime: "image/jpeg",
  moderationState: "pass",
  storedAt: null,
  uploadExpiresAt: null,
  createdAt: "2026-10-13T02:00:00.000Z",
  ...patch,
});
function job(id: string, run?: () => Promise<FileStatus | null>) {
  let state: UploadState = {
    status: "queued",
    progress: 0,
    fileId: null,
    message: null,
    canDelegate: false,
  };
  const listeners = new Set<() => void>();
  const change = (patch: Partial<UploadState>) => {
    state = { ...state, ...patch };
    listeners.forEach((call) => call());
  };
  const start = vi.fn(async () => {
    change({ status: "uploading", fileId: id });
    const value = await (run?.() ?? Promise.resolve(result(id)));
    change({ status: value ? "stored" : "failed", progress: value ? 100 : 0 });
    return value;
  });
  const value: UploadJob = {
    snapshot: () => state,
    subscribe: (call) => {
      listeners.add(call);
      return () => {
        listeners.delete(call);
      };
    },
    start,
    retry: vi.fn(() => start()),
    pause: () => change({ status: "paused" }),
    dispose: () => change({ status: "cancelled" }),
    cancel: async () => change({ status: "cancelled" }),
  };
  return { value, start, change };
}
const selected: SelectedFile[] = [1, 2].map((n) => ({
  path: `/tmp/portrait${n}.jpg`,
  name: `portrait${n}.jpg`,
  size: 32,
}));
function setup() {
  let scope: string | null = "token/member/entity/owner/store/rev1";
  let detail: AssetDetail = {
    ...assetDetail(),
    usability: "need_portrait_auth",
    actions: ["feedback", "portrait-auth"],
    portraitAuth: { fileCount: 0, authorizedAt: null },
  };
  let sequence = 0;
  const jobs = [job(assetId(101)), job(assetId(102))];
  const api = {
    feedback: vi.fn<AssetDetailApi["feedback"]>().mockResolvedValue(null),
    portrait: vi
      .fn<AssetDetailApi["portrait"]>()
      .mockImplementation(async () => ({ ...detail, replayed: false })),
  };
  const files: UploadApi = {
    register: vi.fn<UploadApi["register"]>().mockResolvedValue({ items: [] }),
    complete: vi.fn<UploadApi["complete"]>().mockResolvedValue(result()),
    get: vi.fn<UploadApi["get"]>().mockResolvedValue(result()),
    cancel: vi
      .fn<UploadApi["cancel"]>()
      .mockImplementation(async (id) => result(id, { status: "expired" })),
    refresh: vi.fn<UploadApi["refresh"]>(),
  };
  const ports: PortraitPorts = {
    choose: vi.fn(async () => selected),
    fingerprint: async (file) => file.name,
    job: (file) => jobs[selected.findIndex((value) => value.name === file.name)]!.value,
    files,
    forget: vi.fn(),
  };
  const refresh = vi.fn(async () => {
    detail = { ...detail, portraitAuth: { fileCount: 2, authorizedAt: null } };
  });
  const model = createAssetDetailActions({
    id: assetId(),
    scope: () => scope,
    detail: () => detail,
    api,
    key: (action) => `${action}:${++sequence}`,
    ports: async () => ports,
    refresh,
  });
  return {
    model,
    api,
    jobs,
    files,
    ports,
    refresh,
    setScope: (value: string | null) => {
      scope = value;
    },
    setActions: (actions: AssetDetail["actions"]) => {
      detail = { ...detail, actions };
    },
    detail: () => detail,
  };
}
const flush = async () => {
  for (let n = 0; n < 12; n++) await Promise.resolve();
};

describe("素材详情写侧的六个关键边界", () => {
  it("两个真实POST保持路径编码、typed body和同意图幂等键", async () => {
    const calls: { path: string; options?: Parameters<RequestLayer["request"]>[1] }[] = [];
    const send: RequestLayer["request"] = async <T>(
      path: string,
      options?: Parameters<RequestLayer["request"]>[1],
    ): Promise<T> => {
      calls.push({ path, options });
      return (path.endsWith("/feedback") ? null : { ...assetDetail(), replayed: true }) as T;
    };
    const api = createAssetDetailApi(send),
      body = { content: "用途标签有误", dimension: "usage" as const };
    expect(await api.feedback("a/b", body, "feedback:1")).toBeNull();
    expect(await api.portrait("a/b", { fileIds: [assetId(101)] }, "portrait:1")).toHaveProperty(
      "replayed",
      true,
    );
    expect(calls).toEqual([
      {
        path: "/m/store-assets/a%2Fb/feedback",
        options: { method: "POST", data: body, idempotencyKey: "feedback:1" },
      },
      {
        path: "/m/store-assets/a%2Fb/portrait-auth",
        options: {
          method: "POST",
          data: { fileIds: [assetId(101)] },
          idempotencyKey: "portrait:1",
        },
      },
    ]);
  });

  it("反馈消费actions、1–200字、同步双击和未知回执同键同体；每日上限保留输入", async () => {
    const h = setup();
    h.setActions([]);
    h.model.openFeedback();
    h.model.editFeedback("不可提交");
    await h.model.feedback();
    expect(h.api.feedback).not.toHaveBeenCalled();
    h.setActions(["feedback"]);
    h.model.openFeedback();
    h.model.editFeedback(" ");
    await h.model.feedback();
    h.model.editFeedback("中".repeat(201));
    await h.model.feedback();
    expect(h.api.feedback).not.toHaveBeenCalled();
    const late = deferred<null>();
    h.api.feedback.mockReturnValueOnce(late.promise);
    h.model.editFeedback("中".repeat(200), "usage");
    const first = h.model.feedback();
    await h.model.feedback();
    expect(h.api.feedback).toHaveBeenCalledTimes(1);
    late.reject(error("NETWORK_ERROR", 0));
    await first;
    h.model.editFeedback("不能改写未知意图");
    expect(h.model.snapshot().content).toHaveLength(200);
    await h.model.feedback();
    expect(h.api.feedback.mock.calls[1]).toEqual(h.api.feedback.mock.calls[0]);
    expect(h.model.snapshot()).toMatchObject({
      feedbackPending: false,
      feedbackBusy: false,
      content: "",
    });
    h.model.editFeedback("下一条反馈");
    h.api.feedback.mockRejectedValueOnce(error("ASSET_FEEDBACK_DAILY_LIMIT", 409));
    await h.model.feedback();
    expect(h.model.snapshot()).toMatchObject({ content: "下一条反馈", feedbackPending: false });
    expect(h.model.snapshot().feedbackMessage).toContain("已满5次");
  });

  it("授权仅真实stored/portrait_auth/未block可交，部分失败保留已入库文件并重试原job", async () => {
    const h = setup();
    let attempts = 0;
    h.jobs[1] = job(assetId(102), async () => (++attempts === 1 ? null : result(assetId(102))));
    await h.model.choose("image");
    await h.model.portrait();
    expect(h.api.portrait).not.toHaveBeenCalled();
    expect(h.model.snapshot().files.map((file) => file.status)).toEqual(["stored", "failed"]);
    await h.model.upload();
    await h.model.portrait();
    expect(h.jobs[0]!.start).toHaveBeenCalledTimes(1);
    expect(h.jobs[1]!.start).toHaveBeenCalledTimes(2);
    expect(h.api.portrait.mock.calls[0]?.[1]).toEqual({ fileIds: [assetId(101), assetId(102)] });
    for (const patch of [
      { status: "promoting" },
      { category: "store_asset" },
      { moderationState: "block" },
    ]) {
      const bad = setup();
      bad.jobs[0] = job(assetId(101), async () => result(assetId(101), patch));
      await bad.model.choose("image");
      await bad.model.portrait();
      expect(bad.api.portrait).not.toHaveBeenCalled();
    }
  });

  it("授权未知回执保持fileIds/key且actions消失禁交；重放/刷新失败都保留已补交确认", async () => {
    const h = setup();
    await h.model.choose("pdf");
    h.api.portrait.mockRejectedValueOnce(error("NETWORK_ERROR", 0));
    await h.model.portrait();
    expect(h.model.snapshot().portraitPending).toBe(true);
    await h.model.choose("image");
    expect(h.ports.choose).toHaveBeenCalledTimes(1);
    h.setActions(["feedback"]);
    await h.model.portrait();
    expect(h.api.portrait).toHaveBeenCalledTimes(1);
    h.setActions(["feedback", "portrait-auth"]);
    h.api.portrait.mockResolvedValueOnce({ ...assetDetail(), replayed: true });
    h.refresh.mockRejectedValueOnce(new Error("signed URL private"));
    await h.model.portrait();
    expect(h.api.portrait.mock.calls[1]).toEqual(h.api.portrait.mock.calls[0]);
    expect(h.refresh).toHaveBeenCalledOnce();
    expect(h.model.snapshot()).toMatchObject({
      portraitPending: false,
      portraitBusy: false,
      files: [],
    });
    expect(h.model.snapshot().portraitMessage).toContain("已补交");
    expect(h.model.snapshot().portraitMessage).toContain("刷新失败");
    expect(h.model.snapshot().portraitMessage).not.toContain("private");
    expect(h.detail().portraitAuth.authorizedAt).toBeNull();
  });

  it("取消未知不丢原fileId/cancelKey、不放行新材料，确认expired或stored才清除", async () => {
    const h = setup();
    h.jobs[1] = job(assetId(102), async () => null);
    await h.model.choose("image");
    vi.mocked(h.files.cancel).mockRejectedValueOnce(error("NETWORK_ERROR", 0));
    await h.model.cancel();
    expect(h.model.snapshot().cancelPending).toBe(true);
    expect(h.model.snapshot().files).toHaveLength(2);
    await h.model.choose("pdf");
    expect(h.ports.choose).toHaveBeenCalledTimes(1);
    await h.model.cancel();
    expect(h.files.cancel).toHaveBeenCalledTimes(2);
    expect(vi.mocked(h.files.cancel).mock.calls[1]).toEqual(
      vi.mocked(h.files.cancel).mock.calls[0],
    );
    expect(h.files.cancel).toHaveBeenCalledWith(assetId(102), expect.any(String));
    expect(h.model.snapshot()).toMatchObject({
      files: [],
      cancelPending: false,
      portraitBusy: false,
    });
    const stored = setup();
    stored.jobs[1] = job(assetId(102), async () => null);
    await stored.model.choose("image");
    vi.mocked(stored.files.cancel).mockRejectedValueOnce(error("STATE_NOT_ALLOWED", 409));
    await stored.model.cancel();
    expect(stored.files.get).toHaveBeenCalledWith(assetId(102));
    expect(stored.model.snapshot().cancelPending).toBe(false);
  });

  it("作用域/隐藏/卸载丢弃晚成功错误；回前台原paused job成功可提交且不被旧finally解锁", async () => {
    for (const outcome of ["success", "error"] as const) {
      const h = setup(),
        late = deferred<null>();
      h.model.editFeedback("当前店反馈");
      h.api.feedback.mockReturnValueOnce(late.promise);
      const pending = h.model.feedback();
      h.setScope("token/member/entity/clerk/other/rev2");
      const snapshot = h.model.snapshot();
      if (outcome === "success") late.resolve(null);
      else late.reject(error("NETWORK_ERROR", 0));
      await pending;
      expect(h.model.snapshot()).toBe(snapshot);
      h.model.dispose();
    }
    const hidden = setup(),
      receipt = deferred<null>();
    hidden.model.editFeedback("原意图");
    hidden.api.feedback.mockReturnValueOnce(receipt.promise);
    const pending = hidden.model.feedback();
    hidden.model.suspend();
    receipt.resolve(null);
    await pending;
    hidden.model.resume();
    expect(hidden.model.snapshot()).toMatchObject({
      content: "原意图",
      feedbackPending: true,
      feedbackBusy: false,
    });
    await hidden.model.feedback();
    expect(hidden.api.feedback.mock.calls[1]).toEqual(hidden.api.feedback.mock.calls[0]);
    const resumed = setup(),
      done = deferred<FileStatus | null>();
    const paused = job(assetId(101), () => done.promise);
    paused.value.retry = vi.fn(async () => {
      paused.change({ status: "stored", fileId: assetId(101), progress: 100 });
      done.resolve(result());
      return result();
    });
    resumed.jobs[0] = paused;
    const choice = resumed.model.choose("image");
    await flush();
    resumed.model.suspend();
    expect(paused.value.snapshot().status).toBe("paused");
    resumed.model.resume();
    await choice;
    await flush();
    expect(resumed.model.snapshot().files.map((file) => file.status)).toEqual(["stored", "stored"]);
    await resumed.model.portrait();
    expect(resumed.api.portrait).toHaveBeenCalledOnce();
    const disposed = setup(),
      last = deferred<null>();
    disposed.model.editFeedback("待发送");
    disposed.api.feedback.mockReturnValueOnce(last.promise);
    const flight = disposed.model.feedback();
    disposed.model.dispose();
    const frozen = disposed.model.snapshot();
    last.resolve(null);
    await flight;
    expect(disposed.model.snapshot()).toBe(frozen);
  });
});
