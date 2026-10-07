import { isMainThread, parentPort } from "node:worker_threads";
import { documentFailure } from "./types.js";
import type { DocumentInput } from "./types.js";

/** Only the two emitted thin worker entries call this; CPU/native imports are lazy inside the thread. */
export function runDocumentConversionWorker(): void {
  if (isMainThread || !parentPort)
    throw new Error("document converter must run in an isolated worker");
  const port = parentPort;
  port.once("message", (input: DocumentInput) => {
    void import("./convert.js")
      .then(({ convertDocumentBytes }) => convertDocumentBytes(input))
      .catch((error: unknown) => documentFailure(error))
      .then((result) => {
        port.postMessage(result);
        port.close();
      });
  });
}
