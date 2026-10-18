import { createHash } from "node:crypto";
import { failed, INCOMING_PREFIX, ok } from "../../types.js";
import type { ObjectRef, StorageProvider } from "../../types.js";
import { unconfiguredStorage } from "../../unconfigured.js";

type Method = "head" | "readTo" | "putStream";
interface Stored {
  body: Uint8Array;
  mime: string;
  etag: string;
  contentIdentity?: string;
}
type FixtureStorage = StorageProvider & {
  put(ref: ObjectRef, body: Uint8Array, mime: string): string;
  callsOf(method: Method): { input: unknown }[];
};
const slot = (ref: ObjectRef) => `${ref.bucket}/${ref.key}`;
const sha256 = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
const boundedSize = (size: number) =>
  Number.isSafeInteger(size) && size > 0 && size <= 2 * 1024 ** 3;
const canceled = () => failed("unavailable", "媒体测试存储流已取消");

/** 仅供本模块的 UNIX/工作区测试；未用能力明确失败，不依赖数据库造数模块。 */
export function createFakeStorage(): FixtureStorage {
  const objects = new Map<string, Stored>();
  const calls: { method: Method; input: unknown }[] = [];
  function put(ref: ObjectRef, body: Uint8Array, mime: string) {
    const copy = new Uint8Array(body),
      etag = `"${sha256(copy).slice(0, 32)}"`;
    objects.set(slot(ref), { body: copy, mime, etag });
    return etag;
  }
  return {
    ...unconfiguredStorage,
    status: "fake",
    configured: true,
    put,
    callsOf: (method) => calls.filter((call) => call.method === method),
    async head(input) {
      calls.push({ method: "head", input });
      if (input.signal?.aborted) return canceled();
      const stored = objects.get(slot(input));
      return ok(
        stored
          ? { exists: true, size: stored.body.length, mime: stored.mime, etag: stored.etag }
          : { exists: false, size: 0 },
      );
    },
    async readTo(input) {
      calls.push({ method: "readTo", input });
      if (input.signal.aborted) return canceled();
      const stored = objects.get(slot(input));
      if (
        !boundedSize(input.expectedSize) ||
        !boundedSize(input.maxBytes) ||
        input.expectedSize > input.maxBytes ||
        !stored ||
        stored.etag !== input.ifMatchEtag ||
        stored.body.length !== input.expectedSize
      )
        return failed("rejected", "媒体测试对象流与预期不一致");
      try {
        for (let offset = 0; offset < stored.body.length; offset += 64 * 1024) {
          if (input.signal.aborted) return canceled();
          await input.sink(stored.body.slice(offset, offset + 64 * 1024));
        }
        if (input.signal.aborted) return canceled();
        return ok({ size: stored.body.length, sha256: sha256(stored.body) });
      } catch {
        return failed("unavailable", "媒体测试对象流未完成");
      }
    },
    async putStream(input) {
      calls.push({ method: "putStream", input });
      if (input.signal.aborted) return canceled();
      if (
        !boundedSize(input.size) ||
        !/^[a-f0-9]{64}$/.test(input.sha256) ||
        !/^[a-f0-9]{64}$/.test(input.contentIdentity) ||
        input.ifAbsent !== true ||
        input.key.startsWith(INCOMING_PREFIX)
      )
        return failed("rejected", "媒体测试对象流参数不合格");
      const parts: Uint8Array[] = [],
        hash = createHash("sha256");
      let length = 0;
      try {
        for await (const part of input.body(input.signal)) {
          if (input.signal.aborted) return canceled();
          if (
            !(part instanceof Uint8Array) ||
            part.byteLength > 1024 ** 2 ||
            length + part.byteLength > input.size
          )
            return failed("rejected", "媒体测试对象流超限");
          length += part.byteLength;
          hash.update(part);
          parts.push(new Uint8Array(part));
        }
      } catch {
        return failed("unavailable", "媒体测试对象流未完成");
      }
      if (input.signal.aborted) return canceled();
      if (length !== input.size || hash.digest("hex") !== input.sha256)
        return failed("rejected", "媒体测试对象流长度或hash不一致");
      const existing = objects.get(slot(input));
      if (existing)
        return existing.contentIdentity === input.contentIdentity &&
          existing.body.length === input.size &&
          sha256(existing.body) === input.sha256
          ? ok({ etag: existing.etag, size: input.size })
          : failed("rejected", "媒体测试目标归属不一致");
      const body = new Uint8Array(input.size);
      let offset = 0;
      for (const part of parts) {
        body.set(part, offset);
        offset += part.length;
      }
      const etag = put(input, body, input.contentType);
      objects.get(slot(input))!.contentIdentity = input.contentIdentity;
      return ok({ etag, size: input.size });
    },
  };
}
