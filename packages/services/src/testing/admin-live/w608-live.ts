import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { setTimeout as waitFor } from "node:timers/promises";
import { ChecklistItemsSchema } from "@liyoxi/contract";
import type { Runtime } from "../../runtime.js";
import type { MediaProvider, StorageProvider } from "../../providers/types.js";
import { failed } from "../../providers/types.js";
import { createIdentityContext, uuidv7 } from "../../kernel/index.js";
import { createDelivery } from "../../delivery/index.js";
import { createPublish } from "../../publish/index.js";
import { createProfile } from "../../profile/index.js";
import { createTenant } from "../../tenant/index.js";
import { createSla } from "../../sla/index.js";
import { loadKeyring } from "../../security/index.js";
import { sampleStaffContext } from "../approval.js";
import { createFakeProviders, createFakeWechat } from "../providers/index.js";
import type { FakeProviders } from "../providers/index.js";
import {
  installZipPackageFixture,
  inspectZipFixture,
  zipFixtureCrc64,
} from "../zip-package-fixture.js";
import { assertW608LiveScope, W608LiveCommandSchema } from "./w608-scope.js";
import type { W608LiveScope } from "./w608-scope.js";

const hash = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
function guard(value: unknown): asserts value {
  if (!value) throw new Error("W608 owned production evidence mismatch");
}

async function currentZip(runtime: Runtime, scope: W608LiveScope) {
  await assertW608LiveScope(runtime, scope);
  return runtime.tx.run(async (tx) => {
    const release = await tx.deliveryRelease.findFirstOrThrow({
      where: {
        deliveryTicketId: scope.ticketId,
        orderItemId: scope.itemId,
        entityId: scope.entityId,
        storeId: scope.storeId,
        state: "pushed",
        createdAt: { gte: new Date(scope.startedAt) },
      },
      orderBy: { releaseNo: "desc" },
    });
    const bundle = await tx.zipBundle.findUniqueOrThrow({
      where: { ownerType_ownerId: { ownerType: "delivery_release", ownerId: release.id } },
    });
    const job = await tx.mediaJob.findUniqueOrThrow({
      where: { dedupeKey: `zip:${bundle.id}:${bundle.zipGen}` },
    });
    guard(
      job.kind === "zip_package" &&
        job.parentId === bundle.id &&
        job.createdAt >= new Date(scope.startedAt),
    );
    return { release, bundle, job };
  });
}

/** A new facade, never a global failure switch. Other producers retain their original transport. */
export function createW608ZipIo(input: {
  runtime: () => Runtime;
  scope: W608LiveScope;
  providers: FakeProviders;
  storage: StorageProvider;
}) {
  const local = createFakeProviders(),
    protocol = installZipPackageFixture(local, input.storage);
  const base = input.providers.media;
  let armed: string | undefined;
  const jobIds = new Set<string>(),
    remoteIds = new Map<string, string>();
  const remoteId = (id: string) => `w608-${input.scope.runId}-${id}`;
  const ownedKey = (key: string) => key.startsWith(`pkg/${input.scope.itemId}/`);
  const media: MediaProvider = {
    ...base,
    async pack(value) {
      if (!ownedKey(value.dstKey)) return base.pack(value);
      const { release, bundle, job } = await currentZip(input.runtime(), input.scope);
      guard(
        value.userData === `${job.id}:${job.attemptNo}` &&
          value.dstKey ===
            `pkg/${input.scope.itemId}/${release.id}-${bundle.zipGen}/${job.id}-${job.attemptNo}.zip`,
      );
      jobIds.add(job.id);
      if (armed === job.id) {
        armed = undefined;
        return failed("rejected", "owned W608 compression transport rejection");
      }
      const result = await local.media.pack(value);
      if (!result.ok) return result;
      const id = remoteId(result.value.jobId);
      remoteIds.set(id, result.value.jobId);
      return { ...result, value: { ...result.value, jobId: id } };
    },
    async describe(value) {
      const id = remoteIds.get(value.jobId);
      if (!id) return base.describe!(value);
      const result = await local.media.describe!({ ...value, jobId: id });
      return result.ok ? { ...result, value: { ...result.value, jobId: value.jobId } } : result;
    },
    async find(value) {
      if (!jobIds.has(value.userData.split(":")[0]!)) return base.find!(value);
      const result = await local.media.find!(value);
      if (!result.ok || !result.value.job) return result;
      const job = result.value.job,
        id = remoteId(job.jobId);
      remoteIds.set(id, job.jobId);
      return { ...result, value: { ...result.value, job: { ...job, jobId: id } } };
    },
    previewZip: (value) =>
      ownedKey(value.src.key) ? local.media.previewZip!(value) : base.previewZip!(value),
    cancel: (value) =>
      remoteIds.has(value.jobId)
        ? local.media.cancel!({ ...value, jobId: remoteIds.get(value.jobId)! })
        : base.cancel!(value),
  };
  return {
    media,
    storage: {
      ...input.storage,
      head: (value: Parameters<StorageProvider["head"]>[0]) =>
        value.bucket === "media" && ownedKey(value.key)
          ? protocol.storage.head(value)
          : input.storage.head(value),
    },
    async armFailure() {
      const { bundle, job } = await currentZip(input.runtime(), input.scope);
      guard(
        !armed && bundle.zipState === "building" && job.state === "queued" && job.attemptNo === 0,
      );
      armed = job.id;
      return { zipGen: bundle.zipGen, armed: true as const };
    },
    close() {
      armed = undefined;
      jobIds.clear();
      remoteIds.clear();
      protocol.close();
    },
  };
}

