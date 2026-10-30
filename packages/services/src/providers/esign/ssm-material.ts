import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { AbstractClient } from "tencentcloud-sdk-nodejs-common";
import type { ClientConfig } from "tencentcloud-sdk-nodejs-common";
import { z } from "zod";
import type { P12Material } from "./material.js";
import { SSM_HOST, SsmAgent } from "./ssm-agent.js";

const configSchema = z.strictObject({
  region: z.string().regex(/^ap-[a-z]+(?:-[a-z]+)*$/),
  secretName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  versionId: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
    .refine((value) => !/^ssm_/i.test(value)),
  stsCredentialsFile: z
    .string()
    .max(4096)
    .refine((value) => isAbsolute(value) && normalize(value) === value && !/[\p{Cc}]/u.test(value)),
});
export type EsignSsmConfig = Readonly<z.infer<typeof configSchema>>;
const credentialSchema = z.strictObject({
  TmpSecretId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  TmpSecretKey: z.string().regex(/^[\x21-\x7e]{1,256}$/),
  Token: z.string().regex(/^[\x21-\x7e]{1,12000}$/),
  ExpiredTime: z.number().int().positive().refine(Number.isSafeInteger),
});
const payloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  p12Base64: z
    .string()
    .min(4)
    .max(32768)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  passphrase: z.string().min(1).max(1024),
});
const fail = () => new Error("机构签署材料暂不可用");
function check(signal: AbortSignal) {
  if (signal.aborted) throw fail();
}

/** Each request reads a fresh inode; no cached credentials or metadata/permanent-AK fallback. */
async function readCredential(file: string, signal: AbortSignal, now: () => Date) {
  check(signal);
  const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(16385);
  try {
    check(signal);
    const stat = await handle.stat();
    const uid = process.geteuid?.();
    if (
      !stat.isFile() ||
      stat.size > 16384 ||
      ![0o400, 0o600].includes(stat.mode & 0o7777) ||
      (stat.uid !== 0 && stat.uid !== uid)
    )
      throw fail();
    let size = 0;
    while (size < buffer.length) {
      check(signal);
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, null);
      check(signal);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (!size || size > 16384) throw fail();
    const raw: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size)),
    );
    const value = credentialSchema.parse(raw);
    const time = now().getTime();
    if (
      !Number.isFinite(time) ||
      value.ExpiredTime * 1000 - time <= 30000 ||
      !Number.isSafeInteger(value.ExpiredTime * 1000)
    )
      throw fail();
    return value;
  } finally {
    buffer.fill(0);
    await handle.close();
  }
}
export interface SsmMaterialOptions {
  readonly clock: { now(): Date };
  /** May only shorten the fixed 6s request budget. Regular-file IO is awaited, not abandoned. */
  readonly timeoutMs?: number;
  /** Private real-HTTP protocol tests only; production composition does not override. */
  readonly createClient?: (config: ClientConfig) => Pick<AbstractClient, "request">;
}

/** Construct only in the worker. This constructor performs no file/network IO. */
export function createSsmMaterialSource(config: EsignSsmConfig, options: SsmMaterialOptions) {
  const parsed = configSchema.safeParse(config);
  const timeoutMs = options.timeoutMs ?? 6000;
  if (!parsed.success || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 6000)
    throw new TypeError("机构签署材料配置不合法");
  const settings = parsed.data;
  const agent = new SsmAgent();
  const controllers = new Set<AbortController>();
  const pending = new Set<Promise<P12Material>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  async function run(input: { readonly signal: AbortSignal }): Promise<P12Material> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    controllers.add(controller);
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    const timer = setTimeout(abort, timeoutMs);
    try {
      const credential = await readCredential(settings.stsCredentialsFile, controller.signal, () =>
        options.clock.now(),
      );
      check(controller.signal);
      if (credential.ExpiredTime * 1000 - options.clock.now().getTime() <= 30000) throw fail();
      const clientConfig: ClientConfig = {
        credential: {
          secretId: credential.TmpSecretId,
          secretKey: credential.TmpSecretKey,
          token: credential.Token,
        },
        region: settings.region,
        profile: {
          signMethod: "TC3-HMAC-SHA256",
          httpProfile: {
            endpoint: SSM_HOST,
            protocol: "https://",
            reqMethod: "POST",
            reqTimeout: 6,
            agent,
          },
        },
      };
      const client =
        options.createClient?.(clientConfig) ??
        new AbstractClient(SSM_HOST, "2019-09-23", clientConfig);
      const response: unknown = await client.request(
        "GetSecretValue",
        { SecretName: settings.secretName, VersionId: settings.versionId },
        { signal: controller.signal },
      );
      check(controller.signal);
      if (
        !response ||
        typeof response !== "object" ||
        !("SecretName" in response) ||
        response.SecretName !== settings.secretName ||
        !("VersionId" in response) ||
        response.VersionId !== settings.versionId ||
        !("SecretString" in response) ||
        typeof response.SecretString !== "string" ||
        Buffer.byteLength(response.SecretString, "utf8") > 32768 ||
        ("SecretBinary" in response &&
          response.SecretBinary !== undefined &&
          response.SecretBinary !== null &&
          response.SecretBinary !== "")
      )
        throw fail();
      const payload = payloadSchema.parse(JSON.parse(response.SecretString) as unknown);
      const p12 = Buffer.from(payload.p12Base64, "base64");
      if (!p12.length || p12.length > 24576 || p12.toString("base64") !== payload.p12Base64) {
        p12.fill(0);
        throw fail();
      }
      check(controller.signal);
      return { p12, passphrase: payload.passphrase };
    } catch {
      throw fail();
    } finally {
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
      controllers.delete(controller);
    }
  }
  return {
    loadMaterial(input: { readonly signal: AbortSignal }): Promise<P12Material> {
      if (closed) return Promise.reject(fail());
      const work = run(input);
      pending.add(work);
      void work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      for (const controller of controllers) controller.abort();
      closing = Promise.allSettled([...pending]).then(() => {
        agent.destroy();
      });
      return closing;
    },
  };
}
