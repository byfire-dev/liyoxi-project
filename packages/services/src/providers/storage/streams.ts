import { createHash } from "node:crypto";
import { failed, ok } from "../types.js";
import type { ProviderResult, StorageProvider } from "../types.js";
/** Transfer caps are implementation defense bounds, not broader upload limits. */
export const MAX_STREAM_BYTES = 2 * 1024 * 1024 * 1024;
export const STREAM_TIMEOUT_MS = 180_000;
export function validStreamSize(size: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && size <= MAX_STREAM_BYTES;
}
export function validStreamRead(input: {
  expectedSize: number;
  maxBytes: number;
  ifMatchEtag: string;
}): boolean {
  return (
    validStreamSize(input.expectedSize) &&
    validStreamSize(input.maxBytes) &&
    input.expectedSize <= input.maxBytes &&
    /^[\x21-\x7e]{1,1024}$/.test(input.ifMatchEtag)
  );
}
export function validStreamWrite(input: {
  size: number;
  sha256: string;
  contentIdentity: string;
}): boolean {
  return (
    validStreamSize(input.size) &&
    /^[a-f0-9]{64}$/.test(input.sha256) &&
    /^[a-f0-9]{64}$/.test(input.contentIdentity)
  );
}
/** Generator owns and closes the source iterator; each next waits for its consumer. */
export async function* checkedStream(
  source: AsyncIterable<Uint8Array>,
  size: number,
  signal: AbortSignal,
  complete: (sha256: string) => void,
): AsyncGenerator<Uint8Array> {
  let total = 0;
  const hash = createHash("sha256");
  for await (const chunk of source) {
    if (signal.aborted) throw new Error("storage transfer canceled");
    if (!(chunk instanceof Uint8Array) || chunk.byteLength > 1024 * 1024)
      throw new Error("storage transfer chunk invalid");
    total += chunk.byteLength;
    if (total > size) throw new Error("storage transfer length exceeded");
    hash.update(chunk);
    yield chunk;
  }
  if (signal.aborted || total !== size) throw new Error("storage transfer incomplete");
  complete(hash.digest("hex"));
}

/** Metadata narrows candidates; only a conditional, fully hashed read can adopt one. */
export async function verifyReplay(
  input: Pick<Parameters<StorageProvider["putStream"]>[0], "bucket" | "key" | "size" | "sha256">,
  etag: string,
  signal: AbortSignal,
  read: (
    input: Parameters<StorageProvider["readTo"]>[0],
    signal: AbortSignal,
  ) => ReturnType<StorageProvider["readTo"]>,
): Promise<ProviderResult<{ etag: string; size: number }>> {
  const result = await read(
    {
      bucket: input.bucket,
      key: input.key,
      expectedSize: input.size,
      maxBytes: input.size,
      ifMatchEtag: etag,
      signal,
      sink: async () => {
        /* hash only */
      },
    },
    signal,
  );
  if (!result.ok) return result;
  return result.value.size === input.size && result.value.sha256 === input.sha256
    ? ok({ etag, size: input.size })
    : failed("rejected", "已有对象真实字节hash不一致");
}
