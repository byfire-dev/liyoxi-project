import { extensionOf, maxUploadBytes } from "@liyoxi/shared/uploads";
import { Button } from "antd";
import { useCallback, useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import type { AppServices } from "../../../app/services";
import { UploadField } from "../../../components/UploadField";
import type { UploadFn } from "../../../lib/upload";
import {
  createAdminMultipartUploadPorts,
  createMultipartUploadAdapter,
} from "../../../lib/upload-multipart";

const extensions = {
  image: ["jpg", "jpeg", "png"],
  video: ["mp4", "mov"],
  recording: ["mp3", "m4a", "wav", "aac"],
  audio: ["mp3", "m4a", "wav", "aac"],
  document: ["pdf", "docx", "txt"],
  portrait: ["jpg", "jpeg", "png", "pdf"],
} as const;
export type UploadAssetType = keyof typeof extensions;
export function uploadAssetType(value: string): UploadAssetType | undefined {
  if (
    value === "image" ||
    value === "video" ||
    value === "recording" ||
    value === "audio" ||
    value === "document"
  )
    return value;
  return undefined;
}
export interface UploadSlot {
  key: string;
  fileId: string | null;
}
export const newUploadSlot = (): UploadSlot => ({ key: crypto.randomUUID(), fileId: null });
function StoredFile({
  services,
  storeId,
  type,
  onChange,
}: {
  services: AppServices;
  storeId: string;
  type: UploadAssetType;
  onChange(id: string | null): void;
}) {
  const category = type === "portrait" ? "portrait_auth" : "store_asset";
  const adapter = useRef<ReturnType<typeof createMultipartUploadAdapter> | undefined>(undefined),
    current = useRef<File | undefined>(undefined),
    active = useRef(false),
    generation = useRef(0);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const owned = adapter.current,
        file = current.current;
      if (file) void owned?.cancel(file).catch(() => undefined);
      owned?.close();
      adapter.current = undefined;
      current.current = undefined;
    };
  }, [services, storeId, type]);
  const upload = useCallback<UploadFn>(
    async (file, hooks) => {
      const ext = extensionOf(file.name);
      if (
        !ext ||
        !extensions[type].some((allowed) => allowed === ext) ||
        BigInt(file.size) > maxUploadBytes(category, ext, "admin")
      )
        throw new Error("文件类型或大小不符合本分类限制");
      const mine = ++generation.current;
      adapter.current ??= createMultipartUploadAdapter({
        ports: createAdminMultipartUploadPorts(services.api.client, {
          category,
          storeId,
          onBehalfStore: true,
        }),
      });
      const owned = adapter.current;
      if (current.current && current.current !== file) await owned.cancel(current.current);
      current.current = file;
      const result = await owned.upload(file, hooks);
      if (!active.current || generation.current !== mine) throw new Error("此上传已不属于当前操作");
      return result;
    },
    [services, storeId, type, category],
  );
  const rule = useMemo(
    () => ({
      accept: extensions[type].map((ext) => `.${ext}`),
      maxSizeMb:
        Math.max(...extensions[type].map((ext) => Number(maxUploadBytes(category, ext, "admin")))) /
        1024 /
        1024,
    }),
    [type, category],
  );
  return (
    <UploadField
      rule={rule}
      upload={upload}
      onChange={(id) => {
        if (active.current) onChange(id);
      }}
      text={type === "portrait" ? "上传肖像授权材料" : "上传素材文件"}
    />
  );
}
export function StoredFiles({
  services,
  storeId,
  type,
  slots,
  change,
}: {
  services: AppServices;
  storeId: string;
  type: UploadAssetType;
  slots: UploadSlot[];
  change: Dispatch<SetStateAction<UploadSlot[]>>;
}) {
  return (
    <div aria-label={type === "portrait" ? "肖像授权材料上传" : "素材文件上传"}>
      <p>分类登记、直传、确认并成功入库后才可提交。取消仅清本轮临时上传，不删除既有引用文件。</p>
      {slots.map((slot) => (
        <div key={slot.key}>
          <StoredFile
            services={services}
            storeId={storeId}
            type={type}
            onChange={(fileId) =>
              change((current) =>
                current.map((value) => (value.key === slot.key ? { ...value, fileId } : value)),
              )
            }
          />
          <Button onClick={() => change(slots.filter((value) => value.key !== slot.key))}>
            移除此上传位
          </Button>
        </div>
      ))}
      {slots.length < (type === "recording" ? 1 : 9) ? (
        <Button onClick={() => change([...slots, newUploadSlot()])}>添加文件</Button>
      ) : null}
    </div>
  );
}
