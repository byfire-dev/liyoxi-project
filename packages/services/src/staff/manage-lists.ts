import type {
  AssignmentPoolListQuery,
  PoolMemberList,
  StaffCounts,
  StaffSummaryQuery,
  StaffSessionListQuery,
  StaffSessionView,
  StaffDetail,
  StaffGroupListQuery,
  StaffPoolMembershipReplaceBody,
  StaffDutyBody,
} from "@liyoxi/contract";
import type { StaffSession, Staff, Prisma } from "@liyoxi/db";
import { RegionExtSchema } from "@liyoxi/contract";
import { maskIp } from "@liyoxi/shared/mask";
import { assertAccess, hasPermission, satisfiesLevel, scopeCovers } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { IdentityContext, Tx, TxRunOptions } from "../kernel/index.js";
import type { StaffManagementDeps } from "./management-deps.js";
import { lockStaffSet, staffAudit } from "./management-shared.js";
import { recommendedStaff, staffBriefs } from "./assignment.js";
import type { AssignmentPool } from "./assignment.js";
import { staffBriefOf } from "./me.js";

const csv = (v?: string) => v?.split(",") ?? [];
export function staffFilter(ctx: StaffContext, q: StaffSummaryQuery): Prisma.StaffWhereInput {
  return {
    AND: [
      ctx.scope.kind === "all" ? {} : { id: { in: [...ctx.scope.staffIds] } },
      ...(q.q
        ? [
            /^\d{4}$/.test(q.q)
              ? { phoneLast4: q.q }
              : { name: { contains: q.q, mode: "insensitive" as const } },
          ]
        : []),
      ...(q.roleKey ? [{ staffRoleKey: { in: csv(q.roleKey) } }] : []),
      ...(q.isLead !== undefined ? [{ isLead: q.isLead }] : []),
      ...(q.staffGroupId ? [{ staffGroupId: q.staffGroupId }] : []),
      ...(q.pool ? [{ assignmentPoolMembers: { some: { pool: { in: csv(q.pool) } } } }] : []),
    ],
  };
}
const poolPermission: Record<AssignmentPool, readonly string[]> = {
  delivery_manager: [
    "merchant.manager.assign",
    "merchant.manager.transfer",
    "service.ticket.assign",
    "service.ticket.transfer",
  ],
  editor: ["delivery.ticket.assign_editor", "delivery.ad.assign"],
  publisher: ["delivery.ticket.assign_publisher"],
  cs: ["service.ticket.assign", "service.ticket.transfer"],
};
function canPool(ctx: StaffContext, pool: AssignmentPool) {
  return (
    satisfiesLevel(ctx.moduleLevels.system, "view") ||
    poolPermission[pool].some((p) => hasPermission(ctx, p as Parameters<typeof hasPermission>[1]))
  );
}
async function membershipView(tx: Tx, deps: StaffManagementDeps, staff: Staff) {
  const rows = await tx.assignmentPoolMember.findMany({
    where: { staffId: staff.id },
    orderBy: [{ pool: "asc" }, { cityCode: "asc" }],
  });
  return Promise.all(
    rows.map(async (r) => ({
      pool: r.pool as AssignmentPool,
      staff: staffBriefOf(staff),
      city: r.cityCode
        ? {
            code: r.cityCode,
            name: (await deps.config.dicts.label("region", r.cityCode)) ?? r.cityCode,
          }
        : null,
      onDuty: r.onDuty,
      updatedAt: r.updatedAt.toISOString(),
    })),
  );
}
function sessionView(
  row: StaffSession & { staff: Staff },
  currentId: string | null,
  now: Date,
): StaffSessionView {
  const live = row.revokedAt === null && row.idleExpiresAt > now && row.absoluteExpiresAt > now;
  return {
    staffSessionId: row.id,
    staff: staffBriefOf(row.staff),
    authMethod: row.authMethod as StaffSessionView["authMethod"],
    ipMask: maskIp(row.ip),
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    idleExpiresAt: row.idleExpiresAt.toISOString(),
    absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokeReason: row.revokeReason as StaffSessionView["revokeReason"],
    isCurrent: row.id === currentId,
    actions: live && row.id !== currentId ? ["revoke"] : [],
  };
}
export function createStaffLists(
  deps: StaffManagementDeps,
  detail: (tx: Tx, ctx: StaffContext, id: string) => Promise<StaffDetail>,
) {
  return {
    summary(ctx: StaffContext, query: StaffSummaryQuery): Promise<StaffCounts> {
      assertAccess(ctx, { module: { module: "system", need: "view" }, permission: null });
      return deps.tx.run(async (tx) => {
        const rows = await tx.staff.findMany({
          where: staffFilter(ctx, query),
          select: {
            status: true,
            passwordHash: true,
            lockedUntilTrusted: true,
            lockedUntilUntrusted: true,
          },
        });
        const now = deps.clock.now();
        return {
          total: rows.length,
          byStatus: {
            active: rows.filter((r) => r.status === "active").length,
            pending: rows.filter((r) => r.status === "pending").length,
            disabled: rows.filter((r) => r.status === "disabled").length,
          },
          pendingActivation: rows.filter((r) => r.status === "active" && r.passwordHash === null)
            .length,
          locked: rows.filter((r) =>
            [r.lockedUntilTrusted, r.lockedUntilUntrusted].some((d) => d !== null && d > now),
          ).length,
        };
      });
    },
    groups(ctx: StaffContext, query: StaffGroupListQuery) {
      const roleKey = query.roleKey;
      assertAccess(ctx, { module: { module: "system", need: "view" }, permission: null });
      return deps.tx.run(async (tx) => {
        const groups = await tx.staffGroup.findMany({
          where: roleKey ? { staffRoleKey: roleKey } : {},
          orderBy: [{ staffRoleKey: "asc" }, { name: "asc" }, { id: "asc" }],
        });
        const members = await tx.staff.findMany({
          where: staffFilter(ctx, {}),
          select: { staffGroupId: true, isLead: true, status: true },
        });
        return {
          items: groups.map((g) => ({
            staffGroupId: g.id,
            name: g.name,
            roleKey: g.staffRoleKey,
            isDefault: g.isDefault,
            memberCount: members.filter((r) => r.staffGroupId === g.id).length,
            activeLeadCount: members.filter(
              (r) => r.staffGroupId === g.id && r.status === "active" && r.isLead,
            ).length,
          })),
        };
      });
    },
    pools(ctx: StaffContext, query: AssignmentPoolListQuery): Promise<PoolMemberList> {
      const requested = csv(query.pool) as AssignmentPool[];
      const allowed = (["delivery_manager", "editor", "publisher", "cs"] as const).filter((p) =>
        canPool(ctx, p),
      );
      if (requested.some((p) => !allowed.includes(p)) || !allowed.length)
        throw new AppError("PERMISSION_DENIED");
      const pools = requested.length ? requested : allowed;
      return deps.tx.run(async (tx) => {
        const rows = await tx.assignmentPoolMember.findMany({
          where: {
            pool: { in: [...pools] },
            ...(query.cityCode ? { cityCode: query.cityCode } : {}),
            ...(query.staffId ? { staffId: query.staffId } : {}),
            ...(query.onDuty !== undefined ? { onDuty: query.onDuty } : {}),
          },
          include: { staff: true },
          orderBy: [{ pool: "asc" }, { cityCode: "asc" }, { staffId: "asc" }],
        });
        const cursors = await tx.assignmentCursor.findMany({
          where: {
            pool: { in: [...pools] },
            ...(query.cityCode ? { scopeKey: query.cityCode } : {}),
          },
          orderBy: [{ pool: "asc" }, { scopeKey: "asc" }],
        });
        const refs = await staffBriefs(
          tx,
          cursors.flatMap((c) => (c.lastStaffId ? [c.lastStaffId] : [])),
        );
        const recommended = new Map<string, string | null>();
        const items = [];
        for (const r of rows) {
          const scope = r.pool === "delivery_manager" ? r.cityCode : "all";
          const key = `${r.pool}:${scope}`;
          if (!recommended.has(key))
            recommended.set(
              key,
              (await recommendedStaff(tx, r.pool as AssignmentPool, scope))?.staffId ?? null,
            );
          items.push({
            pool: r.pool as AssignmentPool,
            staff: staffBriefOf(r.staff),
            city: r.cityCode
              ? {
                  code: r.cityCode,
                  name: (await deps.config.dicts.label("region", r.cityCode)) ?? r.cityCode,
                }
              : null,
            onDuty: r.onDuty,
            updatedAt: r.updatedAt.toISOString(),
            isRecommended: recommended.get(key) === r.staffId,
          });
        }
        return {
          items,
          cursors: cursors.map((r) => ({
            pool: r.pool as AssignmentPool,
            scopeKey: r.scopeKey,
            lastStaff: refs.find((s) => s.staffId === r.lastStaffId) ?? null,
            updatedAt: r.updatedAt.toISOString(),
          })),
        };
      });
    },
    async replacePools(
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      input: StaffPoolMembershipReplaceBody,
      options: TxRunOptions = {},
    ) {
      assertAccess(ctx, { module: null, permission: "sys.staff.manage" });
      return deps.tx.run(async (tx) => {
        for (const m of input.memberships) {
          if (m.pool !== "delivery_manager" && m.cityCode) throw new AppError("VALIDATION_FAILED");
          if (m.cityCode) {
            const d = await tx.dictItem.findUnique({
              where: { dictTypeKey_code: { dictTypeKey: "region", code: m.cityCode } },
            });
            if (
              !d ||
              !d.isEnabled ||
              !RegionExtSchema.safeParse(d.ext).success ||
              RegionExtSchema.parse(d.ext).level !== 2 ||
              !RegionExtSchema.parse(d.ext).opened ||
              RegionExtSchema.parse(d.ext).functionalZone
            )
              throw new AppError("VALIDATION_FAILED", {
                message: "分配城市必须是启用的市级行政区",
              });
          }
        }
        // 仅补登记，不推进轮询；在员工锁之前完成可能等待的游标唯一键插入。
        for (const key of [
          ...new Set(
            input.memberships.map(
              (m) => `${m.pool}:${m.pool === "delivery_manager" ? (m.cityCode ?? "all") : "all"}`,
            ),
          ),
        ].sort()) {
          const [pool, scopeKey] = key.split(":");
          await tx.assignmentCursor.createMany({
            data: [
              {
                pool: pool!,
                scopeKey: scopeKey!,
                createdAt: deps.clock.now(),
                updatedAt: deps.clock.now(),
              },
            ],
            skipDuplicates: true,
          });
        }
        const row = (await lockStaffSet(tx, [id])).get(id)!;
        if (row.status !== "active") throw new AppError("POOL_ROLE_MISMATCH");
        if (row.lockVersion !== input.lockVersion)
          throw new AppError("VERSION_CONFLICT", { details: { currentVersion: row.lockVersion } });
        if (input.memberships.some((m) => m.pool !== row.staffRoleKey))
          throw new AppError("POOL_ROLE_MISMATCH");
        const old = await tx.assignmentPoolMember.findMany({ where: { staffId: id } });
        const now = deps.clock.now();
        const wanted = new Set(input.memberships.map((m) => `${m.pool}:${m.cityCode ?? ""}`));
        for (const prior of old)
          if (!wanted.has(`${prior.pool}:${prior.cityCode}`))
            await tx.assignmentPoolMember.delete({
              where: {
                pool_staffId_cityCode: { pool: prior.pool, staffId: id, cityCode: prior.cityCode },
              },
            });
        for (const m of input.memberships)
          await tx.assignmentPoolMember.upsert({
            where: {
              pool_staffId_cityCode: { pool: m.pool, staffId: id, cityCode: m.cityCode ?? "" },
            },
            create: {
              pool: m.pool,
              staffId: id,
              cityCode: m.cityCode ?? "",
              onDuty: true,
              createdAt: now,
              updatedAt: now,
            },
            update: {},
          });
        await tx.staff.update({
          where: { id },
          data: { lockVersion: { increment: 1 }, updatedAt: now },
        });
        await staffAudit(
          tx,
          actor,
          row,
          "sys.staff.pool_memberships",
          `调整员工分配池 ${row.name}`,
          undefined,
          { memberships: input.memberships },
        );
        return detail(tx, ctx, id);
      }, options);
    },
    async duty(
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      input: StaffDutyBody,
      options: TxRunOptions = {},
    ) {
      if (
        id !== ctx.staff.id &&
        !(
          ctx.staff.roleKey === "cs" &&
          ctx.staff.isLead &&
          hasPermission(ctx, "service.ticket.assign")
        )
      )
        throw new AppError("PERMISSION_DENIED");
      return deps.tx.run(async (tx) => {
        const row = (await lockStaffSet(tx, [id])).get(id)!;
        const m = await tx.assignmentPoolMember.findFirst({ where: { staffId: id, pool: "cs" } });
        if (row.staffRoleKey !== "cs" || row.status !== "active" || !m)
          throw new AppError("STATE_NOT_ALLOWED");
        await tx.assignmentPoolMember.update({
          where: { pool_staffId_cityCode: { pool: "cs", staffId: id, cityCode: m.cityCode } },
          data: { onDuty: input.onDuty, updatedAt: deps.clock.now() },
        });
        await staffAudit(tx, actor, row, "sys.staff.duty", `调整客服当班 ${row.name}`, undefined, {
          onDuty: input.onDuty,
        });
        return (await membershipView(tx, deps, row)).find((r) => r.pool === "cs")!;
      }, options);
    },
    sessions(ctx: StaffContext, query: StaffSessionListQuery, currentId: string | null) {
      assertAccess(ctx, { module: null, permission: "sys.session.revoke" });
      return deps.tx.run(async (tx) => {
        const now = deps.clock.now();
        const where: Prisma.StaffSessionWhereInput = {
          ...(query.staffId ? { staffId: query.staffId } : {}),
          staff: staffFilter(ctx, {}),
          ...(query.activeOnly
            ? { revokedAt: null, idleExpiresAt: { gt: now }, absoluteExpiresAt: { gt: now } }
            : {}),
        };
        const rows = await tx.staffSession.findMany({
          where,
          include: { staff: true },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        });
        return {
          items: rows.map((r) => sessionView(r, currentId, now)),
          total: await tx.staffSession.count({ where }),
          page: query.page,
          pageSize: query.pageSize,
        };
      });
    },
    async revokeSession(
      ctx: StaffContext,
      actor: IdentityContext,
      id: string,
      currentId: string | null,
      reason?: string,
      options: TxRunOptions = {},
    ) {
      assertAccess(ctx, { module: null, permission: "sys.session.revoke" });
      if (id === currentId) throw new AppError("SELF_OPERATION_FORBIDDEN");
      return deps.tx.run(async (tx) => {
        const found = await tx.staffSession.findUnique({
          where: { id },
          select: { staffId: true },
        });
        if (!found || !scopeCovers(ctx.scope, found.staffId)) throw new AppError("NOT_FOUND");
        await lockStaffSet(tx, [found.staffId]);
        const row = await tx.staffSession.findUniqueOrThrow({
          where: { id },
          include: { staff: true },
        });
        const now = deps.clock.now();
        if (row.revokedAt || row.idleExpiresAt <= now || row.absoluteExpiresAt <= now)
          throw new AppError("STATE_NOT_ALLOWED");
        const after = await tx.staffSession.update({
          where: { id },
          data: { revokedAt: now, revokeReason: "admin", updatedAt: now },
          include: { staff: true },
        });
        await staffAudit(
          tx,
          actor,
          row.staff,
          "sys.session.revoke",
          `强制下线员工 ${row.staff.name}`,
          undefined,
          { reason: reason ?? null },
        );
        return sessionView(after, currentId, now);
      }, options);
    },
  };
}
