import Taro from "@tarojs/taro";
export function fileInfo(filePath: string, digestAlgorithm: "md5" | "sha1" = "md5") {
  return new Promise<Taro.getFileInfo.SuccessCallbackResult>((resolve, reject) =>
    Taro.getFileInfo({ filePath, digestAlgorithm, success: resolve, fail: reject }),
  );
}
