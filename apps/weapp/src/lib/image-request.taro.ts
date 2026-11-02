import { UPLOAD_LIMITS } from "@liyoxi/shared/uploads";
import Taro from "@tarojs/taro";

import { createImageRequester } from "./image-request";
import { createImageRequestQueue } from "./image-request-queue";
import { uuid } from "./platform";

// 卡片共用两个下载槽；只在原生 Image 加载失败后进入队列。
const requests = createImageRequestQueue(2);
let previousFilesReclaimed = false;
const ownedFile =
  /^cover-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(?:jpg|png)$/;

function reclaimPreviousFiles(
  directory: string,
  files: ReturnType<typeof Taro.getFileSystemManager>,
) {
  if (previousFilesReclaimed) return;
  // 只在本进程第一次写入前执行；不能在后续封面创建时误删仍在使用的图片。
  previousFilesReclaimed = true;
  try {
    for (const name of files.readdirSync(directory)) {
      if (!ownedFile.test(name)) continue;
      try {
        files.unlinkSync(`${directory}/${name}`);
      } catch {
        // 单个旧文件无法删除不阻断其他文件回收或本次恢复。
      }
    }
  } catch {
    // 读取目录失败仍允许尝试写入；下次进程启动会重新回收。
  }
}

export function createNativeImageRequester() {
  return createImageRequester({
    request(url) {
      return requests.enqueue(() => {
        const task = Taro.request<ArrayBuffer>({
          url,
          method: "GET",
          dataType: "text",
          responseType: "arraybuffer",
          timeout: 15_000,
        });
        return {
          promise: task.then((result) => ({
            statusCode: result.statusCode,
            data: result.data,
          })),
          abort: () => task.abort(),
        };
      });
    },
    write(bytes) {
      // 封面沿用上传协议的 PNG/JPEG 与 5MB 上限，错误正文不落为图片。
      if (bytes.byteLength > UPLOAD_LIMITS.imageMaxMb * 1024 * 1024)
        throw new Error("Image response exceeds upload limit");
      const signature = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 8));
      const jpeg = signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff;
      const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
        (byte, index) => signature[index] === byte,
      );
      if (!jpeg && !png) throw new Error("Image response is not PNG or JPEG");
      const directory = Taro.env.USER_DATA_PATH;
      if (!directory) throw new Error("Local image directory is unavailable");
      const path = `${directory}/cover-${uuid()}.${jpeg ? "jpg" : "png"}`;
      const files = Taro.getFileSystemManager();
      reclaimPreviousFiles(directory, files);
      try {
        files.writeFileSync(path, bytes);
      } catch (error) {
        try {
          files.unlinkSync(path);
        } catch {
          // 只清理本次写入可能留下的文件，不影响其他图片。
        }
        throw error;
      }
      return path;
    },
    remove(path) {
      Taro.getFileSystemManager().unlinkSync(path);
    },
  });
}