/** Borrows the already configured live Runtime and actual MP4; only this two-episode scope runs. */
export async function createW608LiveController(input: {
  runtime: Runtime;
  scope: W608LiveScope;
  video: { path: string; sha256: string; size: number };
  zipIo: Pick<ReturnType<typeof createW608ZipIo>, "armFailure">;
  signal?: AbortSignal;
}) {
  const { runtime } = input,
    scope = await assertW608LiveScope(runtime, input.scope);
  const lifetime = new AbortController(),
    signal = input.signal ? AbortSignal.any([input.signal, lifetime.signal]) : lifetime.signal;
  const path = await realpath(input.video.path);
  guard(path.includes(`/admin-live-${scope.runId}/`) && path.endsWith("/video.mp4"));
  const bytes = await readFile(path);
  guard(
    bytes.length === input.video.size &&
      bytes.length <= 200 * 1024 * 1024 &&
      hash(bytes) === input.video.sha256,
  );
  const tenant = createTenant(runtime);
  const profile = createProfile({
    ...runtime,
    tenant,
    approval: runtime.approval,
    keyring: () => loadKeyring(runtime.env),
    wechat: createFakeWechat(),
    currentOpenid: async () => "w608-owned",
  });
  const delivery = createDelivery({
    ...runtime,
    profile,
    publish: createPublish(runtime),
    sla: createSla(runtime),
    ensureLicenseReadiness: runtime.licenseLetters.ensureLicenseReadiness,
    samplePlayback: (entityId) =>
      runtime.config.flags.isEnabled("weapp.video.sample.enabled", { entityId }),
  });
  const actor = async (id: string) => ({
    identity: createIdentityContext({
      actor: { type: "staff" as const, id, client: "admin" as const },
    }),
    staff: await runtime.tx.run((tx) =>
      sampleStaffContext(tx, id, { stepUpAt: runtime.clock.now() }),
    ),
  });
  const viewer = {
    ctx: createIdentityContext({
      actor: {
        type: "merchant" as const,
        id: scope.merchantUserId,
        client: "weapp" as const,
        role: "owner" as const,
      },
      entityId: scope.entityId,
      storeId: scope.storeId,
    }),
    membership: {
      memberId: scope.memberId,
      entityId: scope.entityId,
      storeId: scope.storeId,
      role: "owner" as const,
      storeMode: "active" as const,
    },
  };
  const checks = async (code: string) => {
    const template = await runtime.tx.run((tx) =>
      tx.checklistTemplate.findFirstOrThrow({ where: { code, status: "active" } }),
    );
    return {
      checklistVersionNo: template.versionNo,
      results: ChecklistItemsSchema.parse(template.items).map(({ key }) => ({
        key,
        result: "pass" as const,
      })),
    };
  };
  const owned = new Map<string, { token: string; category: "sample_video" | "final_episode" }>();
  let sampleFile: string | undefined, finalFile: string | undefined, sampleId: string | undefined;
  let busy = false,
    closed = false;
  let pending: Promise<unknown> | undefined;
  async function file(fileId: string) {
    const own = owned.get(fileId);
    guard(own);
    return runtime.tx.run(async (tx) => {
      const f = await tx.fileObject.findUniqueOrThrow({ where: { id: fileId } });
      const record = await tx.productionRecord.findUniqueOrThrow({ where: { fileId } });
      guard(
        f.clientToken === own.token &&
          f.category === own.category &&
          f.storeId === scope.storeId &&
          f.entityId === scope.entityId &&
          f.uploadActorId === scope.uploaderId &&
          f.uploadClient === "admin" &&
          f.createdAt >= new Date(scope.startedAt) &&
          record.orderItemId === scope.itemId &&
          record.source === "manual_upload" &&
          record.derivedFromFileId === null,
      );
      return f;
    });
  }
  async function upload(category: "sample_video" | "final_episode", episodeNo: number) {
    const who = await actor(scope.uploaderId),
      token = `w608_${scope.runId}_${uuidv7().slice(-12)}`;
    const registered = await runtime.media.register(who, {
      category,
      storeId: scope.storeId,
      production: {
        kind: category === "sample_video" ? "sample" : "final",
        orderItemId: scope.itemId,
        episodeNo,
        aiUsage: { used: false, tools: [] },
      },
      files: [
        {
          fileName: `W608_第${episodeNo}集.mp4`,
          sizeBytes: String(bytes.length),
          clientToken: token,
        },
      ],
    });
    const entry = registered.items[0];
    guard(registered.items.length === 1 && entry?.post && entry.clientToken === token);
    const url = new URL(entry.post.url);
    guard(
      url.origin === "http://127.0.0.1:9100" &&
        url.pathname === "/lyx-local-media" &&
        entry.post.fields.key === entry.key &&
        entry.key.startsWith(`incoming/${entry.fileId}/`),
    );
    owned.set(entry.fileId, { token, category });
    const form = new FormData();
    for (const [key, value] of Object.entries(entry.post.fields)) form.append(key, value);
    form.append("file", new Blob([bytes], { type: "video/mp4" }), `W608_第${episodeNo}集.mp4`);
    guard((await fetch(url, { method: "POST", body: form, signal })).ok);
    await runtime.media.completeAdmin(who, entry.fileId);
    const promote = await runtime.tx.run((tx) =>
      tx.mediaJob.findUniqueOrThrow({ where: { dedupeKey: `promote:${entry.fileId}` } }),
    );
    guard(
      promote.kind === "promote" &&
        promote.subjectId === entry.fileId &&
        promote.state === "queued",
    );
    await runtime.media.promote({ jobId: promote.id });
    const stored = await file(entry.fileId);
    guard(stored.status === "stored" && stored.sizeBytes === BigInt(bytes.length));
    return entry.fileId;
  }
  async function finish(fileId: string, watermarked: boolean) {
    await file(fileId);
    const jobs = await runtime.tx.run((tx) =>
      tx.mediaJob.findMany({
        where: {
          subjectType: "file_object",
          subjectId: fileId,
          kind: { in: ["probe", "watermark_sample"] },
          state: { in: ["queued", "submitted"] },
          nextRunAt: { lte: runtime.clock.now() },
          deadlineAt: { gt: runtime.clock.now() },
        },
        orderBy: [{ nextRunAt: "asc" }, { id: "asc" }],
        take: 8,
      }),
    );
    for (const job of jobs) {
      signal?.throwIfAborted();
      await runtime.media.jobs.run({ jobId: job.id });
    }
    const subscriber = runtime.assembly.subscriber("delivery.onProductionChecked");
    guard(subscriber);
    await runtime.tx.run(async (tx) => {
      const events = await tx.outboxEvent.findMany({
        where: {
          eventType: "media.production.checked",
          aggregateType: "production_record",
          aggregateId: fileId,
          entityId: scope.entityId,
          storeId: scope.storeId,
          occurredAt: { gte: new Date(scope.startedAt) },
        },
        orderBy: { seq: "asc" },
        take: 8,
      });
      for (const event of events)
        await subscriber.handle(tx, {
          id: event.id,
          type: event.eventType,
          payload: event.payload as Readonly<Record<string, unknown>>,
        });
    });
    const facts = await runtime.tx.run((tx) => runtime.media.deliveryProductionFacts(tx, fileId));
    const failedJobs = await runtime.tx.run((tx) =>
      tx.mediaJob.count({
        where: {
          subjectId: fileId,
          kind: { in: ["probe", "watermark_sample"] },
          state: { in: ["failed", "canceled"] },
        },
      }),
    );
    guard(failedJobs === 0);
    return {
      fileId,
      ready: facts.ready && (!watermarked || !!facts.playable),
      playable: !!facts.playable,
    };
  }
  async function observeZip() {
    const { release, bundle, job } = await currentZip(runtime, scope);
    let archive: { fileCount: number; sizeBytes: number; sha256: string; crc64: string } | null =
      null;
    if (bundle.zipState === "ready") {
      guard(bundle.zipFileId);
      const output = await runtime.tx.run((tx) =>
        tx.fileObject.findUniqueOrThrow({ where: { id: bundle.zipFileId! } }),
      );
      guard(
        output.status === "stored" &&
          output.bucket === "media" &&
          output.entityId === scope.entityId &&
          output.storeId === scope.storeId &&
          output.objectKey.startsWith(`pkg/${scope.itemId}/${release.id}-${bundle.zipGen}/`) &&
          output.sizeBytes &&
          output.sizeBytes <= 64n * 1024n * 1024n,
      );
      const read = await runtime.providers.storage.readObject({
        bucket: "media",
        key: output.objectKey,
        maxBytes: Number(output.sizeBytes),
      });
      guard(read.ok);
      const parsed = inspectZipFixture(read.value),
        sha256 = hash(read.value),
        crc64 = zipFixtureCrc64(read.value);
      guard(
        parsed.fileCount === 3 &&
          parsed.entries.some((entry) => entry.name === "发布清单.txt") &&
          crc64 === output.crc64 &&
          (!output.sha256 || sha256 === output.sha256) &&
          read.value.length === Number(output.sizeBytes),
      );
      archive = { fileCount: parsed.fileCount, sizeBytes: read.value.length, sha256, crc64 };
    }
    return {
      deliveryReleaseId: release.id,
      zipBundleId: bundle.id,
      zipState: bundle.zipState,
      zipGen: bundle.zipGen,
      zipFileId: bundle.zipFileId,
      jobState: job.state,
      archive,
    };
  }
  const execute = async (raw: unknown) => {
    const { action } = W608LiveCommandSchema.parse(raw);
    guard(!closed && !busy);
    busy = true;
    try {
      signal?.throwIfAborted();
      await assertW608LiveScope(runtime, scope);
      if (action === "upload_sample") {
        guard(!sampleFile);
        sampleFile = await upload("sample_video", 1);
        return { fileId: sampleFile };
      }
      if (action === "finish_sample") {
        guard(sampleFile);
        return await finish(sampleFile, true);
      }
      if (action === "confirm_sample") {
        guard(sampleFile && !sampleId && (await finish(sampleFile, true)).ready);
        const uploader = await actor(scope.uploaderId),
          qc = await actor(scope.managerId);
        const sample = await delivery.sampleCreate(
          uploader.identity,
          uploader.staff,
          scope.ticketId,
          { fileId: sampleFile, adSlots: [] },
        );
        sampleId = sample.sampleId;
        await delivery.sampleInspect(qc.identity, qc.staff, sampleId, await checks("qc.sample"));
        await delivery.samplePush(qc.identity, qc.staff, sampleId, {});
        const view = await delivery.merchantSample(viewer, scope.itemId),
          url = view.playable?.sources[0]?.url;
        guard(url);
        const response = await fetch(url, { signal });
        guard(response.ok);
        const downloaded = new Uint8Array(await response.arrayBuffer());
        const facts = await runtime.tx.run((tx) =>
          runtime.media.deliveryProductionFacts(tx, sampleFile!),
        );
        const rendition = (facts.playable?.renditions as { fileId?: string }[] | null)?.[0]?.fileId;
        guard(rendition && rendition !== sampleFile);
        const output = await runtime.tx.run((tx) =>
          tx.fileObject.findUniqueOrThrow({ where: { id: rendition } }),
        );
        guard(
          output.sha256 === hash(downloaded) &&
            output.sizeBytes === BigInt(downloaded.length) &&
            output.sha256 !== input.video.sha256,
        );
        await delivery.sampleConfirm(viewer, sampleId, {
          versionNo: 1,
          viewedVia: "weapp",
          hasViewed: true,
        });
        return { sampleId, physicalWatermarkVerified: true };
      }
      if (action === "upload_final") {
        guard(sampleId && !finalFile);
        finalFile = await upload("final_episode", 2);
        return { fileId: finalFile };
      }
      if (action === "finish_final") {
        guard(finalFile);
        return await finish(finalFile, false);
      }
      if (action === "inspect_package") {
        guard(sampleId && finalFile && (await finish(finalFile, false)).ready);
        const uploader = await actor(scope.uploaderId),
          qc = await actor(scope.managerId);
        const episodes = await delivery.episodeRegister(
          uploader.identity,
          uploader.staff,
          scope.ticketId,
          {
            items: [
              { episodeNo: 1, sampleId },
              { episodeNo: 2, fileId: finalFile },
            ],
          },
        );
        const checklist = await checks("qc.episode");
        await delivery.episodeInspect(qc.identity, qc.staff, scope.ticketId, {
          episodeOutputIds: episodes.items.map((e) => e.episodeOutputId),
          checklistVersionNo: checklist.checklistVersionNo,
          defaultResults: checklist.results,
        });
        await delivery.packageInspect(
          qc.identity,
          qc.staff,
          scope.ticketId,
          await checks("qc.package"),
        );
        return {
          ticketId: scope.ticketId,
          step: (await delivery.get(qc.staff, scope.ticketId)).step,
        };
      }
      if (action === "fail_next_zip") return await input.zipIo.armFailure();
      if (action === "run_zip") {
        const initial = await currentZip(runtime, scope),
          deadline = performance.now() + 10_000;
        for (let round = 0; round < 8; round++) {
          const current = await currentZip(runtime, scope);
          guard(
            current.bundle.zipGen === initial.bundle.zipGen && current.job.id === initial.job.id,
          );
          if (!["queued", "submitted"].includes(current.job.state)) return await observeZip();
          const wait = current.job.nextRunAt.getTime() - runtime.clock.now().getTime();
          guard(
            performance.now() + Math.max(0, wait) < deadline &&
              current.job.deadlineAt > runtime.clock.now(),
          );
          if (wait > 0) await waitFor(wait, undefined, { signal });
          signal?.throwIfAborted();
          await runtime.media.jobs.run({ jobId: current.job.id });
        }
        throw new Error("W608 ZIP exceeded eight owned job observations");
      }
      return await observeZip();
    } finally {
      busy = false;
    }
  };
  return {
    run(raw: unknown) {
      if (pending || closed) return Promise.reject(new Error("W608 control is busy or closed"));
      const operation = execute(raw);
      pending = operation;
      return operation.finally(() => {
        if (pending === operation) pending = undefined;
      });
    },
    async close() {
      closed = true;
      lifetime.abort();
      await pending?.catch(() => undefined);
      // Only objects belonging to this manifest and the actual produced files are reclaimed.
      const files = await runtime.tx.run((tx) =>
        tx.fileObject.findMany({
          where: {
            entityId: scope.entityId,
            storeId: scope.storeId,
            createdAt: { gte: new Date(scope.startedAt) },
            category: {
              in: [
                "sample_video",
                "final_episode",
                "sample_wm",
                "package_zip",
                "publish_list",
                "video_cover",
              ],
            },
          },
        }),
      );
      for (const f of files) {
        const result = await runtime.providers.storage.delete({
          bucket: f.bucket as "media" | "asset",
          key: f.objectKey,
        });
        guard(result.ok);
      }
    },
  };
}

