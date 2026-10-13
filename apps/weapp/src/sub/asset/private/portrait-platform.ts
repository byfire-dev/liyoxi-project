import Taro from "@tarojs/taro";
import { account } from "@/lib/account-runtime";
import { storage } from "@/lib/platform.taro";
import { request, withPrivacy } from "@/lib/runtime";
import { createUploadApi, type UploadApi } from "@/lib/upload/api";
import { clientToken } from "@/lib/upload/hash";
import type { SelectedFile, UploadJob } from "@/lib/upload/queue";
import { createResumeStore, type ResumeOwner } from "@/lib/upload/resume";
import { createTaroMultipartPorts, createTaroUpload, prepareTaroFile } from "@/lib/upload/taro";
import { useContextStore } from "@/stores/context";
import { useSessionStore } from "@/stores/session";
import { assetScope } from "./resource";

export interface PortraitPorts {
  choose(kind: "image" | "pdf", count: number): Promise<SelectedFile[]>;
  fingerprint(file: SelectedFile): Promise<string>;
  job(file: SelectedFile): UploadJob;
  files: UploadApi;
  forget(fileId: string): void;
}

export async function createNativePortraitPorts(current: () => boolean): Promise<PortraitPorts> {
  const token = useSessionStore.getState().accessToken;
  const context = useContextStore.getState();
  const me = account.snapshot().me;
  const scope = assetScope(token, context, me);
  const storeId = context.currentStoreId;
  const member = me?.memberships.find((item) =>
    item.stores.some((store) => store.storeId === storeId),
  );
  if (!scope || !storeId || !me || !member || !current())
    throw new Error("登录并选择当前成员门店后补交授权材料");
  const owner: ResumeOwner = {
    userId: me.user.merchantUserId,
    memberId: member.memberId,
    entityId: member.entity.entityId,
    storeId,
    role: member.role,
    storeScope: JSON.stringify(
      member.stores.map((store) => [store.storeId, store.lifecycle]).sort(),
    ),
  };
  const assertCurrent = () => {
    if (
      !current() ||
      assetScope(
        useSessionStore.getState().accessToken,
        useContextStore.getState(),
        account.snapshot().me,
      ) !== scope
    )
      throw new Error("原门店或成员权限已变化，请重新打开素材");
  };
  const guarded = async <T>(call: () => Promise<T>): Promise<T> => {
    assertCurrent();
    try {
      return await call();
    } finally {
      assertCurrent();
    }
  };
  const native = createTaroMultipartPorts();
  const resume = createResumeStore(storage, Date.now);
  return {
    async choose(kind, count) {
      if (!Number.isSafeInteger(count) || count < 1 || count > 9)
        throw new Error("每次请选择1至9份授权材料");
      const result = await guarded(() =>
        withPrivacy(async () => {
          assertCurrent();
          const selected: SelectedFile[] = [];
          if (kind === "image") {
            const choice = await guarded(() =>
              Taro.chooseMedia({ count, mediaType: ["image"], sizeType: ["original"] }),
            );
            assertCurrent();
            for (const file of choice.tempFiles) {
              const info = await guarded(() => Taro.getImageInfo({ src: file.tempFilePath }));
              assertCurrent();
              selected.push({
                path: file.tempFilePath,
                name: `portrait.${info.type}`,
                size: file.size,
                width: info.width,
                height: info.height,
              });
            }
          } else {
            if (process.env.TARO_ENV !== "weapp")
              throw new Error("请在微信中从聊天选择PDF授权材料；H5不提供此原生文件能力");
            const choice = await guarded(() =>
              Taro.chooseMessageFile({ count, type: "file", extension: ["pdf"] }),
            );
            assertCurrent();
            if (choice.tempFiles.some((file) => !/\.pdf$/iu.test(file.name)))
              throw new Error("请选择PDF授权材料");
            selected.push(
              ...choice.tempFiles.map((file) => ({
                path: file.path,
                name: file.name,
                size: file.size,
              })),
            );
          }
          const files: SelectedFile[] = [];
          for (const file of selected) {
            const prepared = await guarded(() => prepareTaroFile(file, "portrait_auth"));
            assertCurrent();
            if (prepared) files.push(prepared);
          }
          return files;
        }),
      );
      assertCurrent();
      if (!result.ok) throw new Error("请先同意隐私指引，再选择授权材料");
      return result.value;
    },
    async fingerprint(file) {
      const head = await guarded(() => native.read(file.path, 0, Math.min(file.size, 256 * 1024)));
      assertCurrent();
      return clientToken(
        {
          ...file,
          storeId,
          category: "portrait_auth",
          width: file.width ?? 0,
          height: file.height ?? 0,
          durationMs: file.durationMs ?? 0,
        },
        head,
      );
    },
    job(file) {
      assertCurrent();
      return createTaroUpload(file, "portrait_auth");
    },
    files: createUploadApi(request),
    forget: (fileId) => resume.remove(owner, fileId),
  };
}
