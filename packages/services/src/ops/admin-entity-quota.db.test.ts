import { createHash } from "node:crypto";
import { EntityCardSchema } from "@liyoxi/contract";
import type { EntityQuotaUpdateBody } from "@liyoxi/contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ownTaskScope } from "../authz/index.js";
import { uuidv7 } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import {
  createLedgerHarness,
  openTerm,
  sampleStaffContext,
  useSeededDatabase,
} from "../testing/index.js";
import {
  quotaCall,
  quotaHarness,
  realReaders,
  SLOW,
  TABLES,
} from "./__fixtures__/admin-entity-quota.js";
import type { QuotaHarness, QuotaWorld } from "./__fixtures__/admin-entity-quota.js";

const db = useSeededDatabase("services", { label: "adminquota", max: 1 });
let h: QuotaHarness;
beforeAll(async () => {
  h = await quotaHarness(await db.prisma());
}, SLOW);
afterAll(async () => {
  await h?.close();
}, SLOW);
const audits = (w: QuotaWorld) =>
  h.prisma.auditLog.findMany({
    where: { entityId: w.entityId, action: "admin.entity.quota.update" },
    orderBy: { seq: "asc" },
  });
async function unchangedExceptQuota(before: Awaited<ReturnType<QuotaHarness["state"]>>) {
  const after = await h.state();
  for (const table of TABLES)
    if (!["entity", "audit_log", "idempotency_record"].includes(table))
      expect(after[table], table).toEqual(before[table]);
  expect(after.audit_log!.rows).toHaveLength(before.audit_log!.rows.length + 1);
  expect(after.idempotency_record!.rows).toHaveLength(before.idempotency_record!.rows.length + 1);
}

