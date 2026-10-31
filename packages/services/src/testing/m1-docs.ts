// Owned technical fixture and read-only proof. Never used by production composition.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { Clock, QueueChannel, QueueConsumer, Tx } from "../kernel/index.js";
import { createQueueChannel } from "../kernel/index.js";
import type { Runtime } from "../runtime.js";
import type { LicenseRenderingEngine } from "../ops/index.js";
import { createLicensePdfRenderer } from "../docs/index.js";
import { createPlatformCertEsign } from "../providers/index.js";
import { createTestMaterial } from "./esign-material.js";
import { createTestLicenseTemplateCatalog } from "./license-render.js";

export function createM1LicenseRendering(clock: Clock, fontDir?: string): LicenseRenderingEngine {
  const fixture = createTestMaterial(clock.now());
  const renderer = createLicensePdfRenderer({
    fontDir: fontDir ?? resolve(import.meta.dirname, "../../../../infra/docker/server/fonts"),
    catalog: createTestLicenseTemplateCatalog(),
  });
  const signer = createPlatformCertEsign({ clock, loadMaterial: async () => fixture.material });
  let closing: Promise<void> | undefined;
  return {
    renderer,
    signer: signer.provider,
    close: () =>
      (closing ??= Promise.allSettled([renderer.close(), signer.close()]).then(() => {
        fixture.material.p12.fill(0);
      })),
  };
}

/** Real BullMQ docs queue on this owned prefix, same two slots as the actual worker. */
export async function createM1DocsConsumer(
  runtime: Runtime,
  prefix: string,
  assertOwned: () => void,
  signal?: AbortSignal,
) {
  assertOwned();
  const channel: QueueChannel = createQueueChannel({
    redisUrl: runtime.env.REDIS_URL,
    prefix: `${prefix}bull`,
  });
  const pending = new Set<Promise<void>>();
  let stopping = false;
  let consumer: QueueConsumer | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      stopping = true;
      const errors: unknown[] = [];
      try {
        await consumer?.pause();
      } catch (error) {
        errors.push(error);
      }
      await Promise.allSettled([...pending]);
      for (const dispose of [() => consumer?.close(1000), () => channel.close()]) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "M1 docs实际任务或队列未完整关闭");
    })());
  try {
    const deadline = performance.now() + 2000;
    while (!(await channel.ping())) {
      assertOwned();
      signal?.throwIfAborted();
      if (performance.now() >= deadline) throw new Error("M1 docs队列未连接");
      await pause(25, undefined, { signal });
    }
    consumer = channel.consume<unknown>("docs", 2, async (raw) => {
      assertOwned();
      signal?.throwIfAborted();
      if (
        stopping ||
        !raw ||
        typeof raw !== "object" ||
        !("revisionId" in raw) ||
        typeof raw.revisionId !== "string" ||
        Object.keys(raw).length !== 1
      )
        throw new Error("M1 docs运输参数无效");
      const work = runtime.docsRender.process({ revisionId: raw.revisionId });
      pending.add(work);
      try {
        await work;
      } finally {
        pending.delete(work);
      }
    });
    consumer.start();
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}

