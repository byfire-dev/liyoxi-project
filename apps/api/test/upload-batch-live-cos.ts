// Task-private Provider HTTP boundary. It never reads or writes business tables.
import { createHash, randomUUID } from "node:crypto";
import type { Runtime } from "@liyoxi/services";
import type { FakeStorage } from "@liyoxi/services/testing";

type Storage = Runtime["providers"]["storage"];
type Ref = Pick<Parameters<Storage["head"]>[0], "bucket" | "key">;
type Grant = {
  prefix: string;
  bucket: string;
  accessKeyId: string;
  expiresAt: Date;
};
type Part = { bytes: Uint8Array; etag: string };
type Upload = { key: string; parts: Map<number, Part> };
const location = "test-media-1250000000";
const xml = (text: string) =>
  text.replace(
    /[<>&"']/g,
    (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!,
  );
const document = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "Content-Type": "application/xml", "Access-Control-Allow-Origin": "*", ...headers },
  });
const rejected = (code: string, status = 403) =>
  document(`<Error><Code>${code}</Code></Error>`, status);
const slot = (ref: Ref) => `${ref.bucket}/${ref.key}`;
const etag = (bytes: Uint8Array) =>
  `"${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}"`;

async function body(request: Request, max: number) {
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    if (reader)
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > max) throw new Error("Provider fixture body exceeded its limit");
        chunks.push(chunk.value);
      }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    return result;
  } finally {
    await reader?.cancel().catch(() => undefined);
    reader?.releaseLock();
  }
}

