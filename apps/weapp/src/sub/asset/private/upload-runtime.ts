import { account } from "@/lib/account-runtime";
import { request, newIdempotencyKey } from "@/lib/runtime";
import { storage } from "@/lib/platform.taro";
import { createUploadApi } from "@/lib/upload/api";
import { clientToken } from "@/lib/upload/hash";
import { createResumeStore, type ResumeOwner } from "@/lib/upload/resume";
import { createTaroMultipartPorts, createTaroUpload } from "@/lib/upload/taro";
import { useSessionStore } from "@/stores/session";
import { useContextStore } from "@/stores/context";
import { assetScope } from "./resource";
import { createAssetUploadApi, type AssetUploadApi } from "./upload-api";
import { createAssetUploadRecords } from "./upload-records";
import { createAssetUploadTasks, type AssetUploadTasks } from "./upload-tasks";
import { createNativeAssetUploadPlatform, type AssetUploadPlatform } from "./upload-platform";
export interface AssetUploadRuntime {
  api: AssetUploadApi;
  tasks: AssetUploadTasks;
  platform(current: () => boolean): AssetUploadPlatform;
}
const records = createAssetUploadRecords(storage, Date.now);
const scope = () =>
  assetScope(
    useSessionStore.getState().accessToken,
    useContextStore.getState(),
    account.snapshot().me,
  );
let cached: {
  scope: string;
  runtime: Promise<AssetUploadRuntime>;
  dispose: (() => void) | null;
} | null = null;
const invalidate = () => {
  if (cached && cached.scope !== scope()) {
    cached.dispose?.();
    cached = null;
  }
};
useContextStore.subscribe(invalidate);
account.subscribe(invalidate);
useSessionStore.subscribe((state, previous) => {
  invalidate();
  if (previous.accessToken && state.accessToken !== previous.accessToken) {
    try {
      records.clear();
    } catch {
      /* 读取仍完整owner隔离，不给下个账户恢复入口。 */
    }
  }
});
export async function getAssetUploadRuntime(): Promise<AssetUploadRuntime> {
  invalidate();
  const key = scope();
  if (!key) throw new Error("登录并选择当前成员门店后上传");
  if (cached) return cached.runtime;
  const me = account.snapshot().me!,
    storeId = useContextStore.getState().currentStoreId!;
  const member = me.memberships.find((item) =>
    item.stores.some((store) => store.storeId === storeId),
  )!;
  const owner: ResumeOwner = {
    userId: me.user.merchantUserId,
    memberId: member.memberId,
    entityId: member.entity.entityId,
    storeId,
    role: member.role,
    storeScope: JSON.stringify(member.stores.map((s) => [s.storeId, s.lifecycle]).sort()),
  };
  const make = async (): Promise<AssetUploadRuntime> => {
    if (process.env.TARO_ENV === "h5") {
      const scene = (globalThis as { __LYX_ASSET_UPLOAD_SHOT__?: string })
        .__LYX_ASSET_UPLOAD_SHOT__;
      if (scene) {
        const { createAssetUploadFixture } =
          await import("../../../../shots/asset-upload-fixtures");
        if (scope() !== key) throw new Error("原门店已变化");
        return createAssetUploadFixture(scene, scope, owner);
      }
    }
    const files = createUploadApi(request),
      native = createTaroMultipartPorts();
    const tasks = createAssetUploadTasks({
      owner,
      scope,
      records,
      api: createAssetUploadApi(request),
      files,
      fingerprint: async (file) =>
        clientToken(
          {
            ...file,
            storeId,
            category: "store_asset",
            width: file.width ?? 0,
            height: file.height ?? 0,
            durationMs: file.durationMs ?? 0,
          },
          await native.read(file.path, 0, Math.min(file.size, 256 * 1024)),
        ),
      job: (file) => createTaroUpload(file, "store_asset"),
      forgetResume: (id) => createResumeStore(storage, Date.now).remove(owner, id),
      key: newIdempotencyKey,
      now: Date.now,
    });
    return { api: createAssetUploadApi(request), tasks, platform: createNativeAssetUploadPlatform };
  };
  const holder = { scope: key, runtime: make(), dispose: null as (() => void) | null };
  cached = holder;
  holder.runtime = holder.runtime
    .then((runtime) => {
      if (cached !== holder || scope() !== key) {
        runtime.tasks.dispose();
        throw new Error("原门店已变化");
      }
      holder.dispose = () => runtime.tasks.dispose();
      return runtime;
    })
    .catch((error: unknown) => {
      if (cached === holder) cached = null;
      throw error;
    });
  return holder.runtime;
}
