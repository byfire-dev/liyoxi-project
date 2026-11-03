import { z } from "zod";
import type { MediaJob } from "@liyoxi/db";
import { lockRows } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { BoundMediaDeps } from "./context.js";
import type { JobOutcome, MediaJobHandler } from "./jobs/types.js";
import { createRemoteMediaHandler } from "./jobs/remote.js";
import { jobBudget } from "./jobs/policy.js";
import { ZipInputSchema, zipKeys, zipSourcesCurrent } from "./zip-types.js";
import { registerZipArtifact, uploadZipList } from "./zip-artifacts.js";
import { link } from "./refs.js";

const OutputSchema = z.strictObject({
  zipFileId: z.uuid(),
  publishListFileId: z.uuid().nullable(),
});
const failure = (code: string, retryable = false): JobOutcome => ({
  state: "failed",
  failure: { code, retryable },
});
export function createZipHandler(deps: BoundMediaDeps): MediaJobHandler {
  const provider = deps.zipProvider;
  const artifacts = (tx: Tx, job: MediaJob) => {
    const input = ZipInputSchema.parse(job.input),
      keys = zipKeys(input, job);
    return tx.fileObject.findMany({
      where: { bucket: "media", objectKey: { in: [keys.zip, keys.list] } },
    });
  };
  const inputCurrent = async (tx: Tx, input: ReturnType<typeof ZipInputSchema.parse>) => {
    const bundle = await tx.zipBundle.findUnique({ where: { id: input.zipBundleId } });
    return (
      bundle?.zipState === "building" &&
      bundle.zipGen === input.zipGen &&
      bundle.ownerType === input.ownerType &&
      bundle.ownerId === input.ownerId &&
      (await zipSourcesCurrent(tx, input))
    );
  };
  const current: MediaJobHandler["current"] = async (tx, job) => {
    const input = ZipInputSchema.parse(job.input);
    if (
      job.subjectType !== "zip_bundle" ||
      job.subjectId !== input.zipBundleId ||
      job.parentType !== "zip_bundle" ||
      job.parentId !== input.zipBundleId
    )
      return false;
    const files = await artifacts(tx, job);
    await lockRows(tx, "file_object", [
      ...input.items.map((item) => item.fileId),
      ...files.map((file) => file.id),
    ]);
    if (await inputCurrent(tx, input)) return true;
    // An already accepted remote task must still be observed within its original deadline.
    // Once its unique ZIP has been registered, the normal runner fence cancels installation.
    return (
      (job.state === "submitting" || job.state === "submitted") &&
      !files.some((file) => file.category === "package_zip")
    );
  };
  const finish: NonNullable<MediaJobHandler["finish"]> = async (tx, job, outcome, ctx) => {
    const input = ZipInputSchema.parse(job.input),
      now = deps.clock.now();
    const bundle = await tx.zipBundle.findUniqueOrThrow({ where: { id: input.zipBundleId } });
    const owned = bundle.zipState === "building" && bundle.zipGen === input.zipGen;
    const files = await artifacts(tx, job);
    await lockRows(
      tx,
      "file_object",
      files.map((file) => file.id),
    );
    if (job.state === "queued" || job.state === "submitted" || job.state === "submitting") return;
    const ready = owned && outcome.state === "succeeded";
    for (const file of files)
      if (file.status === "stored")
        await link(deps, tx, {
          fileId: file.id,
          refType: "zip_bundle",
          refId: input.zipBundleId,
          role: file.category === "package_zip" ? "zip" : "list",
          entityId: input.entityId,
          storeId: input.storeId,
          released: true,
          keepUntil: ready ? new Date(input.keepUntil) : now,
        });
    if (!owned) return;
    if (!ready) {
      await tx.zipBundle.update({
        where: { id: bundle.id },
        data: { zipState: "failed", updatedAt: now },
      });
      return;
    }
    const output = OutputSchema.parse(outcome.output);
    if (
      !files.some(
        (file) =>
          file.id === output.zipFileId &&
          file.category === "package_zip" &&
          file.status === "stored",
      ) ||
      (output.publishListFileId !== null &&
        !files.some(
          (file) =>
            file.id === output.publishListFileId &&
            file.category === "publish_list" &&
            file.status === "stored",
        ))
    )
      throw new Error("ZIP installation files missing");
    await tx.zipBundle.update({
      where: { id: bundle.id },
      data: {
        zipState: "ready",
        ...output,
        updatedAt: now,
      },
    });
    await deps.events.emit(tx, ctx, {
      type: "media.release.zip_ready",
      aggregate: { type: "zip_bundle", id: bundle.id },
      entityId: input.entityId,
      storeId: input.storeId,
      dedupeKey: `media.release.zip_ready:${bundle.id}:${input.zipGen}`,
      payload: {
        v: 1,
        zipBundleId: bundle.id,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        zipGen: input.zipGen,
      },
    });
  };
  const definition = {
    kind: "zip_package" as const,
    validInput: (value: unknown) => ZipInputSchema.safeParse(value).success,
    validOutput: (value: unknown) => OutputSchema.safeParse(value).success,
    current,
    finish,
    canRetry: async () => false,
  };
  if (!provider)
    return {
      ...definition,
      mode: "remote",
      provider: "unconfigured",
      execute: async () => failure("MEDIA_PROVIDER_UNSUPPORTED"),
    };
  const base = createRemoteMediaHandler({
    provider,
    now: () => deps.clock.now(),
    definition,
    submission: (value, job) => {
      const input = ZipInputSchema.parse(value),
        keys = zipKeys(input, job);
      return {
        tag: "FileCompress",
        bucket: "media",
        dstKey: keys.zip,
        items: [
          ...input.items.map(({ key, name }) => ({ key, name })),
          ...(input.publishListText ? [{ key: keys.list, name: "发布清单.txt" }] : []),
        ],
      };
    },
  });
  async function prepare(job: MediaJob, signal: AbortSignal) {
    if (!provider?.previewZip || !provider.describe || !provider.find)
      return failure("MEDIA_PROVIDER_UNSUPPORTED");
    const input = ZipInputSchema.parse(job.input);
    if (!(await deps.tx.run((tx) => inputCurrent(tx, input))))
      return { state: "canceled" } as const;
    for (const item of input.items) {
      const head = await deps.storage.head({ bucket: "media", key: item.key, signal });
      if (!head.ok) return failure("ZIP_SOURCE_UNAVAILABLE", head.reason === "unavailable");
      if (
        !head.value.exists ||
        !item.etag ||
        head.value.etag !== item.etag ||
        String(head.value.size) !== item.size ||
        (item.crc64 !== null && head.value.crc64 !== item.crc64)
      )
        return failure("ZIP_SOURCE_CHANGED");
    }
    const list = await uploadZipList(deps, job, input, signal);
    return list.ok ? null : failure("ZIP_LIST_UPLOAD_FAILED", list.retryable);
  }
  return {
    ...base,
    execute: async (job, context, signal) =>
      (await prepare(job, signal)) ?? base.execute(job, context, signal),
    recover: async (job, signal) => {
      const input = ZipInputSchema.parse(job.input);
      if (await deps.tx.run((tx) => inputCurrent(tx, input)))
        return (await prepare(job, signal)) ?? base.recover!(job, signal);
      // A stale unknown submission may be found, but must never be submitted again.
      if (!provider.find) return { state: "pending" };
      const userData = `${job.id}:${job.attemptNo}`;
      const found = await provider.find({
        family: "file",
        tag: "FileCompress",
        userData,
        createdAfter: new Date(
          Math.max(
            job.createdAt.getTime(),
            job.deadlineAt.getTime() - jobBudget(job.kind)!.deadlineMs,
          ) - 1000,
        ),
        createdBefore: new Date(deps.clock.now().getTime() + 1000),
        signal,
      });
      if (!found.ok || (!found.value.job && !found.value.complete)) return { state: "pending" };
      if (!found.value.job) return { state: "canceled" };
      if (!found.value.job.processed || found.value.job.userData !== userData)
        return failure("MEDIA_REMOTE_RESULT_INVALID");
      return { state: "submitted", externalJobId: found.value.job.jobId };
    },
    poll: async (job, signal) => {
      const result = await base.poll!(job, signal);
      if (result.state === "submitted" || result.state === "pending") return result;
      const input = ZipInputSchema.parse(job.input),
        keys = zipKeys(input, job),
        src = { bucket: "media" as const, key: keys.zip };
      const head = await deps.storage.head({ ...src, signal });
      if (!head.ok)
        return head.reason === "unavailable"
          ? { state: "pending" }
          : failure("ZIP_OBJECT_UNAVAILABLE");
      const stillCurrent = await deps.tx.run((tx) => inputCurrent(tx, input));
      if (
        !head.value.exists ||
        !head.value.etag ||
        !Number.isSafeInteger(head.value.size) ||
        head.value.size < 0
      )
        return !stillCurrent
          ? { state: "canceled" }
          : result.state === "succeeded"
            ? failure("ZIP_OBJECT_INVALID")
            : result;
      const file = await registerZipArtifact(deps, job, input, {
        role: "zip",
        key: keys.zip,
        size: head.value.size,
        etag: head.value.etag,
        ...(head.value.crc64 ? { crc64: head.value.crc64 } : {}),
      });
      if (!stillCurrent) return { state: "canceled" };
      if (result.state !== "succeeded") return result;
      if (head.value.size < 22) return failure("ZIP_OBJECT_INVALID");
      const output = (result.output ?? {}) as {
        zip?: { dst?: { bucket?: string; key?: string }; fileCount?: number; errorCount?: number };
      };
      const expected = [
        ...input.items.map((item) => ({ name: item.name, sizeBytes: item.size })),
        ...(input.publishListText
          ? [{ name: "发布清单.txt", sizeBytes: String(Buffer.byteLength(input.publishListText)) }]
          : []),
      ];
      if (
        output.zip?.dst?.bucket !== "media" ||
        output.zip.dst.key !== keys.zip ||
        output.zip.fileCount !== expected.length ||
        output.zip.errorCount !== 0 ||
        !head.value.crc64 ||
        !/^\d+$/.test(head.value.crc64)
      )
        return failure("ZIP_RESULT_INVALID");
      signal.throwIfAborted();
      const prefix = await deps.storage.readPrefix({
        ...src,
        bytes: 4,
        ifMatchEtag: head.value.etag,
      });
      signal.throwIfAborted();
      if (!prefix.ok || Buffer.from(prefix.value).toString("hex") !== "504b0304")
        return failure("ZIP_MAGIC_INVALID");
      const preview = await provider.previewZip!({ src, signal });
      if (!preview.ok) return failure("ZIP_PREVIEW_UNAVAILABLE", preview.reason === "unavailable");
      if (
        preview.value.truncated ||
        preview.value.fileCount !== expected.length ||
        preview.value.entries.length !== expected.length ||
        new Set(preview.value.entries.map((entry) => entry.name)).size !== expected.length ||
        expected.some(
          (entry) =>
            !preview.value.entries.some(
              (actual) => actual.name === entry.name && actual.sizeBytes === entry.sizeBytes,
            ),
        )
      )
        return failure("ZIP_CONTENTS_INVALID");
      const final = await deps.storage.head({ ...src, signal });
      if (
        !final.ok ||
        !final.value.exists ||
        final.value.etag !== head.value.etag ||
        final.value.size !== head.value.size ||
        final.value.crc64 !== head.value.crc64
      )
        return failure("ZIP_OBJECT_CHANGED");
      const list = input.publishListText
        ? await deps.tx.run((tx) =>
            tx.fileObject.findUnique({
              where: {
                bucket_objectKey: { bucket: "media", objectKey: keys.list },
              },
            }),
          )
        : null;
      if (input.publishListText && (!list || list.status !== "stored"))
        return failure("ZIP_LIST_MISSING");
      return {
        state: "succeeded",
        output: { zipFileId: file.id, publishListFileId: list?.id ?? null },
      };
    },
  };
}
