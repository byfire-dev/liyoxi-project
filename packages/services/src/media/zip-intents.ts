import type { MediaJob } from "@liyoxi/db";
import { lockRows, uuidv7 } from "../kernel/index.js";
import type { BoundMediaDeps } from "./context.js";
import { ZipInputSchema, ZipArtifactIntentSchema, zipKeys } from "./zip-types.js";
import type { ZipArtifactIntent } from "./zip-types.js";

const activeStates = ["submitting", "submitted"];
export const zipAttemptActive = (job: MediaJob, attemptNo: number, now: Date) =>
  job.attemptNo === attemptNo && activeStates.includes(job.state) && job.deadlineAt > now;
export async function readZipIntent(deps: BoundMediaDeps, job: Pick<MediaJob, "id" | "attemptNo">) {
  const current = await deps.tx.run((tx) =>
    tx.mediaJob.findUniqueOrThrow({ where: { id: job.id } }),
  );
  return ZipInputSchema.parse(current.input).artifactIntents?.find(
    (one) => one.attemptNo === job.attemptNo,
  );
}

/** Persist the object keys before any remote write; unknown objects are never fabricated as stored. */
export async function reserveZipArtifacts(deps: BoundMediaDeps, job: MediaJob) {
  const snapshot = ZipInputSchema.parse(job.input);
  return deps.tx.run(async (tx) => {
    await lockRows(tx, "zip_bundle", [snapshot.zipBundleId]);
    await lockRows(tx, "media_job", [job.id]);
    const current = await tx.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
    const input = ZipInputSchema.parse(current.input);
    const existing = input.artifactIntents?.find((one) => one.attemptNo === job.attemptNo);
    if (existing) return existing;
    if (
      (input.artifactIntents?.length ?? 0) >= current.maxAttempts ||
      job.attemptNo > current.maxAttempts
    )
      throw new Error("ZIP artifact intents exceed job attempt budget");
    if (
      !zipAttemptActive(current, job.attemptNo, deps.clock.now()) ||
      current.leaseOwner !== job.leaseOwner
    )
      return null;
    const keys = zipKeys(input, job),
      now = deps.clock.now();
    const intent: ZipArtifactIntent = {
      attemptNo: job.attemptNo,
      zipFileId: uuidv7(),
      publishListFileId: input.publishListText ? uuidv7() : null,
      listWrite: "reserved",
      zipSubmit: "reserved",
      externalJobId: null,
    };
    await tx.fileObject.createMany({
      data: [
        {
          id: intent.zipFileId,
          key: keys.zip,
          category: "package_zip",
          size: 0,
          mime: "application/zip",
          ext: "zip",
        },
        ...(intent.publishListFileId
          ? [
              {
                id: intent.publishListFileId,
                key: keys.list,
                category: "publish_list",
                size: Buffer.byteLength(input.publishListText!),
                mime: "text/plain",
                ext: "txt",
              },
            ]
          : []),
      ].map((file) => ({
        id: file.id,
        bucket: "media",
        objectKey: file.key,
        category: file.category,
        scopeType: "store",
        entityId: input.entityId,
        storeId: input.storeId,
        uploadActorType: "system",
        uploadMode: "server",
        status: "pending",
        declaredSize: file.size,
        declaredMime: file.mime,
        ext: file.ext,
        uploadExpiresAt: null,
        createdAt: now,
        updatedAt: now,
      })),
    });
    await tx.mediaJob.update({
      where: { id: job.id },
      data: {
        input: { ...input, artifactIntents: [...(input.artifactIntents ?? []), intent] },
      },
    });
    return intent;
  });
}

/** Technical facts are appended under the job lock even when its business lease is obsolete. */
export async function changeZipIntent(
  deps: BoundMediaDeps,
  job: Pick<MediaJob, "id" | "attemptNo" | "input" | "leaseOwner">,
  change: (intent: ZipArtifactIntent) => ZipArtifactIntent,
  claim?: "list" | "zip",
) {
  const snapshot = ZipInputSchema.parse(job.input);
  return deps.tx.run(async (tx) => {
    await lockRows(tx, "zip_bundle", [snapshot.zipBundleId]);
    await lockRows(tx, "media_job", [job.id]);
    const row = await tx.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
    const input = ZipInputSchema.parse(row.input),
      intents = input.artifactIntents ?? [];
    const intent = intents.find((one) => one.attemptNo === job.attemptNo);
    if (!intent) throw new Error("ZIP artifact intent missing");
    if (
      claim &&
      (!zipAttemptActive(row, job.attemptNo, deps.clock.now()) ||
        row.leaseOwner !== job.leaseOwner ||
        (claim === "list" ? intent.listWrite : intent.zipSubmit) !== "reserved")
    )
      return false;
    const proposed = ZipArtifactIntentSchema.parse(change(intent));
    if (
      proposed.attemptNo !== intent.attemptNo ||
      proposed.zipFileId !== intent.zipFileId ||
      proposed.publishListFileId !== intent.publishListFileId ||
      (intent.externalJobId &&
        proposed.externalJobId &&
        intent.externalJobId !== proposed.externalJobId)
    )
      throw new Error("ZIP artifact intent identity changed");
    const next = {
      ...proposed,
      zipSubmit: intent.zipSubmit === "terminal" ? ("terminal" as const) : proposed.zipSubmit,
      listWrite: intent.listWrite === "verified" ? ("verified" as const) : proposed.listWrite,
      externalJobId: intent.externalJobId ?? proposed.externalJobId,
    };
    await tx.mediaJob.update({
      where: { id: row.id },
      data: {
        input: {
          ...input,
          artifactIntents: intents.map((one) => (one.attemptNo === next.attemptNo ? next : one)),
        },
      },
    });
    return true;
  });
}
