import {
  extensionOf,
  UPLOAD_CATEGORIES,
  UPLOAD_LIMITS,
  type UploadCategory,
} from "@liyoxi/shared/uploads";
import type { SelectedFile } from "./queue";
export interface PrecheckDeps {
  compress(file: SelectedFile, quality: 80 | 60 | 40): Promise<SelectedFile>;
  compressVideo(file: SelectedFile): Promise<SelectedFile>;
  network(): Promise<string>;
  confirmCellular(sizeMb: number): Promise<boolean>;
}
/** 只检查端上可得的格式与字节；服务端仍决定通道、内容与是否可引用。 */
export async function precheckFile(
  deps: PrecheckDeps,
  original: SelectedFile,
  category: UploadCategory,
  limits: { imageMaxMb: number; weappVideoMaxMb: number },
): Promise<SelectedFile | null> {
  const ext = extensionOf(original.name);
  if (!ext || !UPLOAD_CATEGORIES[category].exts.includes(ext))
    throw new Error("此分类不支持该文件格式，请重新选择");
  const image = ["jpg", "jpeg", "png"].includes(ext),
    video = ["mp4", "mov"].includes(ext);
  // shared 的 maxUploadBytes 含 BigInt，不能进入当前小程序编译目标。
  // 非图片/视频仍经真实登记接口校验精确上限，不在这里复制服务端规则。
  const limit = image
    ? Math.min(limits.imageMaxMb, UPLOAD_LIMITS.imageMaxMb) * 1024 * 1024
    : video
      ? limits.weappVideoMaxMb * 1024 * 1024
      : Number.MAX_SAFE_INTEGER;
  let file = original;
  if (image)
    for (const quality of [80, 60, 40] as const) {
      if (file.size <= limit) break;
      try {
        const next = await deps.compress(original, quality);
        if (next.size < file.size) file = next;
      } catch {
        /* 仍尝试下一档；全部失败给明确提示。 */
      }
    }
  if (video && file.size > limit) {
    try {
      const next = await deps.compressVideo(file);
      if (next.size < file.size) file = next;
    } catch {
      /* 改传小视频或联系服务经理。 */
    }
  }
  if (file.size > limit)
    throw new Error(
      video
        ? `视频超过当前${Math.floor(limit / 1024 / 1024)}MB上限，请改传较小视频或联系服务经理代传`
        : `文件超过当前${Math.floor(limit / 1024 / 1024)}MB上限，请压缩后重新选择`,
    );
  if (file.size <= 0) throw new Error("文件为空，请重新选择");
  if (
    file.size > 50 * 1024 * 1024 &&
    (await deps.network()) !== "wifi" &&
    !(await deps.confirmCellular(Math.ceil(file.size / 1024 / 1024)))
  )
    return null;
  return file;
}