export type W608ZipIo = ReturnType<typeof createW608ZipIo>;
export type W608LiveController = Awaited<ReturnType<typeof createW608LiveController>>;

/** Can run during server startup failure: only this run's exact poster, never a bucket sweep. */
export async function cleanupW608LivePoster(runtime: Runtime, raw: unknown) {
  const scope = await assertW608LiveScope(runtime, raw);
  const poster = await runtime.tx.run((tx) =>
    tx.fileObject.findUniqueOrThrow({ where: { id: scope.posterFileId } }),
  );
  guard(
    poster.category === "poster" &&
      poster.bucket === "pub" &&
      poster.objectKey === `poster/w608/${scope.runId}.png` &&
      poster.scopeType === "platform" &&
      poster.entityId === null &&
      poster.storeId === null &&
      poster.uploadActorType === "system" &&
      poster.createdAt >= new Date(scope.startedAt) &&
      poster.sha256 &&
      poster.sizeBytes &&
      poster.sizeBytes <= 1048576n,
  );
  const src = { bucket: "pub" as const, key: poster.objectKey };
  const head = await runtime.providers.storage.head(src);
  guard(head.ok);
  if (!head.value.exists) return { cleanedPoster: true, alreadyAbsent: true };
  guard(head.value.size === Number(poster.sizeBytes) && head.value.etag);
  const read = await runtime.providers.storage.readObject({
    ...src,
    maxBytes: Number(poster.sizeBytes),
    ifMatchEtag: head.value.etag,
  });
  guard(
    read.ok && read.value.length === Number(poster.sizeBytes) && hash(read.value) === poster.sha256,
  );
  guard((await runtime.providers.storage.delete(src)).ok);
  return { cleanedPoster: true, alreadyAbsent: false };
}
