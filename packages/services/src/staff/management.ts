// a01 员工最小集：创建同事务迁移/审计/事件，读侧显式挑展示字段。
import type {
  AdminPage,
  StaffCreateBody,
  StaffDetail,
  StaffListItem,
  StaffListQuery,
  StaffMutationResult,
  RoleSummary,
} from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { maskIp } from "@liyoxi/shared/mask";
import {
  assertAccess,
  scopeSnapshot,
  hasPermission,
  normalizeRoleConfig,
  scopeCovers,
} from "../authz/index.js";
import type { DataScope, StaffContext } from "../authz/index.js";
import type { Config } from "../config/index.js";
import type { Flow } from "../flow/index.js";
import { AppError, isUniqueViolation, uuidv7 } from "../kernel/index.js";
import type { Clock, IdentityContext, Tx, TxRunOptions, TxRunner } from "../kernel/index.js";
import { sealPhone, openField } from "../security/index.js";
import type { Keyring } from "../security/index.js";
import { issueActivationCode } from "./activation.js";
import { recommendedStaff, staffBriefs } from "./assignment.js";
import type { AssignmentPool } from "./assignment.js";
import { staffBriefOf } from "./me.js";
import { createFullStaffManagement } from "./manage-full.js";
import { createStaffLists } from "./manage-lists.js";
import { workCounts, workSources } from "./work.js";
import type { StaffWorkSources, StaffActivationSender } from "../kernel/index.js";
import type { Media } from "../media/index.js";
import type { Events } from "../events/index.js";
import type { Sla } from "../sla/index.js";
import type { Timers } from "../timers/index.js";