type DocsDb = Pick<Tx, "licenseLetterRevision" | "licenseLetter" | "outboxEvent" | "fileRef">;
function ownedDocsScope(entityIds?: readonly string[]) {
  if (entityIds === undefined) return {};
  if (
    !entityIds.length ||
    entityIds.length > 1000 ||
    entityIds.some(
      (id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
    )
  )
    throw new Error("M1 授权证明需要非空有界主体范围");
  return { entityId: { in: [...new Set(entityIds)] } };
}
export async function readM1DocsBacklog(tx: DocsDb, entityIds?: readonly string[]) {
  const owned = ownedDocsScope(entityIds);
  const [docsPending, required] = await Promise.all([
    tx.licenseLetterRevision.count({
      where: {
        licenseLetter: { ...owned, status: { not: "voided" } },
        renderStatus: { in: ["queued", "rendering"] },
      },
    }),
    tx.licenseLetter.findMany({
      where: { ...owned, status: { not: "voided" } },
      select: {
        revisions: { orderBy: { revNo: "desc" }, take: 1, select: { renderStatus: true } },
      },
      orderBy: { id: "asc" },
      take: 1001,
    }),
  ]);
  if (required.length > 1000) throw new Error("M1 授权证明超过有界读取上限");
  // A historical failed version remains evidence; only the latest required version blocks readiness.
  const docsFailed = required.filter(
    (letter) => letter.revisions[0]?.renderStatus === "failed",
  ).length;
  return { docsPending, docsFailed };
}

/** Read actual immutable versions and object bytes; no writer/claim/queue access. */
export async function assertM1ReadyDocuments(
  runtime: Runtime,
  signal?: AbortSignal,
  entityIds?: readonly string[],
) {
  const owned = ownedDocsScope(entityIds);
  const revisions = await runtime.tx.run(async (tx) => {
    const pending = await readM1DocsBacklog(tx, entityIds);
    if (pending.docsPending || pending.docsFailed) throw new Error("M1 授权版次尚未实际ready");
    const required = await tx.licenseLetter.findMany({
      where: { ...owned, status: { not: "voided" } },
      include: { currentRevision: true, revisions: { orderBy: { revNo: "desc" }, take: 1 } },
      orderBy: { id: "asc" },
      take: 1001,
    });
    if (required.length > 1000) throw new Error("M1 授权证明超过有界读取上限");
    for (const letter of required) {
      const latest = letter.revisions[0];
      if (
        !latest ||
        latest.renderStatus !== "ready" ||
        !latest.fileId ||
        !latest.readyAt ||
        letter.currentRevisionId !== latest.id ||
        letter.currentRevision?.licenseLetterId !== letter.id ||
        letter.currentRevision.renderStatus !== "ready"
      )
        throw new Error("M1 必需授权信缺少最新ready版次或current");
    }
    // Historical ready artifacts still require integrity, including letters now legally voided.
    const rows = await tx.licenseLetterRevision.findMany({
      where: { renderStatus: "ready", licenseLetter: owned },
      include: { file: true, licenseLetter: { include: { currentRevision: true } } },
      orderBy: [{ licenseLetterId: "asc" }, { revNo: "desc" }],
      take: 1001,
    });
    if (rows.length > 1000) throw new Error("M1 授权证明超过有界读取上限");
    for (const row of rows) {
      const file = row.file,
        letter = row.licenseLetter;
      if (
        !file ||
        !row.fileId ||
        !row.pdfSha256 ||
        !row.platformSignedAt ||
        !row.readyAt ||
        file.status !== "stored" ||
        file.bucket !== "secure" ||
        file.category !== "legal_doc" ||
        file.scopeType !== "entity" ||
        file.entityId !== letter.entityId ||
        file.storeId !== null ||
        file.sha256 !== row.pdfSha256 ||
        file.ext !== "pdf" ||
        file.sizeBytes === null ||
        file.sizeBytes <= 0n ||
        file.sizeBytes > 1048576n ||
        !file.objectKey.endsWith(`/${row.pdfSha256}.pdf`)
      )
        throw new Error("M1 授权ready文件或归属不一致");
      if (row.signMode !== "platform_cert" || !row.certIssuer || !row.certSerial)
        throw new Error("M1 授权测试版次缺真实技术证书签署证据");
      if (
        !(await tx.fileRef.findFirst({
          where: {
            fileId: row.fileId,
            refType: "license_letter_revision",
            refId: row.id,
            role: "pdf",
            state: "live",
          },
        }))
      )
        throw new Error("M1 授权ready文件未关联版次");
      if (
        !(await tx.outboxEvent.findFirst({
          where: {
            eventType: "license_letter.issued",
            aggregateId: letter.id,
            payload: { path: ["revisionId"], equals: row.id },
            publishedAt: { not: null },
          },
        }))
      )
        throw new Error("M1 授权issued后续未完成");
    }
    return rows;
  });
  for (const row of revisions) {
    signal?.throwIfAborted();
    const file = row.file!;
    const bytes = await runtime.providers.storage.readObject({
      bucket: "secure",
      key: file.objectKey,
      maxBytes: 1048576,
      ...(file.etag ? { ifMatchEtag: file.etag } : {}),
      signal,
    });
    if (
      !bytes.ok ||
      BigInt(bytes.value.length) !== file.sizeBytes ||
      createHash("sha256").update(bytes.value).digest("hex") !== row.pdfSha256 ||
      Buffer.from(bytes.value.subarray(0, 5)).toString() !== "%PDF-"
    )
      throw new Error("M1 授权实际PDF字节或最终哈希不匹配");
  }
  return revisions.length;
}
