import type { ReferralCodeCreateBody } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { beforeAll, describe, expect, it } from "vitest";
import { buildStaffContext, isStaffRoleKey, normalizeRoleConfig } from "../authz/index.js";
import { createIdempotencyContext, createIdentityContext, uuidv7 } from "../kernel/index.js";
import { blindIndex } from "../security/index.js";
import { createReferralCodeIn, setReferralCodeStatusIn } from "../tenant/index.js";
import { signInAsStaff, snapshotTables, useSeededDatabase } from "../testing/index.js";
import { buildHarness, keyring, META, nextOpenid, nextPhone } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { createReferralCodes } from "./referral-codes.js";

const db = useSeededDatabase("services", { label: "referral", max: 1 });
let h: Harness, codes: ReturnType<typeof createReferralCodes>;
const code = () => `R${uuidv7().replaceAll("-", "").slice(-11).toUpperCase()}`;
const TABLES = [
  "referral_code",
  "merchant_user",
  "entity",
  "audit_log",
  "status_transition",
  "outbox_event",
  "idempotency_record",
];
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
  codes = createReferralCodes(h);
}, 120000);
async function actor(roleKey: "cs" | "super_admin" = "cs", isLead = true) {
  const signed = await signInAsStaff(h.prisma, { roleKey, isLead, now: h.clock.now() });
  const row = signed.staff;
  if (!isStaffRoleKey(row.staffRoleKey)) throw new Error("测试角色未登记");
  const role = await h.prisma.staffRole.findUniqueOrThrow({ where: { key: row.staffRoleKey } });
  const staff = buildStaffContext({
    staff: {
      id: row.id,
      roleKey: row.staffRoleKey,
      isLead: row.isLead,
      staffGroupId: row.staffGroupId,
    },
    role: normalizeRoleConfig(row.staffRoleKey, role),
    groupStaffIds: [row.id],
    stepUpAt: h.clock.now(),
  });
  return {
    signed,
    staff,
    ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" }, ...META }),
    meta: { ...META, sessionId: signed.sessionId, authMethod: "password+totp" as const },
  };
}
type Caller = Awaited<ReturnType<typeof actor>>;
function options(by: Caller, op: string, body: unknown, id?: string, key = uuidv7()) {
  return {
    meta: by.meta,
    idem: createIdempotencyContext({
      mode: "required",
      scope: `admin.referralCode.${op}`,
      actor: by.ctx.actor,
      key,
      request: {
        method: "POST",
        pathParams: id ? { referralCodeId: id } : {},
        body,
        storeId: null,
      },
    }),
  };
}
const create = (by: Caller, input: ReferralCodeCreateBody, key?: string) =>
  codes.create(by.ctx, by.staff, input, options(by, "create", input, undefined, key));
const campaign = (by: Caller) =>
  create(by, { code: code(), sourceType: "campaign", label: "虚构活动" });
const disable = (by: Caller, id: string, key?: string) =>
  codes.disable(
    by.ctx,
    by.staff,
    id,
    { reasonText: "活动结束" },
    options(by, "disable", { reasonText: "活动结束" }, id, key),
  );
const enable = (by: Caller, id: string, key?: string) =>
  codes.enable(by.ctx, by.staff, id, {}, options(by, "enable", {}, id, key));

