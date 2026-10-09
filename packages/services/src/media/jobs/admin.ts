import { MediaJobNoteBodySchema, MediaJobViewSchema } from "@liyoxi/contract";
import type { MediaJobListQuery } from "@liyoxi/contract";
import type { MediaJob, Prisma } from "@liyoxi/db";
import { dayRange } from "@liyoxi/shared/time";
import { hasPermission, satisfiesLevel, assertPermission } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { record } from "../../audit/index.js";
import type { AuditRequestMeta } from "../../audit/index.js";
import { AppError, lockRows } from "../../kernel/index.js";
import type { Clock, IdentityContext, IdempotencyContext, TxRunner } from "../../kernel/index.js";
import type { MediaJobs } from "./runner.js";
import { lockJobParent } from "./runner.js";
import { jobBudget } from "./policy.js";
import type { MediaJobKind, MediaParentType } from "./types.js";
export interface MediaJobActor {
  readonly staff: StaffContext;
  readonly identity: IdentityContext;
  readonly meta: AuditRequestMeta;
}
const quantity = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return `${whole}.${fraction.padEnd(3, "0")}`;
};
const view = (row: MediaJob, manage: boolean) =>
  MediaJobViewSchema.parse({
    mediaJobId: row.id,
    kind: row.kind,
    provider: row.provider,
    mode: row.mode,
    subject: { type: row.subjectType, id: row.subjectId },
    parent: row.parentType && row.parentId ? { type: row.parentType, id: row.parentId } : null,
    state: row.state,
    attemptNo: row.attemptNo,
    maxAttempts: row.maxAttempts,
    externalJobId:
      row.externalJobId && /^[A-Za-z0-9_-]{1,256}$/.test(row.externalJobId)
        ? row.externalJobId
        : null,
    error:
      row.errorCode || row.errorMessage
        ? {
            code:
              row.errorCode && /^[A-Za-z0-9_]{1,100}$/.test(row.errorCode)
                ? row.errorCode
                : "MEDIA_EXECUTION_FAILED",
            message: "媒体处理未完成，原始详情已隐去",
            isRetryable: row.isRetryable,
          }
        : null,
    nextRunAt: row.nextRunAt.toISOString(),
    deadlineAt: row.deadlineAt.toISOString(),
    billable:
      row.billableQty === null
        ? null
        : {
            qty: quantity(row.billableQty.toString()),
            unit: row.billableUnit,
            estCostMicro: row.estCostMicro?.toString() ?? null,
          },
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    actions: manage && row.state === "failed" ? ["retry"] : [],
  });
export function createMediaJobAdmin(options: { tx: TxRunner; clock: Clock; jobs: MediaJobs }) {
  async function list(staff: StaffContext, query: MediaJobListQuery) {
    if (!satisfiesLevel(staff.moduleLevels.system, "view")) throw new AppError("PERMISSION_DENIED");
    const where: Prisma.MediaJobWhereInput = {
      state: { in: query.state },
      ...(query.kind ? { kind: { in: query.kind } } : {}),
      ...(query.subjectType ? { subjectType: query.subjectType, subjectId: query.subjectId } : {}),
      ...(query.parentType ? { parentType: query.parentType, parentId: query.parentId } : {}),
      ...(query.createdFrom && query.createdTo
        ? {
            createdAt: {
              gte: dayRange(query.createdFrom).start,
              lt: dayRange(query.createdTo).end,
            },
          }
        : {}),
    };
    return options.tx.run(async (tx) => {
      const total = await tx.mediaJob.count({ where });
      const rows = await tx.mediaJob.findMany({
        where,
        orderBy:
          query.sort === "-createdAt"
            ? [{ createdAt: "desc" }, { id: "desc" }]
            : [
                { finishedAt: { sort: "desc", nulls: "last" } },
                { createdAt: "desc" },
                { id: "desc" },
              ],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      });
      return {
        items: rows.map((row) => view(row, hasPermission(staff, "media.job.retry"))),
        total,
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }
  async function retry(
    actor: MediaJobActor,
    id: string,
    raw: unknown,
    input: { idem?: IdempotencyContext } = {},
  ) {
    assertPermission(actor.staff, "media.job.retry", options.clock.now());
    if (actor.identity.actor.type !== "staff" || actor.identity.actor.id !== actor.staff.staff.id)
      throw new AppError("PERMISSION_DENIED");
    const body = MediaJobNoteBodySchema.safeParse(raw);
    if (!body.success) throw new AppError("VALIDATION_FAILED");
    const result = await options.tx.run(
      async (tx) => {
        const snapshot = await tx.mediaJob.findUnique({ where: { id } });
        if (!snapshot) throw new AppError("NOT_FOUND");
        await lockJobParent(
          tx,
          snapshot,
          snapshot.parentType
            ? options.jobs.convergence.get(snapshot.parentType as MediaParentType)
            : undefined,
        );
        await lockRows(tx, "media_job", [id]);
        const job = await tx.mediaJob.findUniqueOrThrow({ where: { id } });
        if (job.parentType !== snapshot.parentType || job.parentId !== snapshot.parentId)
          throw new AppError("STATE_NOT_ALLOWED");
        if (job.state !== "failed") throw new AppError("STATE_NOT_ALLOWED");
        const handler = options.jobs.handlers.get(job.kind as MediaJobKind),
          budget = jobBudget(job.kind);
        const parent = job.parentType
          ? options.jobs.convergence.get(job.parentType as MediaParentType)
          : undefined;
        if (
          !handler ||
          !budget ||
          handler.mode !== job.mode ||
          (handler.provider && handler.provider !== job.provider) ||
          !handler.validInput(job.input) ||
          !(await (handler.canRetry ?? handler.current)(tx, job)) ||
          (parent && !(await parent.needed(tx, job)))
        )
          throw new AppError("MEDIA_JOB_NOT_RETRYABLE");
        await handler.retry?.(tx, job);
        const now = options.clock.now();
        const written = await tx.mediaJob.update({
          where: { id },
          data: {
            state: "queued",
            attemptNo: 0,
            leaseOwner: null,
            externalJobId: null,
            finishedAt: null,
            nextRunAt: now,
            deadlineAt: new Date(now.getTime() + budget.deadlineMs),
            errorCode: null,
            errorMessage: null,
            isRetryable: false,
            updatedAt: now,
          },
        });
        await record(tx, actor.identity.actor, actor.meta, {
          stream: "ops",
          category: "system_ops",
          action: "media.job.retry",
          summary: "人工重试媒体任务",
          target: { type: "media_job", id },
          before: { state: "failed", attemptNo: job.attemptNo },
          after: { state: "queued", attemptNo: 0 },
          fields: ["state", "attemptNo", "deadlineAt"],
          ...(body.data.note ? { reason: { code: "other", text: body.data.note } } : {}),
        });
        return view(written, true);
      },
      { idem: input.idem },
    );
    if (!input.idem?.replayed) await options.jobs.wake(id);
    return result;
  }
  return { list, retry };
}
