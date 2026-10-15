// Private pipe protocol only. None of its capabilities belong in a public smoke report.
import { z } from "@liyoxi/contract";
import type { M1Attachment, M1SupportOptions } from "@liyoxi/services/testing";

export const MIXED_PROTOCOL = "w228-rpc-v1" as const;
export const MIXED_MAX_MESSAGE = 1024 * 1024;
export const MixedSource = z.string().regex(/^[a-f0-9]{40}$/);
export const MixedAdmin = z.strictObject({
  staffId: z.uuid(),
  phone: z.string().regex(/^1[3-9][0-9]{9}$/),
  password: z.string().min(12).max(256),
  secret: z.string().regex(/^[A-Z2-7]{16,128}$/),
  recoveryCodes: z.array(z.string().min(1).max(128)).max(32),
});
export const MixedAccess = z.strictObject({
  admin: MixedAdmin,
  chainId: z.string().regex(/^[a-z0-9]{1,12}$/),
  ids: z.strictObject({
    entityId: z.uuid(),
    storeId: z.uuid(),
    merchantUserId: z.uuid(),
    orderId: z.uuid(),
    orderItemId: z.uuid(),
    deliveryTicketId: z.uuid(),
    sampleId: z.uuid(),
  }),
});
export type MixedPrivateAccess = z.output<typeof MixedAccess>;
export type OwnerNetwork = NonNullable<M1SupportOptions["ownerNetwork"]>;
export const MixedRequest = z.strictObject({
  protocol: z.literal(MIXED_PROTOCOL),
  id: z.int().positive(),
  method: z.enum([
    "owner.init",
    "owner.close",
    "phase.start",
    "phase.chain",
    "phase.read",
    "phase.drain",
    "phase.close",
  ]),
  params: z.unknown(),
});
export type MixedRequestValue = z.output<typeof MixedRequest>;
export type MixedErrorCode =
  | "invalid_request"
  | "invalid_source"
  | "invalid_state"
  | "cancelled"
  | "start_failed"
  | "chain_failed"
  | "read_failed"
  | "drain_failed"
  | "cleanup_failed";
export class MixedFailure extends Error {
  constructor(readonly code: MixedErrorCode) {
    super("Mixed driver failed");
  }
}
export class MixedReadFailure extends MixedFailure {
  constructor(readonly operationId: string) {
    super("read_failed");
    if (!/^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(operationId)) throw new MixedFailure("read_failed");
  }
}
/** Raw diagnostic lines are never retained; errors and malformed records remain failures. */
export function mixedDiagnostics() {
  let errors = 0;
  return {
    write(line: string) {
      try {
        const value = z
          .object({ level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]) })
          .parse(JSON.parse(line) as unknown);
        if (value.level === "error" || value.level === "fatal") errors++;
      } catch {
        errors++;
      }
    },
    count: () => errors,
  };
}
export function assertMixedSource(expected: unknown, actual: string): string {
  const parsed = MixedSource.safeParse(expected);
  if (!parsed.success || parsed.data !== actual) throw new MixedFailure("invalid_source");
  return parsed.data;
}
export function mixedStorage(runId: string): M1Attachment["storage"] {
  if (!/^[a-z0-9]{1,12}$/.test(runId)) throw new MixedFailure("invalid_request");
  return {
    endpoint: "http://lyx-mixed-" + runId + "-minio:9000",
    region: "us-east-1",
    accessKey: "liyoxi",
    secretKey: "lyx-local-dev",
    buckets: {
      secure: "lyx-test-mixed-" + runId + "-secure",
      asset: "lyx-test-mixed-" + runId + "-asset",
      media: "lyx-test-mixed-" + runId + "-media",
      pub: "lyx-test-mixed-" + runId + "-pub",
    },
  };
}
/** Serial and byte-bounded; malformed input never dispatches an operation or exposes raw errors. */
export async function serveMixedRpc(
  input: AsyncIterable<Uint8Array>,
  write: (line: string) => Promise<void>,
  dispatch: (request: MixedRequestValue) => Promise<unknown>,
): Promise<void> {
  let chunks: Uint8Array[] = [],
    bytes = 0,
    lastId = 0;
  const line = async () => {
    let id: number | null = null;
    let result: unknown;
    let closed = false;
    try {
      const raw: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
      );
      const request = MixedRequest.parse(raw);
      id = request.id;
      if (id <= lastId) throw new MixedFailure("invalid_request");
      lastId = id;
      result = { protocol: MIXED_PROTOCOL, id, ok: true, result: await dispatch(request) };
      closed = request.method.endsWith(".close");
    } catch (error) {
      result = {
        protocol: MIXED_PROTOCOL,
        id,
        ok: false,
        errorCode: error instanceof MixedFailure ? error.code : "invalid_request",
        ...(error instanceof MixedReadFailure ? { operationId: error.operationId } : {}),
      };
    }
    chunks = [];
    bytes = 0;
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output) > MIXED_MAX_MESSAGE) throw new MixedFailure("invalid_request");
    await write(output + "\n");
    if (result && typeof result === "object" && "ok" in result && result.ok === false)
      throw new MixedFailure("invalid_request");
    return closed;
  };
  for await (const chunk of input) {
    let from = 0;
    for (let index = 0; index <= chunk.length; index++) {
      if (index !== chunk.length && chunk[index] !== 10) continue;
      const part = chunk.subarray(from, index);
      bytes += part.length;
      if (bytes > MIXED_MAX_MESSAGE) throw new MixedFailure("invalid_request");
      if (part.length) chunks.push(part);
      if (index < chunk.length && (await line())) return;
      from = index + 1;
    }
  }
  if (bytes) throw new MixedFailure("invalid_request"); // no unterminated final command
  throw new MixedFailure("invalid_state"); // EOF is cancellation, never a successful explicit close
}
