import { isMainThread } from "node:worker_threads";
import { runDocumentConversionWorker } from "@liyoxi/services";
export { createDocumentConverter } from "@liyoxi/services";
if (!isMainThread) runDocumentConversionWorker();