export interface StaffManagementDeps {
  tx: TxRunner;
  clock: Clock;
  flow: Pick<Flow, "transition">;
  config: Pick<Config, "flags" | "dicts">;
  keyring: () => Keyring;
  workSources?: StaffWorkSources;
  sendWecomInvite?: (input: { staffId: string; createdAt: Date }) => Promise<{ created: boolean }>;
  sendActivation?: StaffActivationSender;
  media?: Pick<Media, "link" | "release" | "signRead">;
  events?: Pick<Events, "emit">;
  sla?: Pick<Sla, "dueAt">;
  timers?: Pick<Timers, "arm" | "cancel">;
}
const include = { staffRole: true, staffGroup: true, assignmentPoolMembers: true } as const;
type Row = Prisma.StaffGetPayload<{ include: typeof include }>;
const iso = (date: Date | null): string | null => date?.toISOString() ?? null;
const csv = (value: string | undefined): string[] => value?.split(",") ?? [];
const poolPermissions: Record<AssignmentPool, readonly string[]> = {
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
function staffWhere(scope: DataScope): Prisma.StaffWhereInput {
  scopeSnapshot(scope);
  return scope.kind === "all" ? {} : { id: { in: [...scope.staffIds] } };
}
async function listItem(
  tx: Tx,
  row: Row,
  now: Date,
  viewerId: string,
  options: {
    picker?: boolean;
    withLoad?: boolean;
    recommended?: string;
    ctx?: StaffContext;
    deps?: StaffManagementDeps;
  } = {},
): Promise<StaffListItem> {
  const [handover] = await staffBriefs(
    tx,
    row.handoverToStaffId === null ? [] : [row.handoverToStaffId],
  );
  const role = normalizeRoleConfig(row.staffRoleKey as StaffListItem["roleKey"], row.staffRole);
  const workload = options.withLoad
    ? await workSources(options.deps ?? {}).read(tx, { staffId: row.id, now })
    : null;
  const allowed = (p: "sys.staff.manage" | "sys.staff.secure_ops" | "sys.staff.wecom_bind") =>
    options.ctx !== undefined && hasPermission(options.ctx, p);
  const actions: StaffListItem["actions"] = [];
  if (!options.picker) {
    if (allowed("sys.staff.manage")) {
      actions.push("update", "unlock");
      if (row.status !== "active") actions.push("enable");
      else {
        actions.push("handover");
        if (row.passwordHash === null) actions.push("reissue-activation-code");
      }
    }
    if (allowed("sys.staff.secure_ops") && row.status === "active" && row.id !== viewerId)
      actions.push("disable", "reset-password", "reset-mfa");
    if (allowed("sys.staff.wecom_bind") && row.status !== "disabled") {
      actions.push("bind-wecom");
      if (row.status === "active" && row.wecomBindStatus !== "bound") actions.push("invite-wecom");
    }
  }
  return {
    ...staffBriefOf(row),
    phoneMask: options.picker ? null : row.phoneMask,
    staffGroup:
      row.staffGroup === null
        ? null
        : { staffGroupId: row.staffGroup.id, name: row.staffGroup.name },
    dataScope: role.dataScope === "own" && row.isLead ? "group" : role.dataScope,
    wecomBindStatus: row.wecomBindStatus as StaffListItem["wecomBindStatus"],
    pools: [
      ...new Set(row.assignmentPoolMembers.map((member) => member.pool as AssignmentPool)),
    ].sort(),
    lastLoginAt: iso(row.lastLoginAt),
    isActivated: row.passwordHash !== null,
    isLocked: [row.lockedUntilTrusted, row.lockedUntilUntrusted].some(
      (until) => until !== null && until > now,
    ),
    disabledReason: row.disabledReason as StaffListItem["disabledReason"],
    handoverTo: handover ?? null,
    openWorkCount: workload === null ? null : workload.length,
    openWorkBySource:
      workload === null
        ? null
        : workCounts(workload).map(({ source, subjectType, count }) => ({
            source,
            subjectType,
            count,
          })),
    onDuty: row.assignmentPoolMembers.find((member) => member.pool === "cs")?.onDuty ?? null,
    isRecommended: options.recommended === row.id,
    isSelf: row.id === viewerId,
    actions,
  };
}
async function detail(
  tx: Tx,
  deps: StaffManagementDeps,
  scope: DataScope,
  id: string,
  viewerId: string,
  viewer?: StaffContext,
): Promise<StaffDetail> {
  if (!scopeCovers(scope, id)) throw new AppError("NOT_FOUND");
  const row = await tx.staff.findFirst({ where: { AND: [{ id }, staffWhere(scope)] }, include });
  if (row === null) throw new AppError("NOT_FOUND");
  const now = deps.clock.now();
  const activation = await tx.staffActivation.findFirst({
    where: { staffId: id, usedAt: null, revokedAt: null },
    orderBy: { createdAt: "desc" },
  });
  const refs = await staffBriefs(
    tx,
    [row.disabledByStaffId, row.createdByStaffId].filter(
      (value): value is string => value !== null,
    ),
  );
  const ref = (id: string | null) => refs.find((staff) => staff.staffId === id) ?? null;
  return {
    ...(await listItem(tx, row, now, viewerId, {
      ctx: viewer,
      deps,
      withLoad: deps.workSources !== undefined,
    })),
    displayName: row.displayName,
    servicePhone: row.servicePhone,
    wecom: {
      status: row.wecomBindStatus as StaffDetail["wecom"]["status"],
      userid: row.wecomUserid,
      boundAt: iso(row.wecomBoundAt),
      qrFileId: row.wecomQrFileId,
      qrUrl: null,
    },
    poolMemberships: await Promise.all(
      row.assignmentPoolMembers.map(async (member) => ({
        pool: member.pool as AssignmentPool,
        staff: staffBriefOf(row),
        city:
          member.cityCode === ""
            ? null
            : {
                code: member.cityCode,
                name: (await deps.config.dicts.label("region", member.cityCode)) ?? member.cityCode,
              },
        onDuty: member.onDuty,
        updatedAt: member.updatedAt.toISOString(),
      })),
    ),
    security: {
      isActivated: row.passwordHash !== null,
      totpEnrolledAt: iso(row.totpEnrolledAt),
      passwordChangedAt: iso(row.passwordChangedAt),
      recoveryCodesLeft: Array.isArray(row.recoveryCodes) ? row.recoveryCodes.length : 0,
      lockedUntilTrusted: iso(row.lockedUntilTrusted),
      lockedUntilUntrusted: iso(row.lockedUntilUntrusted),
      failTrusted: row.failTrusted,
      failUntrusted: row.failUntrusted,
      lastLoginAt: iso(row.lastLoginAt),
      lastLoginIpMask: row.lastLoginIp === null ? null : maskIp(row.lastLoginIp),
    },
    pendingActivation:
      activation === null
        ? null
        : {
            purpose: activation.purpose as "activate" | "reset_password",
            delivery: activation.delivery as "manual" | "sms",
            expiresAt: activation.expiresAt.toISOString(),
            attempts: activation.attempts,
          },
    disabledAt: iso(row.disabledAt),
    disabledBy: ref(row.disabledByStaffId),
    createdAt: row.createdAt.toISOString(),
    createdBy: ref(row.createdByStaffId),
    updatedAt: row.updatedAt.toISOString(),
    lockVersion: row.lockVersion,
  };
}

export function createStaffManagement(deps: StaffManagementDeps) {
  return {
    ...createFullStaffManagement(deps, (tx, ctx, id) =>
      detail(tx, deps, ctx.scope, id, ctx.staff.id, ctx),
    ),
    ...createStaffLists(deps, (tx, ctx, id) => detail(tx, deps, ctx.scope, id, ctx.staff.id, ctx)),
    async create(
      ctx: StaffContext,
      actor: IdentityContext,
      input: StaffCreateBody,
      options: TxRunOptions = {},
    ): Promise<StaffMutationResult> {
      assertAccess(ctx, { module: null, permission: "sys.staff.manage" });
      const partnerEnabled =
        input.roleKey === "channel_ops" &&
        (await deps.config.flags.value("release.partner", { platform: "admin" })) === true;
      let transient:
        | {
            id: string;
            code: string;
            activationId: string;
            phoneEnc: string;
            invitationCreatedAt?: Date;
          }
        | undefined;
      try {
        const result = await deps.tx.run(async (tx) => {
          const role = await tx.staffRole.findUnique({ where: { key: input.roleKey } });
          if (role === null) throw new AppError("VALIDATION_FAILED");
          if (input.activateNow && role.availableFrom === "v1.1" && !partnerEnabled)
            throw new AppError("STATE_NOT_ALLOWED", {
              details: {
                reason: "role_not_available",
                roleKey: input.roleKey,
                availableFrom: role.availableFrom,
              },
            });
          const group =
            input.staffGroupId === undefined
              ? await tx.staffGroup.findFirst({
                  where: { staffRoleKey: input.roleKey, isDefault: true },
                })
              : await tx.staffGroup.findUnique({ where: { id: input.staffGroupId } });
          if (group === null || group.staffRoleKey !== input.roleKey)
            throw new AppError("VALIDATION_FAILED", { message: "分组不属于该角色" });
          const now = deps.clock.now();
          const sealed = sealPhone(deps.keyring(), "staff.phone_enc", input.phone);
          const row = await tx.staff.create({
            data: {
              id: uuidv7(),
              name: input.name,
              phoneEnc: sealed.enc,
              phoneBidx: sealed.bidx,
              phoneMask: sealed.mask,
              phoneLast4: sealed.last4,
              staffRoleKey: input.roleKey,
              staffGroupId: group.id,
              isLead: input.isLead,
              status: input.activateNow ? "active" : "pending",
              wecomBindStatus: input.activateNow && input.inviteWecom ? "invited" : "none",
              displayName: input.displayName ?? null,
              servicePhone: input.servicePhone ?? null,
              createdByStaffId: ctx.staff.id,
              createdAt: now,
              updatedAt: now,
            },
          });
          await deps.flow.transition(tx, actor, {
            machine: "staff",
            stateField: "status",
            id: row.id,
            event: "staff.create",
            created: true,
            audit: {
              stream: "ops",
              category: "staff_authz",
              action: "sys.staff.create",
              summary: `新增员工 ${row.name}（工号 ${row.staffNo}）`,
              target: { type: "staff", id: row.id, label: row.name },
              before: null,
              after: {
                name: row.name,
                staffRoleKey: row.staffRoleKey,
                isLead: row.isLead,
                phone: sealed.mask,
                status: row.status,
              },
              fields: ["name", "staffRoleKey", "isLead", "phone", "status"],
            },
            emit: {
              type: "staff.created",
              payload: { v: 1, staffId: row.id, roleKey: input.roleKey },
            },
          });
          const issued = input.activateNow
            ? await issueActivationCode(tx, {
                staffId: row.id,
                purpose: "activate",
                delivery: "manual",
                createdByStaffId: ctx.staff.id,
                now,
              })
            : null;
          if (issued)
            transient = {
              id: row.id,
              code: issued.code,
              activationId: issued.id,
              phoneEnc: row.phoneEnc,
              ...(input.inviteWecom ? { invitationCreatedAt: row.createdAt } : {}),
            };
          return {
            staff: await detail(tx, deps, ctx.scope, row.id, ctx.staff.id, ctx),
            activation:
              issued === null
                ? null
                : {
                    purpose: "activate" as const,
                    delivery: "manual" as const,
                    expiresAt: issued.expiresAt.toISOString(),
                    activationCode: null,
                    replayed: false,
                  },
            replayed: false,
          };
        }, options);
        if (result.replayed || !transient)
          return {
            ...result,
            activation:
              result.activation === null
                ? null
                : { ...result.activation, activationCode: null, replayed: result.replayed },
          };
        const created = transient;
        let sent = false;
        if (input.activationDelivery === "sms" && deps.sendActivation) {
          try {
            sent =
              (
                await deps.sendActivation({
                  phone: openField(deps.keyring(), "staff.phone_enc", created.phoneEnc),
                  code: created.code,
                  activationId: created.activationId,
                })
              ).status === "sent";
          } catch {
            sent = false;
          }
        }
        if (sent)
          await deps.tx.run(async (tx) => {
            await tx.staffActivation.updateMany({
              where: { id: created.activationId, usedAt: null, revokedAt: null },
              data: { delivery: "sms", updatedAt: deps.clock.now() },
            });
          });
        if (created.invitationCreatedAt && deps.sendWecomInvite) {
          try {
            await deps.sendWecomInvite({
              staffId: created.id,
              createdAt: created.invitationCreatedAt,
            });
          } catch {
            /* Staff stays invited; explicit invite retry can deliver the inbox reminder. */
          }
        }
        return {
          ...result,
          activation:
            result.activation === null
              ? null
              : {
                  ...result.activation,
                  delivery: sent ? ("sms" as const) : ("manual" as const),
                  activationCode: sent ? null : created.code,
                },
        };
      } catch (error) {
        if (isUniqueViolation(error, ["uq_staff_phone_bidx"]))
          throw new AppError("STAFF_PHONE_TAKEN", { cause: error });
        throw error;
      }
    },
    list(ctx: StaffContext, query: StaffListQuery): Promise<AdminPage<StaffListItem>> {
      const full = ctx.moduleLevels.system !== "n";
      const pools = [
        ...new Set([
          ...csv(query.pool),
          ...(query.recommendPool === undefined ? [] : [query.recommendPool]),
        ]),
      ] as AssignmentPool[];
      if (
        !full &&
        (pools.length === 0 ||
          pools.some(
            (pool) =>
              !poolPermissions[pool].some((key) =>
                hasPermission(ctx, key as Parameters<typeof hasPermission>[1]),
              ),
          ))
      )
        throw new AppError("PERMISSION_DENIED");
      return deps.tx.run(async (tx) => {
        const clauses: Prisma.StaffWhereInput[] = [
          full ? staffWhere(ctx.scope) : { status: "active" },
        ];
        if (query.q !== undefined)
          clauses.push(
            /^\d{4}$/.test(query.q)
              ? { phoneLast4: query.q }
              : { name: { contains: query.q, mode: "insensitive" } },
          );
        if (query.roleKey !== undefined) clauses.push({ staffRoleKey: { in: csv(query.roleKey) } });
        if (query.status !== undefined) clauses.push({ status: { in: csv(query.status) } });
        if (query.isLead !== undefined) clauses.push({ isLead: query.isLead });
        if (query.staffGroupId !== undefined) clauses.push({ staffGroupId: query.staffGroupId });
        if (pools.length > 0)
          clauses.push({ assignmentPoolMembers: { some: { pool: { in: pools } } } });
        if (query.recommendPool !== undefined)
          clauses.push({
            status: "active",
            assignmentPoolMembers: { some: { pool: query.recommendPool } },
          });
        const where = { AND: clauses };
        let rows = await tx.staff.findMany({
          where,
          include,
          orderBy:
            query.sort === "-lastLoginAt"
              ? [{ lastLoginAt: { sort: "desc", nulls: "last" } }, { id: "asc" }]
              : query.sort === "openWorkCount"
                ? [{ id: "asc" }]
                : [{ staffNo: "asc" }, { id: "asc" }],
          ...(query.sort !== "openWorkCount"
            ? { skip: (query.page - 1) * query.pageSize, take: query.pageSize }
            : {}),
        });
        if (query.sort === "openWorkCount") {
          const loads = new Map<string, number>();
          for (const row of rows)
            loads.set(
              row.id,
              (await workSources(deps).read(tx, { staffId: row.id, now: deps.clock.now() })).length,
            );
          rows.sort(
            (a, b) =>
              loads.get(a.id)! - loads.get(b.id)! ||
              a.staffNo - b.staffNo ||
              a.id.localeCompare(b.id),
          );
          rows = rows.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
        }
        const recommended =
          query.recommendPool === undefined
            ? null
            : await recommendedStaff(tx, query.recommendPool, query.recommendCityCode ?? "all");
        return {
          items: await Promise.all(
            rows.map((row) =>
              listItem(tx, row, deps.clock.now(), ctx.staff.id, {
                picker: !full,
                withLoad: query.withLoad,
                ctx,
                deps,
                ...(recommended === null ? {} : { recommended: recommended.staffId }),
              }),
            ),
          ),
          page: query.page,
          pageSize: query.pageSize,
          total: await tx.staff.count({ where }),
        };
      });
    },
    async get(ctx: StaffContext, id: string) {
      const row = await deps.tx.run((tx) => detail(tx, deps, ctx.scope, id, ctx.staff.id, ctx));
      if (row.wecom.qrFileId && deps.media) {
        try {
          row.wecom.qrUrl = await deps.media.signRead({
            fileId: row.wecom.qrFileId,
            audience: "staff",
          });
        } catch (error) {
          if (!(error instanceof AppError) || error.error !== "FILE_NOT_AVAILABLE") throw error;
        }
      }
      return row;
    },
    roles: (ctx: StaffContext): Promise<{ items: RoleSummary[] }> =>
      deps.tx.run(async (tx) => {
        const roles = await tx.staffRole.findMany({ orderBy: { key: "asc" } });
        return {
          items: await Promise.all(
            roles.map(async (role) => {
              const members = await tx.staff.findMany({
                where: {
                  AND: [{ staffRoleKey: role.key, status: "active" }, staffWhere(ctx.scope)],
                },
                orderBy: [{ staffNo: "asc" }, { id: "asc" }],
              });
              const [updatedBy] = await staffBriefs(
                tx,
                role.updatedByStaffId === null ? [] : [role.updatedByStaffId],
              );
              return {
                roleKey: role.key as RoleSummary["roleKey"],
                name: role.name,
                description: role.description,
                dataScope: role.dataScope as RoleSummary["dataScope"],
                isLocked: role.isLocked,
                availableFrom: role.availableFrom as RoleSummary["availableFrom"],
                members: members.map(staffBriefOf),
                memberCount: members.length,
                updatedAt: role.updatedAt.toISOString(),
                updatedBy: updatedBy ?? null,
              };
            }),
          ),
        };
      }),
  };
}
