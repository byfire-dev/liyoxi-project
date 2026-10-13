import {
  FollowUpCompleteBodySchema,
  FollowUpCreateBodySchema,
  FollowUpItemSchema,
  FollowUpParamsSchema,
  FollowUpSubjectSchema,
  FollowUpUpdateBodySchema,
} from "@liyoxi/contract";
import type { FollowUpListQuery } from "@liyoxi/contract";
import type { FollowUp, Prisma } from "@liyoxi/db";
import { record } from "../audit/index.js";
import {
  authorize,
  buildStaffContext,
  entityScope,
  isStaffRoleKey,
  normalizeRoleConfig,
  storeScope,
} from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, lockRows, staffFollowUpPort, uuidv7 } from "../kernel/index.js";
import type {
  Assembly,
  Clock,
  IdentityContext,
  Tx,
  TxRunner,
  TxRunOptions,
} from "../kernel/index.js";
import { lockStaffSet } from "./management-shared.js";
import { staffBriefOf } from "./me.js";

export interface FollowUpsDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly assembly: Pick<Assembly, "portEntries">;
}
const modules = {
  subscription_term: "order",
  order_item: "publish",
  patrol_task: "publish",
  takedown_task: "publish",
  delivery_reissue: "delivery",
  store: "merchant",
} as const;
function moduleOf(type: string) {
  const parsed = FollowUpSubjectSchema.safeParse(type);
  if (!parsed.success) throw new AppError("INTERNAL", { message: "跟进对象类型未登记" });
  return modules[parsed.data];
}
const open = (row: FollowUp) => row.nextFollowAt !== null && row.doneAt === null;
const mutationAllowed = (staff: StaffContext, row: FollowUp, ownerGroup: string | null) =>
  staff.scope.kind === "all" ||
  staff.staff.id === row.ownerStaffId ||
  (staff.staff.isLead &&
    staff.staff.staffGroupId !== null &&
    staff.staff.staffGroupId === ownerGroup);

/** 重新读取当前角色/组，不让旧会话或幂等回执绕过撤权。 */
async function currentStaff(tx: Tx, previous: StaffContext) {
  const row = await tx.staff.findUnique({
    where: { id: previous.staff.id },
    include: { staffRole: true },
  });
  if (!row || row.status !== "active" || !isStaffRoleKey(row.staffRole.key))
    throw new AppError("PERMISSION_DENIED");
  const group = row.staffGroupId
    ? await tx.staff.findMany({
        where: { staffGroupId: row.staffGroupId, status: "active" },
        select: { id: true },
      })
    : [];
  return buildStaffContext({
    staff: {
      id: row.id,
      roleKey: row.staffRole.key,
      isLead: row.isLead,
      staffGroupId: row.staffGroupId,
    },
    role: normalizeRoleConfig(row.staffRole.key, row.staffRole),
    groupStaffIds: group.map((r) => r.id),
    stepUpAt: previous.stepUpAt,
  });
}
function identityOf(staff: StaffContext, identity: IdentityContext) {
  if (
    identity.actor.type !== "staff" ||
    identity.actor.id !== staff.staff.id ||
    identity.actor.client !== "admin" ||
    identity.entityId ||
    identity.storeId
  )
    throw new AppError("PERMISSION_DENIED");
}
const scopedWhere = (staff: StaffContext): Prisma.FollowUpWhereInput =>
  staff.scope.kind === "all"
    ? {}
    : {
        OR: [
          { storeId: { not: null }, store: { is: storeScope(staff.scope) } },
          { storeId: null, entity: { is: entityScope(staff.scope) } },
        ],
      };

