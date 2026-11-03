import type { MediaJob } from "@liyoxi/db";
import { lockRows } from "../kernel/index.js";
import type { ZipArtifactIntent } from "./zip-types.js";
import { ZipInputSchema, zipKeys } from "./zip-types.js";
import { changeZipIntent, zipAttemptActive } from "./zip-intents.js";
import { registerZipArtifact } from "./zip-artifacts.js";
import { jobBudget } from "./jobs/policy.js";
import { SWEEP_BATCH } from "./retention/sweep-context.js";
import type { SweepContext } from "./retention/sweep-context.js";

/** Reserved keys survive uncertain writes and the business job deadline; this is only reclamation. */
export async function recoverZipArtifacts(ctx: SweepContext, after?: string) {
  return ctx.stage("zip-artifacts", async (scope) => {
    const rows = await ctx.tx.run((tx) =>
      tx.fileObject.findMany({
        where: {
          status: "pending",
          bucket: "media",
          uploadMode: "server",
          uploadActorType: "system",
          category: { in: ["package_zip", "publish_list"] },
          objectKey: { startsWith: "pkg/" },
          ...(after ? { id: { gt: after } } : {}),
        },
        orderBy: { id: "asc" },
        take: SWEEP_BATCH,
      }),
    );
    let recovered = 0,
      failed = 0;
    for (const file of rows) {
      await scope.assertHeld();
      try {
        const match = /\/([a-f0-9-]{36})-(\d+)\.(zip|txt)$/.exec(file.objectKey);
        if (!match) throw new Error("ZIP pending key invalid");
        const job = await ctx.tx.run((tx) =>
          tx.mediaJob.findUniqueOrThrow({ where: { id: match[1] } }),
        );
        const input = ZipInputSchema.parse(job.input),
          attemptNo = Number(match[2]);
        const intent = input.artifactIntents?.find((one) => one.attemptNo === attemptNo);
        const role = match[3] === "zip" ? "zip" : "list",
          keys = zipKeys(input, { id: job.id, attemptNo });
        if (
          job.kind !== "zip_package" ||
          job.parentId !== input.zipBundleId ||
          !intent ||
          file.id !== (role === "zip" ? intent.zipFileId : intent.publishListFileId) ||
          file.objectKey !== (role === "zip" ? keys.zip : keys.list) ||
          file.entityId !== input.entityId ||
          file.storeId !== input.storeId
        )
          throw new Error("ZIP pending owner mismatch");
        if (zipAttemptActive(job, attemptNo, ctx.deps.clock.now())) continue;
        const attempt = { ...job, attemptNo };
        if ((role === "zip" ? intent.zipSubmit : intent.listWrite) === "reserved") {
          // Only a never-issued intent can expire without observing an object.
          await ctx.tx.run(async (tx) => {
            await lockRows(tx, "zip_bundle", [input.zipBundleId]);
            await lockRows(tx, "media_job", [job.id]);
            await lockRows(tx, "file_object", [file.id]);
            const active = await tx.mediaJob.findUniqueOrThrow({ where: { id: job.id } });
            const fresh = ZipInputSchema.parse(active.input).artifactIntents?.find(
              (one) => one.attemptNo === attemptNo,
            );
            if (
              fresh &&
              !zipAttemptActive(active, attemptNo, ctx.deps.clock.now()) &&
              (role === "zip" ? fresh.zipSubmit : fresh.listWrite) === "reserved"
            )
              await tx.fileObject.updateMany({
                where: { id: file.id, status: "pending" },
                data: { status: "expired", updatedAt: ctx.deps.clock.now() },
              });
          });
          continue;
        }
        if (role === "zip" && !(await remoteStopped(ctx, attempt, intent, scope.signal))) continue;
        const head = await ctx.deps.storage.head({
          bucket: "media",
          key: file.objectKey,
          signal: scope.signal,
        });
        if (!head.ok) throw new Error("ZIP cleanup HEAD unavailable");
        // Neither a successful DELETE of an absent key nor an absent HEAD closes an unknown write.
        if (!head.value.exists) continue;
        if (!head.value.etag || !Number.isSafeInteger(head.value.size) || head.value.size < 0)
          throw new Error("ZIP cleanup object facts invalid");
        await scope.assertHeld();
        await registerZipArtifact(ctx.deps, attempt, input, {
          role,
          key: file.objectKey,
          size: head.value.size,
          etag: head.value.etag,
          ...(head.value.crc64 ? { crc64: head.value.crc64 } : {}),
          cleanup: true,
        });
        recovered++;
      } catch {
        scope.signal.throwIfAborted();
        await scope.assertHeld();
        failed++;
      }
    }
    return { recovered, failed, after: rows.length === SWEEP_BATCH ? rows.at(-1)!.id : undefined };
  });
}
async function remoteStopped(
  ctx: SweepContext,
  job: MediaJob,
  intent: ZipArtifactIntent,
  signal: AbortSignal,
) {
  if (intent.zipSubmit === "terminal") return true;
  const provider = ctx.deps.zipProvider,
    userData = `${job.id}:${job.attemptNo}`;
  if (!provider?.describe || !provider.find)
    throw new Error("ZIP cleanup remote observation unavailable");
  let externalJobId = intent.externalJobId;
  if (!externalJobId) {
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
      createdBefore: new Date(ctx.deps.clock.now().getTime() + 1000),
      signal,
    });
    if (!found.ok) throw new Error("ZIP cleanup find unavailable");
    if (!found.value.job) return false;
    if (!found.value.job.processed || found.value.job.userData !== userData)
      throw new Error("ZIP cleanup find identity mismatch");
    externalJobId = found.value.job.jobId;
    await changeZipIntent(ctx.deps, job, (one) => ({
      ...one,
      externalJobId,
      zipSubmit: "submitted",
    }));
  }
  const described = await provider.describe({ family: "file", jobId: externalJobId, signal });
  if (!described.ok) throw new Error("ZIP cleanup describe unavailable");
  const value = described.value;
  if (!value.processed || value.userData !== userData || value.jobId !== externalJobId)
    throw new Error("ZIP cleanup remote identity mismatch");
  if (!["succeeded", "failed", "canceled"].includes(value.state)) return false;
  await changeZipIntent(ctx.deps, job, (one) => ({ ...one, externalJobId, zipSubmit: "terminal" }));
  return true;
}
