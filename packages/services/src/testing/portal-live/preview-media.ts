import { createHash, randomBytes } from "node:crypto";
import type { Clock } from "../../kernel/index.js";
import type { ObjectRef, StorageProvider } from "../../providers/types.js";
import type { FakeStorage } from "../providers/index.js";

export type PortalLiveMediaResult =
  | { status: 200; bytes: Uint8Array; mime: string; etag: string; expiresAt: string }
  | { status: 403 | 404 | 410 };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const slot = (ref: ObjectRef) => `${ref.bucket}/${ref.key}`;
const MAX_BYTES = 4 * 1024 * 1024;

/** Local capability transport over the real fake-provider presign protocol, not a cloud signature test. */
export function createPortalPreviewMedia(input: {
  runId: string;
  portalOrigin: string;
  clock: Clock;
  storage: FakeStorage;
}) {
  const prefix = `/__portal-live/${input.runId}/media/`;
  const owned = new Map<string, { sha: string; mime: string }>();
  const grants = new Map<string, { ref: ObjectRef; url: string; expiresAt: Date }>();
  let closed = false;
  const original = input.storage.presignGet.bind(input.storage);
  const presignGet: StorageProvider["presignGet"] = async (request) => {
    const result = await original(request);
    if (!result.ok || closed || !owned.has(slot(request))) return result;
    const target = `${prefix}${randomBytes(16).toString("hex")}`;
    grants.set(target, {
      ref: { bucket: request.bucket, key: request.key },
      url: result.value.url,
      expiresAt: new Date(result.value.expiresAt),
    });
    return { ...result, value: { ...result.value, url: `${input.portalOrigin}${target}` } };
  };
  return {
    // This wrapper shares the original object store and all its other provider methods.
    storage: { ...input.storage, presignGet } satisfies StorageProvider,
    own(ref: ObjectRef) {
      if (closed) throw new Error("PREVIEW_MEDIA_CLOSED");
      const object = input.storage.objects.get(slot(ref));
      if (!object || !object.body.length || object.body.length > MAX_BYTES)
        throw new Error("PREVIEW_MEDIA_OBJECT_INVALID");
      const value = { sha: hash(object.body), mime: object.mime };
      const previous = owned.get(slot(ref));
      if (previous && (previous.sha !== value.sha || previous.mime !== value.mime))
        throw new Error("PREVIEW_MEDIA_OBJECT_CHANGED");
      owned.set(slot(ref), value);
    },
    read(requestTarget: string): PortalLiveMediaResult {
      if (
        closed ||
        !requestTarget.startsWith(prefix) ||
        !/^[a-f0-9]{32}$/.test(requestTarget.slice(prefix.length))
      )
        return { status: 403 };
      const grant = grants.get(requestTarget);
      if (!grant) return { status: 403 };
      if (input.clock.now().getTime() >= grant.expiresAt.getTime()) return { status: 410 };
      const expected = owned.get(slot(grant.ref));
      if (!expected) return { status: 403 };
      // Do not infer readability from possession of the opaque proxy URL alone.
      const result = input.storage.fetch(grant.url);
      if (result.status !== 200) return result;
      if (
        result.body.length > MAX_BYTES ||
        hash(result.body) !== expected.sha ||
        result.mime !== expected.mime
      )
        return { status: 403 };
      return {
        status: 200,
        bytes: new Uint8Array(result.body),
        mime: result.mime,
        etag: `"${expected.sha}"`,
        expiresAt: grant.expiresAt.toISOString(),
      };
    },
    close() {
      closed = true;
      grants.clear();
      owned.clear();
    },
  };
}