export function createStaffFollowUps(deps: FollowUpsDeps) {
  const readers = deps.assembly.portEntries(staffFollowUpPort);
  const authorizeType = (staff: StaffContext, type: string) =>
    authorize(
      staff,
      { module: { module: moduleOf(type), need: "view" }, permission: null },
      deps.clock.now(),
    );
  async function scope(tx: Tx, staff: StaffContext, entityId: string, storeId: string | null) {
    const found = storeId
      ? await tx.store.findFirst({
          where: { id: storeId, entityId, ...storeScope(staff.scope) },
          select: { id: true },
        })
      : await tx.entity.findFirst({
          where: { id: entityId, ...entityScope(staff.scope) },
          select: { id: true },
        });
    if (!found) throw new AppError("NOT_FOUND");
  }
  async function subject(tx: Tx, staff: StaffContext, type: string, id: string) {
    authorizeType(staff, type);
    const reader = readers.get(type);
    if (!reader) throw new AppError("INTERNAL", { message: "跟进对象归属端口未装配" });
    const fact = await reader(tx, id);
    if (!fact) throw new AppError("NOT_FOUND");
    await scope(tx, staff, fact.entityId, fact.storeId);
    return fact;
  }
  async function access(tx: Tx, staff: StaffContext, id: string) {
    const row = await tx.followUp.findUnique({ where: { id } });
    if (!row) throw new AppError("NOT_FOUND");
    const fact = await subject(tx, staff, row.subjectType, row.subjectId);
    if (fact.entityId !== row.entityId || fact.storeId !== row.storeId)
      throw new AppError("NOT_FOUND");
    const owner = row.ownerStaffId
      ? await tx.staff.findUnique({ where: { id: row.ownerStaffId } })
      : null;
    if (!mutationAllowed(staff, row, owner?.staffGroupId ?? null))
      throw new AppError("PERMISSION_DENIED");
    return row;
  }
  async function view(tx: Tx, staff: StaffContext, row: FollowUp) {
    const owner = row.ownerStaffId
      ? await tx.staff.findUnique({ where: { id: row.ownerStaffId } })
      : null;
    const recorder =
      row.actorType === "staff" && row.actorId
        ? await tx.staff.findUnique({ where: { id: row.actorId } })
        : null;
    return FollowUpItemSchema.parse({
      followUpId: row.id,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      entityId: row.entityId,
      storeId: row.storeId,
      channel: row.channel,
      content: row.content,
      intent: row.intent,
      nextFollowAt: row.nextFollowAt?.toISOString() ?? null,
      isOpen: open(row),
      owner: owner ? staffBriefOf(owner) : null,
      doneAt: row.doneAt?.toISOString() ?? null,
      doneNote: row.doneNote,
      recorder: { actorType: row.actorType, staff: recorder ? staffBriefOf(recorder) : null },
      createdAt: row.createdAt.toISOString(),
      lockVersion: row.lockVersion,
      actions:
        open(row) &&
        staff.moduleLevels[moduleOf(row.subjectType)] !== "n" &&
        mutationAllowed(staff, row, owner?.staffGroupId ?? null)
          ? ["update", "complete"]
          : [],
    });
  }
  async function audit(
    tx: Tx,
    identity: IdentityContext,
    row: FollowUp,
    action: "create" | "update" | "complete",
    before: object | null,
    after: object,
  ) {
    await record(
      tx,
      identity.actor,
      {
        requestId: identity.requestId,
        ip: identity.ip,
        userAgent: identity.userAgent,
        sessionId: null,
        authMethod: null,
      },
      {
        stream: "activity",
        category: "follow_up",
        action: `staff.follow_up.${action}`,
        summary: { create: "记录跟进", update: "修改下次跟进时间", complete: "完成跟进" }[action],
        target: { type: "follow_up", id: row.id },
        entityId: row.entityId,
        storeId: row.storeId,
        before,
        after,
        fields: Object.keys(after),
      },
    );
  }
  async function parents(tx: Tx, entityId: string, storeId: string | null) {
    await lockRows(tx, "entity", [entityId]);
    if (storeId) await lockRows(tx, "store", [storeId]);
  }
  type Change =
    | { lockVersion: number; nextFollowAt: string | null }
    | { lockVersion: number; doneNote?: string };
  async function change(
    staff: StaffContext,
    identity: IdentityContext,
    id: string,
    input: Change,
    options: TxRunOptions,
  ) {
    identityOf(staff, identity);
    if (!FollowUpParamsSchema.safeParse({ followUpId: id }).success)
      throw new AppError("VALIDATION_FAILED");
    await deps.tx.run(async (tx) => access(tx, await currentStaff(tx, staff), id));
    return deps.tx.run(async (tx) => {
      const candidate = await tx.followUp.findUniqueOrThrow({ where: { id } });
      await lockStaffSet(tx, [
        staff.staff.id,
        ...(candidate.ownerStaffId ? [candidate.ownerStaffId] : []),
      ]);
      const current = await currentStaff(tx, staff);
      await parents(tx, candidate.entityId, candidate.storeId);
      await tx.$queryRaw`SELECT id FROM follow_up WHERE id=${id}::uuid FOR NO KEY UPDATE`;
      const checkedStaff = await currentStaff(tx, current);
      const row = await access(tx, checkedStaff, id);
      if (row.lockVersion !== input.lockVersion || row.ownerStaffId !== candidate.ownerStaffId)
        throw new AppError("VERSION_CONFLICT");
      if (row.doneAt !== null) throw new AppError("STATE_NOT_ALLOWED");
      const now = deps.clock.now(),
        updating = "nextFollowAt" in input;
      const next = updating && input.nextFollowAt !== null ? new Date(input.nextFollowAt) : null;
      if (
        updating &&
        ((next !== null && next < now) || (row.channel === "system" && next === null))
      )
        throw new AppError("VALIDATION_FAILED");
      const before = updating
        ? { nextFollowAt: row.nextFollowAt?.toISOString() ?? null }
        : { doneAt: null, doneNote: null };
      const after = updating
        ? { nextFollowAt: next?.toISOString() ?? null }
        : { doneAt: now.toISOString(), doneNote: input.doneNote ?? null };
      const changed = await tx.followUp.updateMany({
        where: { id, lockVersion: input.lockVersion, ownerStaffId: row.ownerStaffId, doneAt: null },
        data: {
          ...(updating
            ? { nextFollowAt: next }
            : { doneAt: now, doneNote: input.doneNote ?? null }),
          lockVersion: { increment: 1 },
          updatedAt: now,
        },
      });
      if (changed.count !== 1) throw new AppError("VERSION_CONFLICT");
      const updated = await tx.followUp.findUniqueOrThrow({ where: { id } });
      await audit(tx, identity, row, updating ? "update" : "complete", before, after);
      return view(tx, checkedStaff, updated);
    }, options);
  }
  return {
    async list(staff: StaffContext, q: FollowUpListQuery) {
      if (
        (q.subjectType === undefined) !== (q.subjectId === undefined) ||
        (!q.subjectId && !q.entityId && !q.storeId && q.mine !== true)
      )
        throw new AppError("VALIDATION_FAILED");
      return deps.tx.run(async (tx) => {
        const current = await currentStaff(tx, staff);
        authorizeType(current, q.subjectType ?? "store");
        if (q.subjectType && q.subjectId) await subject(tx, current, q.subjectType, q.subjectId);
        if (q.entityId) await scope(tx, current, q.entityId, null);
        if (
          q.storeId &&
          !(await tx.store.findFirst({
            where: { id: q.storeId, ...storeScope(current.scope) },
            select: { id: true },
          }))
        )
          throw new AppError("NOT_FOUND");
        const where: Prisma.FollowUpWhereInput = {
          AND: [
            scopedWhere(current),
            {
              ...(q.subjectType ? { subjectType: q.subjectType, subjectId: q.subjectId } : {}),
              ...(q.entityId ? { entityId: q.entityId } : {}),
              ...(q.storeId ? { storeId: q.storeId } : {}),
              ...(q.mine ? { ownerStaffId: current.staff.id } : {}),
              ...(q.isOpen === true
                ? { nextFollowAt: { not: null }, doneAt: null }
                : q.isOpen === false
                  ? { OR: [{ nextFollowAt: null }, { doneAt: { not: null } }] }
                  : {}),
            },
          ],
        };
        const total = await tx.followUp.count({ where });
        const rows = await tx.followUp.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (q.page - 1) * q.pageSize,
          take: q.pageSize,
        });
        const items = [];
        for (const row of rows) items.push(await view(tx, current, row));
        return { items, total, page: q.page, pageSize: q.pageSize };
      });
    },
    async create(
      staff: StaffContext,
      identity: IdentityContext,
      raw: unknown,
      options: TxRunOptions = {},
    ) {
      identityOf(staff, identity);
      const parsed = FollowUpCreateBodySchema.safeParse(raw);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      const input = parsed.data;
      await deps.tx.run(async (tx) =>
        subject(tx, await currentStaff(tx, staff), input.subjectType, input.subjectId),
      );
      return deps.tx.run(async (tx) => {
        await lockStaffSet(tx, [staff.staff.id]);
        const current = await currentStaff(tx, staff),
          fact = await subject(tx, current, input.subjectType, input.subjectId);
        await parents(tx, fact.entityId, fact.storeId);
        const checkedStaff = await currentStaff(tx, current);
        const checked = await subject(tx, checkedStaff, input.subjectType, input.subjectId);
        if (checked.entityId !== fact.entityId || checked.storeId !== fact.storeId)
          throw new AppError("NOT_FOUND");
        const now = deps.clock.now(),
          next = input.nextFollowAt ? new Date(input.nextFollowAt) : null;
        if (next !== null && next <= now) throw new AppError("VALIDATION_FAILED");
        const prior = await tx.$queryRaw<
          { id: string }[]
        >`SELECT id FROM follow_up WHERE subject_type=${input.subjectType} AND subject_id=${input.subjectId}::uuid AND next_follow_at IS NOT NULL AND done_at IS NULL ORDER BY id FOR NO KEY UPDATE`;
        await tx.followUp.updateMany({
          where: { id: { in: prior.map((r) => r.id) }, doneAt: null },
          data: { doneAt: now, lockVersion: { increment: 1 }, updatedAt: now },
        });
        const row = await tx.followUp.create({
          data: {
            id: uuidv7(),
            subjectType: input.subjectType,
            subjectId: input.subjectId,
            entityId: fact.entityId,
            storeId: fact.storeId,
            channel: input.channel ?? null,
            content: input.content,
            intent: input.intent ?? null,
            nextFollowAt: next,
            ownerStaffId: current.staff.id,
            actorType: "staff",
            actorId: current.staff.id,
            client: "admin",
            createdAt: now,
            updatedAt: now,
          },
        });
        await audit(tx, identity, row, "create", null, {
          subjectType: row.subjectType,
          subjectId: row.subjectId,
          content: row.content,
          channel: row.channel,
          intent: row.intent,
          nextFollowAt: next?.toISOString() ?? null,
          ownerStaffId: row.ownerStaffId,
        });
        return view(tx, checkedStaff, row);
      }, options);
    },
    async update(
      staff: StaffContext,
      identity: IdentityContext,
      id: string,
      raw: unknown,
      options: TxRunOptions = {},
    ) {
      const parsed = FollowUpUpdateBodySchema.safeParse(raw);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      return change(staff, identity, id, parsed.data, options);
    },
    async complete(
      staff: StaffContext,
      identity: IdentityContext,
      id: string,
      raw: unknown,
      options: TxRunOptions = {},
    ) {
      const parsed = FollowUpCompleteBodySchema.safeParse(raw);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      return change(staff, identity, id, parsed.data, options);
    },
  };
}
