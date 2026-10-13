import {
  PurgeApproveBodySchema,
  PurgeRejectBodySchema,
  PurgeRunViewSchema,
} from "@liyoxi/contract";
import type {
  AdminFileListQuery,
  PurgeRunListQuery,
  PurgeApproveBody,
  PurgeRejectBody,
} from "@liyoxi/contract";
import type { FilePurgeRun, Prisma } from "@liyoxi/db";
import { dayRange } from "@liyoxi/shared/time";
import { assertConfirm, hasPermission } from "../../authz/index.js";
import type { StaffContext } from "../../authz/index.js";
import { AppError } from "../../kernel/index.js";
import type { IdempotencyContext, Tx } from "../../kernel/index.js";
import { inStaffScope } from "../access.js";
import { retentionFileView } from "./view.js";
import { audit, currentStaff } from "./auth.js";
import type { RetentionActor, RetentionDeps } from "./types.js";

export async function runView(deps: RetentionDeps, tx: Tx, row: FilePurgeRun, staff: StaffContext) {
  const byCategory: Record<string, { count: number; bytes: string }> = {};
  if (!row.byCategory || Array.isArray(row.byCategory) || typeof row.byCategory !== "object")
    throw new TypeError("清除分类统计不是对象");
  for (const [category, value] of Object.entries(row.byCategory)) {
    if (
      !value ||
      Array.isArray(value) ||
      typeof value !== "object" ||
      typeof value.count !== "number" ||
      !["string", "number"].includes(typeof value.bytes)
    )
      throw new TypeError("清除分类统计无效");
    byCategory[category] = { count: value.count, bytes: String(value.bytes) };
  }
  if (row.decidedByStaffId && !deps.retention) throw new AppError("PROVIDER_UNAVAILABLE");
  const decidedBy = row.decidedByStaffId
    ? (await deps.retention!.staffBriefs(tx, [row.decidedByStaffId]))[0]
    : null;
  if (row.decidedByStaffId && !decidedBy) throw new TypeError("清除运行决定员工摘要缺失");
  return PurgeRunViewSchema.parse({
    purgeRunId: row.id,
    mode: row.mode,
    state: row.state,
    candidateCount: row.candidateCount,
    candidateBytes: row.candidateBytes.toString(),
    byCategory,
    heldReason: row.heldReason,
    decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    deletedCount: row.deletedCount,
    guardTrips: row.guardTrips,
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    actions:
      ["proposed", "held"].includes(row.state) && hasPermission(staff, "files.purge.approve")
        ? ["approve", "reject"]
        : [],
  });
}
export function createRetentionAdmin(deps: RetentionDeps) {
  async function decide(
    actor: RetentionActor,
    id: string,
    raw: PurgeApproveBody | PurgeRejectBody,
    input: { idem?: IdempotencyContext },
    approve: boolean,
  ) {
    if (input.idem?.mode !== "required") throw new AppError("INTERNAL");
    const parsed = (approve ? PurgeApproveBodySchema : PurgeRejectBodySchema).safeParse(raw);
    if (!parsed.success) throw new AppError("VALIDATION_FAILED");
    await deps.tx.run((tx) =>
      currentStaff(deps, tx, actor, "files.purge.approve", false, !approve),
    );
    return deps.tx.run(
      async (tx) => {
        const staff = await currentStaff(deps, tx, actor, "files.purge.approve", true, !approve);
        await tx.$queryRawUnsafe("SELECT id FROM file_purge_run WHERE id=$1::uuid FOR UPDATE", id);
        const run = await tx.filePurgeRun.findUnique({ where: { id } });
        if (!run) throw new AppError("NOT_FOUND");
        if (!["proposed", "held"].includes(run.state)) throw new AppError("STATE_NOT_ALLOWED");
        if (approve && "confirm" in parsed.data)
          assertConfirm(parsed.data.confirm, {
            candidateCount: run.candidateCount,
            candidateBytes: run.candidateBytes.toString(),
          });
        const result = await tx.filePurgeRun.update({
          where: { id },
          data: {
            state: approve ? "approved" : "rejected",
            decidedByStaffId: staff.staff.id,
            decidedAt: deps.clock.now(),
            updatedAt: deps.clock.now(),
          },
        });
        await audit(
          tx,
          actor,
          approve ? "files.purge.approve" : "files.purge.reject",
          id,
          "reason" in parsed.data
            ? parsed.data.reason
            : "note" in parsed.data
              ? parsed.data.note
              : undefined,
        );
        return runView(deps, tx, result, staff);
      },
      { idem: input.idem },
    );
  }
  return {
    listFiles: (actor: RetentionActor, query: AdminFileListQuery) =>
      deps.tx.run(async (tx) => {
        const staff = await currentStaff(deps, tx, actor, null);
        const candidates = query.purgeRunId
          ? ((
              await tx.filePurgeRun.findUnique({
                where: { id: query.purgeRunId },
                select: { candidateIds: true },
              })
            )?.candidateIds ?? [])
          : undefined;
        const where: Prisma.FileObjectWhereInput = {
          AND: [inStaffScope(staff), ...(candidates ? [{ id: { in: candidates } }] : [])],
          ...(query.status ? { status: { in: query.status } } : {}),
          ...(query.category ? { category: { in: query.category } } : {}),
          ...(query.scopeType ? { scopeType: query.scopeType } : {}),
          ...(query.entityId ? { entityId: query.entityId } : {}),
          ...(query.storeId ? { storeId: query.storeId } : {}),
          ...(query.uploadActorType ? { uploadActorType: query.uploadActorType } : {}),
          ...(query.uploadActorId ? { uploadActorId: query.uploadActorId } : {}),
          ...(query.fileIds ? { id: { in: query.fileIds } } : {}),
          ...(query.q ? { originalName: { contains: query.q, mode: "insensitive" } } : {}),
          ...(query.deletedFrom || query.deletedTo
            ? {
                deletedAt: {
                  ...(query.deletedFrom ? { gte: dayRange(query.deletedFrom).start } : {}),
                  ...(query.deletedTo ? { lt: dayRange(query.deletedTo).end } : {}),
                },
              }
            : {}),
        };
        const orderBy: Prisma.FileObjectOrderByWithRelationInput[] = [
          query.sort === "-createdAt"
            ? { createdAt: "desc" }
            : query.sort === "-sizeBytes"
              ? { sizeBytes: { sort: "desc", nulls: "last" } }
              : { deletedAt: { sort: "desc", nulls: "last" } },
          { id: "desc" },
        ];
        const total = await tx.fileObject.count({ where });
        const files = await tx.fileObject.findMany({
          where,
          orderBy,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });
        return {
          items: await Promise.all(
            files.map((file) => retentionFileView(tx, { ...actor, staff }, file, deps.clock.now())),
          ),
          total,
          page: query.page,
          pageSize: query.pageSize,
        };
      }),
    listRuns: (actor: RetentionActor, query: PurgeRunListQuery) =>
      deps.tx.run(async (tx) => {
        const staff = await currentStaff(deps, tx, actor, null),
          where = { state: { in: query.state } };
        const total = await tx.filePurgeRun.count({ where });
        const rows = await tx.filePurgeRun.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });
        return {
          items: await Promise.all(rows.map((row) => runView(deps, tx, row, staff))),
          total,
          page: query.page,
          pageSize: query.pageSize,
        };
      }),
    approveRun: (
      actor: RetentionActor,
      id: string,
      raw: PurgeApproveBody,
      input: { idem?: IdempotencyContext } = {},
    ) => decide(actor, id, raw, input, true),
    rejectRun: (
      actor: RetentionActor,
      id: string,
      raw: PurgeRejectBody,
      input: { idem?: IdempotencyContext } = {},
    ) => decide(actor, id, raw, input, false),
  };
}