export function createOutputBatchCosStorage(options: {
  real: Storage;
  fake: FakeStorage;
  now(): Date;
}) {
  const { real, fake, now } = options;
  const prefixes = new Set<string>();
  const owned = new Set<string>();
  const grants = new Map<string, Grant>();
  const uploads = new Map<string, Upload>();
  const requests: { method: string; key: string; partNumber: number | null }[] = [];
  let closed = false;
  const usesFake = (ref: Ref) =>
    owned.has(slot(ref)) ||
    (ref.bucket === "media" && [...prefixes].some((p) => ref.key.startsWith(p)));

  // The borrowed real driver is closed only by its original Runtime owner.
  const storage: Storage = {
    ...real,
    capabilities: { ...real.capabilities, sts: true },
    uploadLocation: fake.uploadLocation,
    async issueSts(input) {
      if (!/^incoming\/b[0-9a-f-]{36}\/$/.test(input.keyPrefix) || input.bucket !== "media")
        return real.issueSts(input);
      const result = await fake.issueSts(input);
      if (result.ok) {
        prefixes.add(input.keyPrefix);
        grants.set(result.value.sessionToken, {
          prefix: input.keyPrefix,
          bucket: location,
          accessKeyId: result.value.accessKeyId,
          expiresAt: result.value.expiresAt,
        });
      }
      return result;
    },
    head: (input) => (usesFake(input) ? fake.head(input) : real.head(input)),
    readPrefix: (input) => (usesFake(input) ? fake.readPrefix(input) : real.readPrefix(input)),
    presignGet: (input) => (usesFake(input) ? fake.presignGet(input) : real.presignGet(input)),
    delete: (input) => (usesFake(input) ? fake.delete(input) : real.delete(input)),
    async copy(input) {
      if (!usesFake(input.src)) return real.copy(input);
      const result = await fake.copy(input);
      if (result.ok) owned.add(slot(input.dst));
      return result;
    },
    putObject: (input) => (usesFake(input) ? fake.putObject(input) : real.putObject(input)),
  };

  return {
    storage,
    requests: () => requests.map((r) => ({ ...r })),
    /** A derived destination may be registered only from an already owned source object. */
    rememberDerived(source: Ref, destination: Ref) {
      if (!owned.has(slot(source))) throw new Error("Derived fixture lacks owned provenance");
      owned.add(slot(destination));
    },
    close() {
      closed = true;
      uploads.clear();
      grants.clear();
      prefixes.clear();
      owned.clear();
    },
    async fetch(request: Request): Promise<Response> {
      if (closed) return rejected("Closed", 503);
      const url = new URL(request.url);
      if (request.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE",
            "Access-Control-Allow-Headers": "authorization,x-cos-security-token,content-type",
          },
        });
      if (request.method === "GET" && url.pathname === "/__stats")
        return Response.json({ requests: requests.map((r) => ({ ...r })), objects: owned.size });
      if (url.pathname.startsWith("/fake-read/")) {
        const target = `https://fake-storage.invalid/${url.pathname.slice(11)}${url.search}`;
        const result = fake.fetch(target);
        if (result.status !== 200) return new Response(null, { status: result.status });
        return new Response(Uint8Array.from(result.body), {
          headers: { "Content-Type": result.mime },
        });
      }
      const grant = grants.get(request.headers.get("x-cos-security-token") ?? "");
      const authorization = request.headers.get("authorization") ?? "";
      if (
        !grant ||
        grant.expiresAt <= now() ||
        !authorization.includes(`q-ak=${grant.accessKeyId}&`)
      )
        return rejected("AccessDenied");
      let key: string;
      try {
        key = decodeURIComponent(url.pathname.slice(1));
      } catch {
        return rejected("InvalidKey");
      }
      const query = url.searchParams;
      if (request.method === "GET" && key === "" && query.has("uploads")) {
        if (query.get("prefix") !== grant.prefix || query.get("max-uploads") !== "1000")
          return rejected("InvalidPrefix");
        requests.push({ method: "ListUploads", key: grant.prefix, partNumber: null });
        const found = [...uploads].filter(([, upload]) => upload.key.startsWith(grant.prefix));
        return document(
          `<ListMultipartUploadsResult><Bucket>${grant.bucket}</Bucket><Prefix>${xml(grant.prefix)}</Prefix><IsTruncated>false</IsTruncated>${found.map(([id, upload]) => `<Upload><Key>${xml(upload.key)}</Key><UploadId>${id}</UploadId></Upload>`).join("")}</ListMultipartUploadsResult>`,
        );
      }
      if (
        !key.startsWith(grant.prefix) ||
        key.slice(grant.prefix.length).includes("/") ||
        key.includes("..")
      )
        return rejected("InvalidKey");
      const number = query.has("partNumber") ? Number(query.get("partNumber")) : null;
      requests.push({ method: request.method, key, partNumber: number });
      if (request.method === "POST" && query.has("uploads")) {
        const id = randomUUID();
        uploads.set(id, { key, parts: new Map() });
        return document(
          `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
        );
      }
      const uploadId = query.get("uploadId") ?? "";
      const upload = uploads.get(uploadId);
      if (!upload || upload.key !== key) return rejected("NoSuchUpload", 404);
      if (request.method === "GET") {
        if (query.get("max-parts") !== "1000") return rejected("InvalidParts");
        return document(
          `<ListPartsResult><IsTruncated>false</IsTruncated>${[...upload.parts]
            .sort(([a], [b]) => a - b)
            .map(
              ([n, p]) =>
                `<Part><PartNumber>${n}</PartNumber><ETag>${xml(p.etag)}</ETag><Size>${p.bytes.length}</Size></Part>`,
            )
            .join("")}</ListPartsResult>`,
        );
      }
      if (
        request.method === "PUT" &&
        Number.isInteger(number) &&
        number! >= 1 &&
        number! <= 10_000
      ) {
        const bytes = await body(request, 8 * 1024 * 1024);
        if (closed) return rejected("Closed", 503);
        const part = { bytes, etag: etag(bytes) };
        upload.parts.set(number!, part);
        return document("", 200, { ETag: part.etag });
      }
      if (request.method === "POST") {
        const completion = new TextDecoder().decode(await body(request, 64 * 1024));
        if (closed) return rejected("Closed", 503);
        if (/<!/.test(completion)) return rejected("InvalidXML", 400);
        const parts = [
          ...completion.matchAll(
            /<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag><\/Part>/g,
          ),
        ];
        if (parts.length !== upload.parts.size || parts.length === 0)
          return rejected("InvalidParts", 400);
        const selected: Part[] = [];
        for (const [index, part] of parts.entries()) {
          const actual = upload.parts.get(Number(part[1]));
          if (Number(part[1]) !== index + 1 || !actual || xml(actual.etag) !== part[2])
            return rejected("InvalidParts", 400);
          selected.push(actual);
        }
        const bytes = new Uint8Array(selected.reduce((sum, p) => sum + p.bytes.length, 0));
        let offset = 0;
        for (const part of selected) {
          bytes.set(part.bytes, offset);
          offset += part.bytes.length;
        }
        const digest = fake.put({ bucket: "media", key }, bytes, "video/mp4");
        uploads.delete(uploadId);
        return document(
          `<CompleteMultipartUploadResult><ETag>${xml(digest)}</ETag></CompleteMultipartUploadResult>`,
        );
      }
      if (request.method === "DELETE") {
        uploads.delete(uploadId);
        return new Response(null, { status: 204 });
      }
      return rejected("Unsupported", 400);
    },
  };
}
