export interface ContractDocumentPorts {
  download(url: string): {
    promise: Promise<{ statusCode: number; tempFilePath: string }>;
    abort(): void;
  };
  open(path: string): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
}
/** 只拥有本次下载；地址不缓存，离页取消后不得打开迟到文件。 */
export function createContractDocument(ports: ContractDocumentPorts) {
  let pending: ReturnType<ContractDocumentPorts["download"]> | null = null;
  return {
    cancel() {
      pending?.abort();
      pending = null;
    },
    async open(url: string, current: () => boolean) {
      if (!current()) return;
      const task = ports.download(url);
      pending = task;
      let ownedPath: string | null = null;
      try {
        const result = await task.promise;
        ownedPath = result.tempFilePath || null;
        if (!current()) return;
        if (result.statusCode !== 200 || !ownedPath) throw new Error("PDF下载失败");
        await ports.open(ownedPath);
      } finally {
        if (pending === task) pending = null;
        if (ownedPath) await ports.unlink(ownedPath).catch(() => undefined);
      }
    },
  };
}
export type ContractDocument = ReturnType<typeof createContractDocument>;
