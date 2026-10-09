import { isMarkedAsUntransferable, Worker } from "node:worker_threads";
import { assertNotInTransaction } from "../tx.js";
import { DOCUMENT_LIMITS as L } from "./limits.js";
import { documentFailure, DocumentFailure } from "./types.js";
import type { DocumentConversionResult, DocumentInput } from "./types.js";

export interface DocumentConversionRequest {
  /** Invoked only after admission; pass its signal to every HEAD/GET. Never load bytes before calling. */
  readonly load: (signal: AbortSignal) => Promise<DocumentInput>;
  readonly signal?: AbortSignal;
}
export interface DocumentConverter {
  convert(input: DocumentConversionRequest): Promise<DocumentConversionResult>;
  close(): Promise<void>;
}
/** Admission includes bounded wait, load and isolated computation in one 10-second wall deadline. */
export function createDocumentConverter(options: {
  workerUrl: URL;
  concurrency?: 1;
}): DocumentConverter {
  if (options.workerUrl.protocol !== "file:" || (options.concurrency ?? 1) !== 1)
    throw new RangeError("document converter requires one file worker");
  let closed = false,
    tail: Promise<void> = Promise.resolve();
  const pending = new Map<AbortController, Promise<void>>();
  const failures = (
    reason: "cancelled" | "deadline_exceeded" | "too_large",
  ): DocumentConversionResult => ({ ok: false, reason, role: null });
  return {
    async convert(request) {
      assertNotInTransaction("document conversion");
      if (closed || request.signal?.aborted) return failures("cancelled");
      if (pending.size >= 16) return failures("too_large"); // Bounded callbacks; no raw bytes queued.
      const control = new AbortController();
      let resolveGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        resolveGate = resolve;
      });
      const previous = tail;
      tail = previous.then(() => gate);
      pending.set(control, tail);
      let reason: "cancelled" | "deadline_exceeded" = "cancelled";
      const abort = () => control.abort();
      request.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => {
        reason = "deadline_exceeded";
        control.abort();
      }, L.deadlineMs);
      let admitted = false;
      let loaderError: { error: unknown } | undefined;
      let worker: Worker | undefined, load: Promise<DocumentInput> | undefined;
      let aborted!: () => void;
      const cancellation = new Promise<never>((_, reject) => {
        aborted = () => reject(new DocumentFailure(reason));
        control.signal.addEventListener("abort", aborted, { once: true });
      });
      try {
        await Promise.race([previous, cancellation]);
        if (control.signal.aborted) throw new DocumentFailure(reason);
        admitted = true;
        load = Promise.resolve()
          .then(() => request.load(control.signal))
          .catch((error: unknown) => {
            loaderError = { error };
            throw error;
          });
        const input = await Promise.race([load, cancellation]);
        const transfer: ArrayBuffer[] = [];
        const payload = { ...input };
        for (const role of ["source", "pdf"] as const) {
          const key = `${role}Bytes` as const,
            bytes = input[key];
          if (bytes === null) continue;
          if (!(bytes instanceof Uint8Array)) throw new DocumentFailure("invalid_document", role);
          if (bytes.byteLength > L.fileBytes) throw new DocumentFailure("too_large", role);
          const owned =
            bytes.buffer instanceof ArrayBuffer &&
            bytes.byteOffset === 0 &&
            bytes.byteLength === bytes.buffer.byteLength &&
            !isMarkedAsUntransferable(bytes.buffer)
              ? bytes
              : Uint8Array.from(bytes);
          payload[key] = owned;
          transfer.push(owned.buffer as ArrayBuffer);
        }
        worker = new Worker(options.workerUrl, {
          execArgv: [],
          env: { NODE_ENV: "production" },
          stdout: true,
          stderr: true,
          resourceLimits: { maxOldGenerationSizeMb: L.heapMb, stackSizeMb: L.stackMb },
        });
        worker.stdout?.resume();
        worker.stderr?.resume(); // Never surface parser diagnostics or document fragments.
        const result = new Promise<DocumentConversionResult>((resolve) => {
          worker!.once("message", (message: DocumentConversionResult) => resolve(message));
          worker!.once("error", (error: Error & { code?: string }) =>
            resolve({
              ok: false,
              reason: error.code === "ERR_WORKER_OUT_OF_MEMORY" ? "too_large" : "invalid_document",
              role: null,
            }),
          );
          worker!.once("exit", () => resolve(failures("cancelled")));
        });
        worker.postMessage(payload, [...new Set(transfer)]);
        return await Promise.race([result, cancellation]);
      } catch (error) {
        if (loaderError?.error === error && !control.signal.aborted) throw error;
        return documentFailure(error);
      } finally {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", abort);
        control.signal.removeEventListener("abort", aborted);
        // A compliant loader stops its I/O on abort. Do not admit another read until it actually settles.
        const cleanup = Promise.allSettled([
          previous,
          load ?? Promise.resolve(),
          worker?.terminate() ?? Promise.resolve(),
        ]).then(() => {
          resolveGate();
          pending.delete(control);
        });
        if (admitted) await cleanup;
      }
    },
    async close() {
      closed = true;
      for (const control of pending.keys()) control.abort();
      await Promise.allSettled([...pending.values()]);
    },
  };
}
