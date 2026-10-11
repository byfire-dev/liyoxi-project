import type { Prisma, PrismaClient } from "@liyoxi/db";
import { paramsAt } from "../../config/index.js";
import { createEvents } from "../../events/index.js";
import { createFlow } from "../../flow/index.js";
import { AppError, alertsOf, createIdempotencyContext, uuidv7 } from "../../kernel/index.js";
import type { Assembly, IdentityContext, TxRunner } from "../../kernel/index.js";
import { createFakeWechat, snapshotTables, TEST_KEYRING } from "../../testing/index.js";
import type { AdjustableClock } from "../../testing/index.js";
import { claimTimers, createTimers, runTimer } from "../../timers/index.js";
import { createInvitationExpiry, createTenant } from "../index.js";
import type { InvitationDeps } from "../index.js";
import { memberContext, removalHarness, removalServices, SLOW } from "./member-removal.js";

export { memberContext, SLOW };
type InvitationParamKey =
  "invitation.require_phone" | "invitation.ttl_hours" | "invitation.daily_cap";
export const TABLES = [
  "invitation",
  "invitation_request",
  "timer",
  "audit_log",
  "status_transition",
  "outbox_event",
  "idempotency_record",
];
export function invitationServices(
  prisma: PrismaClient,
  clock?: AdjustableClock,
  runner?: TxRunner,
  override: Partial<InvitationDeps> = {},
) {
  const base = removalServices(prisma, clock, runner);
  // 本域测试只接真实拥有者，不构造高层运行时；实例装配/关停由 ops 与 worker 整叶覆盖。
  const timerHandlers: Assembly["timerHandlers"] = base.assembly.timerHandlers.map((item) =>
    item.kind === "invitation.expire"
      ? { ...item, handle: (tx, timer) => expiry.handle(tx, timer) }
      : item,
  );
  const assembly: Assembly = {
    ...base.assembly,
    timerHandlers,
    timerHandler: (kind) => timerHandlers.find((item) => item.kind === kind),
  };
  const events = createEvents({ tx: base.tx, clock: base.clock, assembly });
  const flow = createFlow({ assembly, clock: base.clock, events });
  const timers = createTimers({ assembly });
  const wechat = createFakeWechat({ clock: base.clock });
  const invitations: InvitationDeps = {
    keyring: () => TEST_KEYRING,
    timers,
    async checkRemark(_principal, content) {
      // 本域检测端口替身不代替 API 的真实会话 openid 解析。
      const result = await wechat.checkText({
        openid: "lyxtest_invitation",
        scene: "profile",
        content,
      });
      if (!result.ok) throw new AppError("PROVIDER_UNAVAILABLE");
      if (result.value.verdict !== "pass")
        throw new AppError("CONTENT_REJECTED", { details: { fields: ["remarkName"] } });
    },
    ...override,
  };
  const tenant = createTenant({
    tx: base.tx,
    clock: base.clock,
    assembly,
    flow,
    events,
    invitations,
  });
  const expiry = createInvitationExpiry({ clock: base.clock, flow });
  const timerDeps = {
    tx: base.tx,
    assembly,
    registry: timers.registry,
    clock: base.clock,
    alerts: alertsOf(assembly),
  };
  return { ...base, assembly, events, flow, timers, tenant, wechat, timerDeps };
}
export function invitationHarness(prisma: PrismaClient) {
  const base = removalHarness(prisma);
  const service = invitationServices(prisma, base.clock);
  const originalParams = new Map<InvitationParamKey, Prisma.InputJsonValue>();
  const principal = (ctx: IdentityContext) => {
    if (ctx.actor.type !== "merchant") throw new TypeError("检测样例要求商家身份");
    return {
      sessionId: uuidv7(),
      merchantUserId: ctx.actor.id,
      wechatIdentityId: uuidv7(),
      consentStamp: null,
    };
  };
  async function card(
    owner: { ctx: IdentityContext },
    body: {
      clientRequestId?: string;
      remarkName?: string | null;
      targetPhone?: string | null;
    } = {},
  ) {
    return service.tenant.createInvitation(
      owner.ctx,
      { clientRequestId: uuidv7(), ...body },
      { principal: principal(owner.ctx) },
    );
  }
  async function trace(id: string) {
    const [row, requests, timers, history, audits, events] = await Promise.all([
      prisma.invitation.findUniqueOrThrow({ where: { id } }),
      prisma.invitationRequest.findMany({ where: { invitationId: id }, orderBy: { id: "asc" } }),
      prisma.timer.findMany({
        where: { subjectType: "invitation", subjectId: id },
        orderBy: { id: "asc" },
      }),
      prisma.statusTransition.findMany({ where: { subjectId: id }, orderBy: { seq: "asc" } }),
      prisma.auditLog.findMany({ where: { targetId: id }, orderBy: { seq: "asc" } }),
      prisma.outboxEvent.findMany({ where: { aggregateId: id }, orderBy: { seq: "asc" } }),
    ]);
    return { row, requests, timers, history, audits, events };
  }
  async function claim(id: string, side = service) {
    const timer = await prisma.timer.findFirstOrThrow({
      where: { subjectId: id, status: "scheduled" },
    });
    // 合法时钟偏差前提：队列已到点，业务时钟可能仍早于邀请期限。
    await prisma.timer.update({
      where: { id: timer.id },
      data: { fireAt: new Date(0), retryAt: null },
    });
    const batch = await side.tx.run((tx) =>
      claimTimers(tx, side.timers.registry, side.clock.now()),
    );
    const ref = batch.claimed.find((item) => item.timerId === timer.id);
    if (!ref) throw new Error("本邀请的真实 timer 未被认领");
    return ref;
  }
  async function param(key: InvitationParamKey, value: Prisma.InputJsonValue) {
    if (!originalParams.has(key)) {
      const current = await paramsAt(prisma, [key], base.clock.now());
      originalParams.set(key, current[key]);
    }
    // 参数只能追加；递进一毫秒建立合法修订，不覆盖同刻已有事实。
    base.clock.advance(1);
    const staff = await base.make.staff({ staffRoleKey: "super_admin" });
    return prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key,
        value,
        effectiveAt: base.clock.now(),
        createdAt: base.clock.now(),
        createdByStaffId: staff.id,
      },
    });
  }
  async function restoreParams() {
    // afterEach 即使断言失败也追加原值，保留本例的完整参数历史。
    for (const [key, value] of originalParams) await param(key, value);
    originalParams.clear();
  }
  return {
    ...base,
    ...service,
    principal,
    card,
    trace,
    claim,
    param,
    restoreParams,
    state: () => snapshotTables(prisma, TABLES),
    run: async (id: string) => runTimer(service.timerDeps, await claim(id)),
  };
}
export type InvitationHarness = ReturnType<typeof invitationHarness>;
export type Owner = Awaited<ReturnType<InvitationHarness["owner"]>>;
export function invitationIdem(
  ctx: IdentityContext,
  id: string,
  action: "markShared" | "revoke",
  body: unknown = null,
  key = uuidv7(),
) {
  return createIdempotencyContext({
    mode: "required",
    scope: `m.invitation.${action}`,
    actor: ctx.actor,
    key,
    request: { method: "POST", pathParams: { invitationId: id }, body, storeId: ctx.storeId },
  });
}