describe("渠道码管理与首次归因真实闭环", { timeout: 120000 }, () => {
  it("登记大写唯一渠道码、销售有效归属与V1.0输入边界", async () => {
    const by = await actor(),
      owner = await h.make.staff(),
      value = code().toLowerCase();
    const result = await create(by, { code: value, sourceType: "sales", ownerStaffId: owner.id });
    expect(result).toMatchObject({
      code: value.toUpperCase(),
      sourceType: "sales",
      status: "active",
      disabledAt: null,
      owner: { staffId: owner.id },
      registeredUserCount: 0,
      entityCount: 0,
    });
    await expect(
      create(by, { code: value.toUpperCase(), sourceType: "campaign" }),
    ).rejects.toMatchObject({ error: "REFERRAL_CODE_TAKEN" });
    const inactive = await h.make.staff({
      status: "disabled",
      disabledAt: h.clock.now(),
      disabledReason: "other",
    });
    for (const input of [
      { code: code(), sourceType: "sales" },
      { code: code(), sourceType: "partner" },
      { code: "码不合法", sourceType: "campaign" },
      { code: code(), sourceType: "sales", ownerStaffId: inactive.id },
      { code: code(), sourceType: "sales", ownerStaffId: uuidv7() },
    ])
      await expect(create(by, input as ReferralCodeCreateBody)).rejects.toMatchObject({
        error: "VALIDATION_FAILED",
      });
    expect(
      await h.prisma.statusTransition.count({ where: { subjectId: result.referralCodeId } }),
    ).toBe(0);
    expect(
      await h.prisma.auditLog.findFirst({ where: { targetId: result.referralCodeId } }),
    ).toMatchObject({
      stream: "ops",
      category: "referral_code",
      action: "tenant.referral_code.create",
      sessionId: by.signed.sessionId,
      entityId: null,
    });
  });

  it("列表全局可见、真实归因现算、筛选稳定分页与GET零写", async () => {
    const by = await actor(),
      row = await campaign(by);
    const user = await h.make.merchantUser({
      sourceType: "campaign",
      sourceReferralCodeId: row.referralCodeId,
    });
    await h.make.entity({
      createdByUserId: user.id,
      sourceType: "campaign",
      sourceReferralCodeId: row.referralCodeId,
    });
    const original = await h.prisma.staffRole.findUniqueOrThrow({ where: { key: "cs" } });
    try {
      await h.prisma.staffRole.update({ where: { key: "cs" }, data: { dataScope: "own" } });
      const before = await snapshotTables(h.prisma, TABLES);
      const list = await codes.list(
        by.ctx,
        by.staff,
        {
          page: 1,
          pageSize: 1,
          q: row.code.toLowerCase(),
          sourceType: ["campaign"],
          status: ["active"],
        },
        { meta: by.meta },
      );
      expect(list).toMatchObject({
        total: 1,
        items: [{ referralCodeId: row.referralCodeId, registeredUserCount: 1, entityCount: 1 }],
      });
      const second = await codes.list(
        by.ctx,
        by.staff,
        { page: 2, pageSize: 1, q: row.code },
        { meta: by.meta },
      );
      expect(second).toMatchObject({ total: 1, items: [] });
      expect(JSON.stringify(list)).not.toMatch(/phoneEnc|phoneMask|phoneBidx|tokenHash/);
      expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
    } finally {
      await h.prisma.staffRole.update({
        where: { key: "cs" },
        data: { dataScope: original.dataScope },
      });
    }
  });

  it("停用启用状态CAS、内部版本与幂等审计；终态或不存在仍拒绝", async () => {
    const by = await actor(),
      row = await campaign(by),
      offKey = uuidv7(),
      onKey = uuidv7();
    const off = await disable(by, row.referralCodeId, offKey);
    expect(off).toMatchObject({ status: "disabled", disabledAt: h.clock.now().toISOString() });
    expect(await disable(by, row.referralCodeId, offKey)).toEqual(off);
    await expect(disable(by, row.referralCodeId)).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    const on = await enable(by, row.referralCodeId, onKey);
    expect(on).toMatchObject({ status: "active", disabledAt: null });
    expect(await enable(by, row.referralCodeId, onKey)).toEqual(on);
    await expect(enable(by, row.referralCodeId)).rejects.toMatchObject({
      error: "STATE_NOT_ALLOWED",
    });
    await expect(disable(by, uuidv7())).rejects.toMatchObject({ error: "NOT_FOUND" });
    expect(
      await h.prisma.referralCode.findUnique({ where: { id: row.referralCodeId } }),
    ).toMatchObject({ lockVersion: 2, code: row.code, ownerStaffId: null });
    expect(await h.prisma.auditLog.count({ where: { targetId: row.referralCodeId } })).toBe(3);
    expect(
      await h.prisma.statusTransition.count({ where: { subjectId: row.referralCodeId } }),
    ).toBe(0);
    expect(await h.prisma.outboxEvent.count({ where: { aggregateId: row.referralCodeId } })).toBe(
      0,
    );
  });

  it("真实登录消费新登记码、邀请码优先；停用不归因且启用不回写旧账号", async () => {
    const by = await actor(),
      owner = await h.make.staff();
    const sales = await create(by, { code: code(), sourceType: "sales", ownerStaffId: owner.id }),
      activity = await campaign(by);
    const login = async (inviteCode: string, channelCode: string, phone = nextPhone()) => {
      await h.identity.phoneLogin(META, {
        ...h.codes({ phone, openid: nextOpenid() }),
        consents: h.consents(),
        attribution: { inviteCode, channelCode },
      });
      return {
        phone,
        row: await h.prisma.merchantUser.findUniqueOrThrow({
          where: { phoneBidx: blindIndex(keyring, "phone", phone) },
        }),
      };
    };
    expect((await login(sales.code.toLowerCase(), activity.code)).row).toMatchObject({
      sourceType: "sales",
      sourceReferralCodeId: sales.referralCodeId,
    });
    await disable(by, sales.referralCodeId);
    expect((await login(sales.code, activity.code.toLowerCase())).row).toMatchObject({
      sourceType: "campaign",
      sourceReferralCodeId: activity.referralCodeId,
    });
    await disable(by, activity.referralCodeId);
    const old = await login(sales.code, activity.code);
    expect(old.row).toMatchObject({ sourceType: "organic", sourceReferralCodeId: null });
    await enable(by, sales.referralCodeId);
    expect((await login(sales.code, activity.code, old.phone)).row).toMatchObject({
      sourceType: "organic",
      sourceReferralCodeId: null,
    });
    expect((await login(sales.code, activity.code)).row.sourceReferralCodeId).toBe(
      sales.referralCodeId,
    );
  });

  it("同键回放仍验当前员工会话/最新权限，非主管不可写但可读", async () => {
    const by = await actor(),
      normal = await actor("cs", false),
      input: ReferralCodeCreateBody = { code: code(), sourceType: "campaign" },
      key = uuidv7();
    const first = await create(by, input, key);
    expect(await create(by, input, key)).toEqual(first);
    expect(await h.prisma.auditLog.count({ where: { targetId: first.referralCodeId } })).toBe(1);
    await expect(create(normal, { code: code(), sourceType: "campaign" })).rejects.toMatchObject({
      error: "PERMISSION_DENIED",
    });
    expect(
      (await codes.list(normal.ctx, normal.staff, { page: 1, pageSize: 20 }, { meta: normal.meta }))
        .total,
    ).toBeGreaterThan(0);
    const original = await h.prisma.staffRole.findUniqueOrThrow({ where: { key: "cs" } });
    try {
      await h.prisma.staffRole.update({
        where: { key: "cs" },
        data: {
          actions: {
            ...(original.actions as Record<string, unknown>),
            "merchant.referral_code.manage": { on: false, leadOnly: false },
          },
        },
      });
      await expect(create(by, input, key)).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
    } finally {
      await h.prisma.staffRole.update({
        where: { key: "cs" },
        data: { actions: original.actions as Prisma.InputJsonValue },
      });
    }
    await h.prisma.staffSession.update({
      where: { id: by.signed.sessionId },
      data: { revokedAt: h.clock.now(), revokeReason: "admin" },
    });
    await expect(create(by, input, key)).rejects.toMatchObject({ error: "SESSION_INVALID" });
  });

  it("tenant公开命令与审计同调用者Tx，后续失败整笔回滚且不产生伪迁移", async () => {
    const by = await actor(),
      input: ReferralCodeCreateBody = { code: code(), sourceType: "campaign" };
    const before = await snapshotTables(h.prisma, TABLES);
    await expect(
      h.tx.run(async (tx) => {
        const created = await createReferralCodeIn(tx, h.clock, by.ctx, by.staff, input, by.meta);
        await setReferralCodeStatusIn(
          tx,
          h.clock,
          by.ctx,
          by.staff,
          created.referralCodeId,
          "disable",
          by.meta,
          "虚构回滚",
        );
        throw new Error("lyxtest referral caller rollback");
      }),
    ).rejects.toThrow("lyxtest referral caller rollback");
    expect(await snapshotTables(h.prisma, TABLES)).toEqual(before);
  });
});
