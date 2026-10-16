import Taro from "@tarojs/taro";
import type { RequestLayer } from "@/lib/request";
import { request } from "@/lib/runtime";
import { createContractDocument } from "./document";

const shot = () => {
  if (process.env.TARO_ENV !== "h5") return null;
  const scene = (globalThis as { __LYX_BILLING_SHOT__?: string }).__LYX_BILLING_SHOT__;
  return scene === "contracts-old-version" || scene === "contracts-clerk" ? scene : null;
};
export const contractsRequest: RequestLayer["request"] = async (path, options) => {
  const scene = shot();
  if (scene)
    return (await import("../../../../shots/contracts-fixtures")).offlineContractsRequest(scene)(
      path,
      options,
    );
  return request(path, options);
};
export function contractsDocument() {
  return createContractDocument({
    download(url) {
      if (shot()) {
        const evidence = globalThis as { __LYX_CONTRACT_DOCUMENTS__?: string[] };
        if (!/^https:\/\/private\.invalid\/agreements\/old\.pdf\?signature=\d+$/.test(url))
          throw new Error("离线样张只能打开已签旧版本PDF");
        evidence.__LYX_CONTRACT_DOCUMENTS__ ??= [];
        evidence.__LYX_CONTRACT_DOCUMENTS__.push("download");
        return {
          promise: Promise.resolve({ statusCode: 200, tempFilePath: "shot-contract-old.pdf" }),
          abort() {},
        };
      }
      const task = Taro.downloadFile({ url, timeout: 15000 });
      return {
        promise: task.then((result) => ({
          statusCode: result.statusCode,
          tempFilePath: result.tempFilePath,
        })),
        abort: () => task.abort(),
      };
    },
    async open(filePath) {
      if (shot()) {
        (globalThis as { __LYX_CONTRACT_DOCUMENTS__?: string[] }).__LYX_CONTRACT_DOCUMENTS__?.push(
          "open",
        );
        return;
      }
      await Taro.openDocument({ filePath, fileType: "pdf", showMenu: true });
    },
    async unlink(filePath) {
      if (shot()) return;
      await new Promise<void>((resolve, reject) =>
        Taro.getFileSystemManager().unlink({ filePath, success: () => resolve(), fail: reject }),
      );
    },
  });
}
