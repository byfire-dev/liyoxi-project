// W2-30：沿 M1 唯一隔离/runtime/close；业务写只走正式 HTTP 或已有配置初始化。
import assert from "node:assert/strict";
import { alertsOf, isUuid } from "../kernel/index.js";
import { SMS_TEMPLATE_SEEDS } from "../notify/index.js";
import { SMS_TEMPLATE_PARAMS } from "../providers/types.js";
import { createM1Support } from "./m1-support.js";
import { createClock } from "./clock.js";
import type { M1SupportOptions } from "./m1-types.js";
import { createM2Transport } from "./m2-transport.js";
import { createM2Background } from "./m2-background.js";
import { prepareClosedBillingDays } from "./billing-daily.js";

export interface M2FactScope {
  entityId: string;
  userIds: readonly string[];
  staffIds?: readonly string[];
}
export async function createM2Support(options: Pick<M1SupportOptions, "runId" | "clock"> = {}) {
  const base = await createM1Support({
    ...options,
    clock: options.clock ?? createClock(new Date()),
  });
  let closed = false;
  const startedAt = base.clock.now();
  const owned = () => {
    assert.ok(!closed && base.runtime.env.APP_ENV === "test", "M2 支架已关闭或环境改变");
    assert.ok(base.runtime.env.DATABASE_URL.includes(`/${base.databaseName}`), "M2 库归属改变");
  };
  return {
    ...base,
    ...createM2Transport(base, startedAt, owned),
    drainBackground: createM2Background(base, startedAt, owned),
    async fullInvariants() {
      owned();
      // 邀请到期等运输会跨日：正式日投影完成后，仍运行原全域零违规断言。
      await prepareClosedBillingDays(base.runtime);
      return base.fullInvariants();
    },
    startedAt,
    alerts: alertsOf(base.runtime.assembly),
    async configureSms(staffId: string) {
      owned();
      return base.runtime.smsInit({
        staffId,
        config: {
          templates: SMS_TEMPLATE_SEEDS.map((row, index) => ({
            ...row,
            providerTemplateId: String(100000 + index),
            signName: "虚构测试",
            params: SMS_TEMPLATE_PARAMS[row.templateKey as keyof typeof SMS_TEMPLATE_PARAMS],
            status: "active",
            approval: {
              templateApproved: true,
              signApproved: true,
              reference: "isolated-fixture-only",
            },
          })),
        },
      });
    },
    async facts(scope: M2FactScope) {
      owned();
      for (const ids of [[scope.entityId], scope.userIds, scope.staffIds ?? []])
        assert.ok(ids.length <= 16 && ids.every(isUuid), "M2 只读事实范围不合法");
      return base.runtime.tx.run(async (tx) => ({
        users: await tx.merchantUser.findMany({
          where: { id: { in: [...scope.userIds] } },
          select: { id: true, status: true, deletedAt: true },
        }),
        members: await tx.entityMember.findMany({
          where: { entityId: scope.entityId },
          select: { id: true, merchantUserId: true, role: true, status: true, removeReason: true },
        }),
        stores: await tx.store.findMany({
          where: { entityId: scope.entityId },
          select: { id: true, name: true, deliveryManagerId: true, qualificationStatus: true },
        }),
        rounds: await tx.qualificationSubmission.findMany({
          where: { entityId: scope.entityId },
          select: { id: true, roundNo: true, outcome: true, storeId: true },
          orderBy: { createdAt: "asc" },
        }),
        invitations: await tx.invitation.findMany({
          where: { entityId: scope.entityId },
          select: { id: true, status: true, createdAt: true, expiresAt: true },
        }),
        staff: await tx.staff.findMany({
          where: { id: { in: [...(scope.staffIds ?? [])] } },
          select: { id: true, status: true },
        }),
        staffSessions: await tx.staffSession.findMany({
          where: { staffId: { in: [...(scope.staffIds ?? [])] } },
          select: { staffId: true, revokedAt: true, revokeReason: true },
        }),
        sessions: await tx.userSession.findMany({
          where: { merchantUserId: { in: [...scope.userIds] } },
          select: { merchantUserId: true, revokedAt: true, revokeReason: true },
        }),
        audits: await tx.auditLog.findMany({
          where: {
            createdAt: { gte: startedAt },
            OR: [
              { entityId: scope.entityId },
              { actorId: { in: [...scope.userIds, ...(scope.staffIds ?? [])] } },
            ],
          },
          select: { action: true, targetId: true, actorId: true },
          take: 256,
        }),
        history: await tx.statusTransition.findMany({
          where: { entityId: scope.entityId },
          select: { subjectId: true, event: true },
          take: 256,
        }),
      }));
    },
    async close() {
      closed = true;
      await base.close();
    },
  };
}
export type M2Support = Awaited<ReturnType<typeof createM2Support>>;
