import { UPLOAD_CATEGORIES } from "@liyoxi/shared/uploads";
import { fileCategoryGuardPort, fileRefTypePort } from "./ports.js";
import type { DeliveryDownloadSignInput, MediaDeps } from "./context.js";
import { register, complete, refresh, cancel } from "./upload.js";
import { assertUsableForModel, getAdmin, getMerchant, createSigner, downloadUrls } from "./read.js";
import { link, release } from "./refs.js";
import { putSystemFile } from "./system.js";
import { createWechatImageHandlers, applyWechatImageResult } from "./wechat-image-audit.js";
import { createModerationHandlers } from "./handlers/moderation/handlers.js";
import { enqueueExtractedTextAudit } from "./handlers/moderation/queue.js";
import { createPromoteHandler } from "./promote.js";
import { createMediaJobAdmin } from "./jobs/admin.js";
import { createMediaJobs } from "./jobs/runner.js";
import { uuidv7, lockRows } from "../kernel/index.js";
import { owned, readableByStaff } from "./access.js";
import { bindFileRefTypes } from "./invariants.js";
import { createUploadBatches } from "./batches/service.js";
import { createBatchWorkerHooks } from "./batches/worker.js";
import { enqueueProbe, enqueueDerivation, productionFacts } from "./production.js";
import {
  enqueueTrailer,
  createProductionConvergence,
  retireDramaMedia,
} from "./production-playables.js";
import { createProbeHandler } from "./handlers/probe.js";
import { createRestampHandler } from "./handlers/restamp.js";
import { createTranscodeHandler } from "./handlers/transcode.js";
import { createWatermarkHandler } from "./handlers/watermark.js";
import { createNormalizeHandler } from "./handlers/normalize.js";
import type { BoundMediaDeps } from "./context.js";
import type { MediaConvergenceHandler } from "./jobs/types.js";
export function createMedia(options: MediaDeps) {
  const refTypes = options.assembly.portEntries(fileRefTypePort);
  const guards = options.assembly.portEntries(fileCategoryGuardPort);
  for (const [key, definition] of refTypes) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || Object.keys(definition.roles).length === 0)
      throw new TypeError(`文件引用登记不合格：${key}`);
    for (const [role, spec] of Object.entries(definition.roles))
      if (
        !/^[a-z][a-z0-9_]*$/.test(role) ||
        !spec.categories.length ||
        spec.categories.some((category) => !Object.hasOwn(UPLOAD_CATEGORIES, category))
      )
        throw new TypeError(`文件引用角色登记不合格：${key}/${role}`);
  }
  for (const key of guards.keys())
    if (!Object.hasOwn(UPLOAD_CATEGORIES, key))
      throw new TypeError(`文件分类守卫登记不合格：${key}`);
  bindFileRefTypes(refTypes);
  let batchWorker: ReturnType<typeof createBatchWorkerHooks> | undefined;
  const batchHooks = () => (batchWorker ??= createBatchWorkerHooks(deps));
  const deps: BoundMediaDeps = {
    ...options,
    production:
      options.production && options.batches
        ? {
            ...options.production,
            batchLockSiblings: (tx, batchId) => batchHooks().lockSiblings(tx, batchId),
            batchNeedsJob: (tx, input) => batchHooks().needsJob(tx, input),
            batchConverge: (tx, batchId) => batchHooks().converge(tx, batchId),
            productionChecked: (tx, input) => batchHooks().checked(tx, input),
          }
        : options.production,
    batchStored: options.batches ? (tx, fileId) => batchHooks().stored(tx, fileId) : undefined,
    batchRejected: options.batches ? (tx, fileId) => batchHooks().rejected(tx, fileId) : undefined,
    queueBatchProbe:
      options.production && options.batches
        ? (tx, fileId, batchId) => enqueueProbe(deps, tx, fileId, { parentBatchId: batchId })
        : undefined,
    refTypes,
    guards,
    queueProbe: options.production
      ? (tx, file) =>
          ["mp4", "mov", "m4a", "mp3", "wav", "aac"].includes(file.ext)
            ? enqueueProbe(deps, tx, file.id, { parentBatchId: file.uploadBatchId ?? undefined })
            : Promise.resolve(null)
      : undefined,
  };
  const signRead = createSigner(deps);
  let uploadBatches: ReturnType<typeof createUploadBatches> | undefined;
  const batchConvergence: MediaConvergenceHandler[] = options.batches
    ? [
        {
          parentType: "upload_batch",
          lockSiblings: batchHooks().lockSiblings,
          needed: (tx, job) =>
            batchHooks().needsJob(tx, {
              batchId: job.parentId!,
              fileId: job.subjectId,
            }),
          converge: batchHooks().converge,
        },
      ]
    : [];
  const jobs = createMediaJobs({
    tx: options.tx,
    clock: options.clock,
    channel: options.channel,
    ownerId: options.jobOwnerId ?? uuidv7(),
    handlers: [
      createPromoteHandler(deps),
      ...createWechatImageHandlers(deps),
      ...createModerationHandlers(deps),
      createProbeHandler(deps),
      createRestampHandler(deps),
      createTranscodeHandler(deps),
      createWatermarkHandler(deps),
      createNormalizeHandler(deps),
      ...(options.jobHandlers ?? []),
    ],
    convergenceHandlers: [
      ...createProductionConvergence(deps).filter(
        (handler) => !options.batches || handler.parentType !== "upload_batch",
      ),
      ...batchConvergence,
      ...(options.jobConvergenceHandlers ?? []),
    ],
  });
  return {
    enqueueExtractedTextAudit: (
      tx: Parameters<typeof enqueueExtractedTextAudit>[1],
      input: Parameters<typeof enqueueExtractedTextAudit>[2],
    ) => enqueueExtractedTextAudit(deps, tx, input),
    get uploadBatches() {
      return (uploadBatches ??= createUploadBatches(deps));
    },
    enqueueProbe: (
      tx: Parameters<typeof enqueueProbe>[1],
      fileId: string,
      options: Parameters<typeof enqueueProbe>[3] = {},
    ) => enqueueProbe(deps, tx, fileId, options),
    normalize: (tx: Parameters<typeof enqueueDerivation>[1], fileId: string) =>
      enqueueDerivation(deps, tx, fileId, "normalize"),
    restamp: (tx: Parameters<typeof enqueueDerivation>[1], fileId: string) =>
      enqueueDerivation(deps, tx, fileId, "restamp"),
    enqueueTrailer: (
      tx: Parameters<typeof enqueueTrailer>[1],
      input: Parameters<typeof enqueueTrailer>[2],
    ) => enqueueTrailer(deps, tx, input),
    productionFacts,
    assertUsableForModel,
    retireDramaMedia: (
      tx: Parameters<typeof retireDramaMedia>[1],
      dramaId: string,
      options: Parameters<typeof retireDramaMedia>[3],
    ) => retireDramaMedia(deps, tx, dramaId, options),
    register: (...args: Parameters<typeof register> extends [unknown, ...infer A] ? A : never) =>
      register(deps, ...args),
    complete: (
      actor: Parameters<typeof complete>[1],
      fileId: string,
      options: Parameters<typeof complete>[3] = {},
    ) => complete(deps, actor, fileId, options),
    completeAdmin: async (
      actor: Parameters<typeof complete>[1],
      fileId: string,
      options: Parameters<typeof complete>[3] = {},
    ) => {
      return complete(deps, actor, fileId, options, true);
    },
    refresh: (...args: Parameters<typeof refresh> extends [unknown, ...infer A] ? A : never) =>
      refresh(deps, ...args),
    cancel: (...args: Parameters<typeof cancel> extends [unknown, ...infer A] ? A : never) =>
      cancel(deps, ...args),
    cancelAdmin: (
      actor: Parameters<typeof cancel>[1],
      fileId: string,
      options: Parameters<typeof cancel>[3] = {},
    ) => cancel(deps, actor, fileId, options, true),
    getMerchant: (
      ...args: Parameters<typeof getMerchant> extends [unknown, ...infer A] ? A : never
    ) => getMerchant(deps, ...args),
    getAdmin: (...args: Parameters<typeof getAdmin> extends [unknown, ...infer A] ? A : never) =>
      getAdmin(deps, ...args),
    link: (...args: Parameters<typeof link> extends [unknown, ...infer A] ? A : never) =>
      link(deps, ...args),
    release: (...args: Parameters<typeof release> extends [unknown, ...infer A] ? A : never) =>
      release(deps, ...args),
    putSystemFile: (
      ...args: Parameters<typeof putSystemFile> extends [unknown, ...infer A] ? A : never
    ) => putSystemFile(deps, ...args),
    signRead: async (input: Parameters<typeof signRead>[0]) => (await signRead(input)).signed,
    signDeliveryDownload: async (input: DeliveryDownloadSignInput) =>
      (
        await signRead(
          { fileId: input.fileId, audience: "merchant", disposition: "attachment" },
          { kind: "delivery-download", fileName: input.fileName },
        )
      ).signed,
    assertReadableByStaff: readableByStaff,
    assertOwned: owned,
    downloadUrls: (
      ...args: Parameters<typeof downloadUrls> extends [unknown, unknown, ...infer A] ? A : never
    ) => downloadUrls(deps, signRead, ...args),
    promote: jobs.run,
    scanPromote: jobs.scan,
    jobs,
    jobAdmin: createMediaJobAdmin({ tx: options.tx, clock: options.clock, jobs }),
    wakeCiJob: async (
      tx: Parameters<typeof applyWechatImageResult>[1],
      input: { mediaJobId: string; externalJobId: string },
    ): Promise<"processed" | "ignored"> => {
      await lockRows(tx, "media_job", [input.mediaJobId]);
      const count = await tx.mediaJob.updateMany({
        where: {
          id: input.mediaJobId,
          state: "submitted",
          provider: "ci",
          externalJobId: input.externalJobId,
        },
        data: { nextRunAt: options.clock.now(), updatedAt: options.clock.now() },
      });
      return count.count === 1 ? "processed" : "ignored";
    },
    applyWechatImageResult: (
      tx: Parameters<typeof applyWechatImageResult>[1],
      input: Parameters<typeof applyWechatImageResult>[2],
      ctx: Parameters<typeof applyWechatImageResult>[3],
    ) => applyWechatImageResult(deps, tx, input, ctx),
  };
}
export type Media = ReturnType<typeof createMedia>;