describe("后台额度写入：真实事实、原子审计和完整收据", { timeout: SLOW }, () => {
  it.each([
    { title: "仅门店", patch: { storeLimitOverride: 4 }, expected: [4, 6] },
    { title: "仅成员", patch: { memberLimitOverride: 8 }, expected: [3, 8] },
    { title: "两项", patch: { storeLimitOverride: 4, memberLimitOverride: 8 }, expected: [4, 8] },
    {
      title: "清除两项",
      patch: { storeLimitOverride: null, memberLimitOverride: null },
      expected: [null, null],
    },
    { title: "零成员", patch: { memberLimitOverride: 0 }, expected: [3, 0] },
    { title: "清除门店保留成员", patch: { storeLimitOverride: null }, expected: [null, 6] },
    { title: "清除成员保留门店", patch: { memberLimitOverride: null }, expected: [3, null] },
  ])("$title：版本只加一、精确before/after且无事件旁写", async ({ patch, expected }) => {
    const w = await h.world();
    await h.prisma.entity.update({
      where: { id: w.entityId },
      data: { storeLimitOverride: 3, memberLimitOverride: 6 },
    });
    const body: EntityQuotaUpdateBody = {
      ...(await h.input(w)),
      ...patch,
      reasonText: "核对实际用量后调整😀",
    };
    if (!Object.hasOwn(patch, "storeLimitOverride")) delete body.storeLimitOverride;
    const row = await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } });
    const before = await h.state();
    const card = await quotaCall(h.tenant, w, body);
    expect(EntityCardSchema.parse(card)).toEqual(card);
    expect(card).toEqual(await h.tenant.adminEntityGet(w.staff, w.entityId));
    expect(card).toMatchObject({
      entityId: w.entityId,
      lockVersion: row.lockVersion + 1,
      usage: { storeLimitOverride: expected[0], memberLimitOverride: expected[1] },
    });
    expect(card.usage.storeLimit).toBe(expected[0] ?? 1);
    expect(card.usage.memberLimit).toBe(expected[1] ?? 3);
    expect(await h.prisma.entity.findUniqueOrThrow({ where: { id: w.entityId } })).toEqual({
      ...row,
      storeLimitOverride: expected[0],
      memberLimitOverride: expected[1],
      lockVersion: row.lockVersion + 1,
      updatedAt: h.clock.now(),
    });
    const written = await audits(w);
    expect(written).toHaveLength(1);
    const oldQuota = { storeLimitOverride: 3, memberLimitOverride: 6 };
    const newQuota = { storeLimitOverride: expected[0], memberLimitOverride: expected[1] };
    const changes = (["storeLimitOverride", "memberLimitOverride"] as const).filter(
      (field) => oldQuota[field] !== newQuota[field],
    );
    expect(written[0]).toMatchObject({
      stream: "ops",
      category: "merchant_quota",
      actorType: "staff",
      actorId: w.staff.staff.id,
      entityId: w.entityId,
      targetType: "entity",
      targetId: w.entityId,
      action: "admin.entity.quota.update",
      reasonCode: "other",
      reasonText: body.reasonText,
      requestId: w.ctx.requestId,
    });
    expect(written[0]!.before).toEqual(
      Object.fromEntries(changes.map((field) => [field, oldQuota[field]])),
    );
    expect(written[0]!.after).toEqual(
      Object.fromEntries(changes.map((field) => [field, newQuota[field]])),
    );
    await unchangedExceptQuota(before);
  });

  it("下调低于真实用量保留店员、范围和pending邀请；exact-now排除而+1ms计额", async () => {
    const w = await h.world();
    await h.prisma.entity.update({ where: { id: w.entityId }, data: { storeLimitOverride: 3 } });
    await h.create(w);
    const clerk = await h.make.entityMember({ entityId: w.entityId, role: "clerk" });
    await h.make.storeMember({
      entityId: w.entityId,
      entityMemberId: clerk.id,
      storeId: w.storeId,
    });
    // 合法历史邀请前提；被测quota命令不得迁移或撤销它们。
    const invitations = [];
    for (const offset of [0, 1]) {
      const id = uuidv7();
      invitations.push(
        await h.prisma.invitation.create({
          data: {
            id,
            entityId: w.entityId,
            storeId: w.storeId,
            role: "clerk",
            inviterMemberId: w.memberId,
            tokenHash: createHash("sha256").update(id).digest(),
            tokenEnc: null,
            status: "pending",
            clientRequestId: uuidv7(),
            createdAt: new Date(h.clock.now().getTime() - 1_000),
            updatedAt: h.clock.now(),
            expiresAt: new Date(h.clock.now().getTime() + offset),
          },
        }),
      );
    }
    const before = await h.state();
    const card = await quotaCall(
      h.tenant,
      w,
      await h.input(w, {
        storeLimitOverride: 1,
        memberLimitOverride: 0,
      }),
    );
    expect(EntityCardSchema.parse(card)).toEqual(card);
    expect(card.usage).toMatchObject({
      storesUsed: 2,
      storeLimit: 1,
      storesOver: 1,
      seatsUsed: 2,
      memberLimit: 0,
      seatsOver: 2,
      pendingInvitationCount: 1,
      activeMemberCount: 2,
      isOverLimit: true,
    });
    expect(card.pendingInvitations.map((row) => row.invitationId)).toEqual([invitations[1]!.id]);
    expect(card.stores.find((row) => row.storeId === w.storeId)?.clerkCount).toBe(1);
    await unchangedExceptQuota(before);
  });

  it.each(["active", "ends_exactly_now", "expired", "unlimited_members"] as const)(
    "%s：清除覆盖经真实term和唯一额度公式，不读账户缓存",
    async (mode) => {
      const w = await h.world(),
        previous = h.clock.now();
      try {
        if (mode === "expired") h.clock.set(new Date(previous.getTime() + 86_400_000));
        const ledger = createLedgerHarness(h.prisma, { clock: h.clock });
        const { term } = await openTerm(ledger, { entityId: w.entityId, planCode: "pro" });
        if (mode === "ends_exactly_now" || mode === "expired") {
          for (const [key, initial, following] of [
            ["tenant.default_store_limit", 7, 9],
            ["tenant.default_member_limit", 8, 10],
          ] as const)
            for (const [offset, value] of [
              [0, initial],
              [1, following],
            ] as const)
              await h.prisma.paramValue.create({
                data: {
                  id: uuidv7(),
                  key,
                  value,
                  effectiveAt: new Date(term.endsAt.getTime() + offset),
                  createdByStaffId: w.staff.staff.id,
                  createdAt: h.clock.now(),
                },
              });
        }
        await h.prisma.billingOrder.update({
          where: { id: term.sourceBillingOrderId },
          data: {
            contentSnapshot: {
              v: 1,
              kind: "plan",
              planId: term.planId,
              planRevisionId: term.initialPlanRevisionId,
              months: term.months,
              cyclePriceFen: term.priceTotalFen,
              payFen: term.priceTotalFen,
              monthlyPoints: term.monthlyPoints,
              discountBp: term.discountBp,
              promo: null,
              quotedAt: term.createdAt.toISOString(),
            },
          },
        });
        if (mode === "unlimited_members")
          await h.prisma.subscriptionTerm.update({
            where: { id: term.id },
            data: { maxMembers: null },
          });
        await h.prisma.billingAccount.update({
          where: { entityId: w.entityId },
          data: { planAvailableQty: 999999 },
        });
        await h.prisma.entity.update({
          where: { id: w.entityId },
          data: {
            storeLimitOverride: 99,
            memberLimitOverride: 99,
          },
        });
        if (mode === "ends_exactly_now" || mode === "expired")
          h.clock.set(new Date(term.endsAt.getTime() + (mode === "expired" ? 1 : 0)));
        const staff = await sampleStaffContext(h.prisma, w.staff.staff.id, {
          stepUpAt: h.clock.now(),
        });
        const before = await h.state();
        const card = await quotaCall(
          h.tenant,
          w,
          await h.input(w, {
            storeLimitOverride: null,
            memberLimitOverride: null,
          }),
          uuidv7(),
          staff,
        );
        const active = mode === "active" || mode === "unlimited_members";
        expect(card.subscription.status).toBe(active ? "active" : "expired");
        expect(card.usage).toMatchObject({
          limitReason: active ? "plan" : "inactive",
          storeLimitOverride: null,
          memberLimitOverride: null,
          storeLimit: active ? term.maxStores : mode === "ends_exactly_now" ? 7 : 9,
          memberLimit: active
            ? mode === "unlimited_members"
              ? null
              : term.maxMembers
            : mode === "ends_exactly_now"
              ? 8
              : 10,
          seatsOver: 0,
        });
        expect(card.spendablePoints).not.toBe(999999);
        expect(card).toEqual(await h.tenant.adminEntityGet(staff, w.entityId));
        await unchangedExceptQuota(before);
      } finally {
        h.clock.set(previous);
      }
    },
  );

  it("同键重放原完整快照；新键变更后旧键仍是原DTO且异body精确拒绝", async () => {
    const w = await h.world(),
      key = uuidv7(),
      body = await h.input(w);
    const first = await quotaCall(h.tenant, w, body, key);
    const once = await h.state();
    expect(await quotaCall(h.tenant, w, body, key)).toEqual(first);
    expect(await h.state()).toEqual(once);
    const current = await quotaCall(h.tenant, w, await h.input(w, { storeLimitOverride: 7 }));
    expect(current.lockVersion).toBe(first.lockVersion + 1);
    const twice = await h.state();
    expect(await quotaCall(h.tenant, w, body, key)).toEqual(first);
    await expect(
      quotaCall(h.tenant, w, { ...body, reasonText: "不同正文" }, key),
    ).rejects.toMatchObject({ error: "IDEMPOTENCY_KEY_REUSED" });
    expect(await h.state()).toEqual(twice);
    expect(await audits(w)).toHaveLength(2);
  });

  it("失败不保存成功收据，同键修正前提后可成功", async () => {
    const w = await h.world(),
      key = uuidv7(),
      body = await h.input(w),
      before = await h.state();
    await expect(
      quotaCall(h.tenant, w, { ...body, lockVersion: body.lockVersion + 1 }, key),
    ).rejects.toMatchObject({
      error: "VERSION_CONFLICT",
      details: { lockVersion: body.lockVersion },
    });
    expect(await h.state()).toEqual(before);
    expect(await quotaCall(h.tenant, w, body, key)).toMatchObject({
      lockVersion: body.lockVersion + 1,
    });
    expect(await audits(w)).toHaveLength(1);
  });

  it.each(["permission", "disabled", "role", "group", "lead", "stepup"] as const)(
    "%s：已有成功键仍经过入口授权及真实staff前置读，保留原收据",
    async (mode) => {
      const w = await h.world(),
        key = uuidv7(),
        body = await h.input(w);
      await quotaCall(h.tenant, w, body, key);
      let staff = w.staff;
      if (mode === "permission") staff = { ...staff, permissions: new Set() };
      if (mode === "stepup")
        staff = { ...staff, stepUpAt: new Date(h.clock.now().getTime() - 600_001) };
      if (mode === "disabled")
        await h.prisma.staff.update({
          where: { id: staff.staff.id },
          data: { status: "disabled", disabledAt: h.clock.now(), disabledReason: "other" },
        });
      if (mode === "role")
        await h.prisma.staff.update({
          where: { id: staff.staff.id },
          data: { staffRoleKey: "finance" },
        });
      if (mode === "lead")
        await h.prisma.staff.update({
          where: { id: staff.staff.id },
          data: { isLead: !staff.staff.isLead },
        });
      if (mode === "group") {
        const group = await h.prisma.staffGroup.create({
          data: {
            id: uuidv7(),
            name: `额度组${uuidv7()}`,
            staffRoleKey: "super_admin",
            createdAt: h.clock.now(),
            updatedAt: h.clock.now(),
          },
        });
        await h.prisma.staff.update({
          where: { id: staff.staff.id },
          data: { staffGroupId: group.id },
        });
      }
      const before = await h.state();
      await expect(quotaCall(h.tenant, w, body, key, staff)).rejects.toMatchObject({
        error: mode === "stepup" ? "STEP_UP_REQUIRED" : "PERMISSION_DENIED",
      });
      expect(await h.state()).toEqual(before);
      expect(await audits(w)).toHaveLength(1);
    },
  );

  it.each([
    "all_bindings",
    "billing",
    "profiles",
    "assets",
    "orders",
    "account",
    "bad_dto",
  ] as const)("%s：事实/装配/DTO错误回滚额度、版本、审计和required收据", async (mode) => {
    const w = await h.world(),
      readers = { ...realReaders };
    if (["billing", "profiles", "assets", "orders"].includes(mode))
      Object.defineProperty(readers, mode, { value: undefined });
    if (mode === "bad_dto") readers.orders = async () => ({ live: -1, to_launch: 0 });
    if (mode === "account")
      await h.prisma.billingAccount.deleteMany({ where: { entityId: w.entityId } });
    const service = h.service(h.tx, mode === "all_bindings" ? null : readers);
    const body = await h.input(w),
      before = await h.state();
    await expect(quotaCall(service, w, body)).rejects.toMatchObject({ error: "INTERNAL" });
    expect(await h.state()).toEqual(before);
  });

  it("已有键在readonly预检提交返回后越过StepUp期限仍被拒绝", async () => {
    const w = await h.world(),
      key = uuidv7(),
      body = await h.input(w);
    await quotaCall(h.tenant, w, body, key);
    const before = await h.state(),
      previous = h.clock.now();
    let returnedRead = false;
    const runner: TxRunner = {
      run: async (fn, options) => {
        const result = await h.tx.run(fn, options);
        if (!options?.idem) {
          returnedRead = true;
          h.clock.set(new Date(previous.getTime() + 600_001));
        }
        return result;
      },
    };
    try {
      await expect(quotaCall(h.service(runner), w, body, key)).rejects.toMatchObject({
        error: "STEP_UP_REQUIRED",
      });
      expect(returnedRead).toBe(true);
      expect(await h.state()).toEqual(before);
    } finally {
      h.clock.set(previous);
    }
  });

  it("真实写和audit之后在callback尾故障，完整事务回滚后同键重试", async () => {
    const w = await h.world(),
      body = await h.input(w),
      key = uuidv7(),
      before = await h.state();
    const failure = new Error("额度写与审计后故障");
    let reached = false;
    const runner: TxRunner = {
      run: (fn, options) =>
        h.tx.run(async (tx) => {
          const result = await fn(tx);
          if (options?.idem?.mode === "required") {
            expect(await tx.entity.findUniqueOrThrow({ where: { id: w.entityId } })).toMatchObject({
              storeLimitOverride: 4,
              lockVersion: body.lockVersion + 1,
            });
            expect(
              await tx.auditLog.count({
                where: { entityId: w.entityId, action: "admin.entity.quota.update" },
              }),
            ).toBe(1);
            expect(
              await tx.idempotencyRecord.count({
                where: { scope: "admin.entity.quota.update", key },
              }),
            ).toBe(1);
            reached = true;
            throw failure;
          }
          return result;
        }, options),
    };
    await expect(quotaCall(h.service(runner), w, body, key)).rejects.toBe(failure);
    expect(reached).toBe(true);
    expect(await h.state()).toEqual(before);
    expect(await quotaCall(h.tenant, w, body, key)).toMatchObject({
      lockVersion: body.lockVersion + 1,
    });
    expect(await audits(w)).toHaveLength(1);
  });

  it.each([
    "scope",
    "missing",
    "closed",
    "abandoned",
    "version",
    "confirm_store",
    "confirm_member",
    "actor",
  ] as const)("%s：精确守卫且完整零写", async (mode) => {
    let w = await h.world();
    const body = await h.input(w);
    let staff = w.staff;
    if (mode === "scope") staff = { ...staff, scope: ownTaskScope(staff.staff) };
    if (mode === "missing") w = { ...w, entityId: uuidv7() };
    if (mode === "actor") w = { ...w, ctx: w.merchant };
    if (mode === "closed" || mode === "abandoned")
      await h.prisma.entity.update({
        where: { id: w.entityId },
        data: { lifecycle: mode, closedAt: h.clock.now() },
      });
    if (mode === "version") body.lockVersion += 1;
    if (mode === "confirm_store") body.confirm.storeLimitOverride = 9;
    if (mode === "confirm_member") body.confirm.memberLimitOverride = 9;
    const before = await h.state();
    const expected =
      mode === "scope" || mode === "missing"
        ? "NOT_FOUND"
        : mode === "closed" || mode === "abandoned"
          ? "STATE_NOT_ALLOWED"
          : mode === "version"
            ? "VERSION_CONFLICT"
            : mode === "actor"
              ? "PERMISSION_DENIED"
              : "CONFIRM_MISMATCH";
    await expect(quotaCall(h.tenant, w, body, uuidv7(), staff)).rejects.toMatchObject({
      error: expected,
    });
    expect(await h.state()).toEqual(before);
  });
});
