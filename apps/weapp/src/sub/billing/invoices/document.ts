import Taro from "@tarojs/taro";
import type { InvoiceFiles } from "./model";
export const invoiceFiles: InvoiceFiles = {
  async download(url, signal) {
    signal.throwIfAborted();
    const task = Taro.downloadFile({ url, timeout: 15_000 });
    const abort = () => task.abort();
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await task;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  },
  async open(filePath, format, fileName) {
    if (format === "pdf") {
      await Taro.openDocument({ filePath, fileType: "pdf", showMenu: true });
      return;
    }
    const share = (
      Taro as unknown as {
        shareFileMessage?: (input: { filePath: string; fileName: string }) => Promise<unknown>;
      }
    ).shareFileMessage;
    if (!share) throw new Error("DOCUMENT_UNSUPPORTED");
    await share({ filePath, fileName });
  },
  remove: (filePath) =>
    new Promise((resolve, reject) => {
      Taro.getFileSystemManager().unlink({ filePath, success: () => resolve(), fail: reject });
    }),
};
