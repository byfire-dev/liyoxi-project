import { afterEach, beforeEach, expect, it } from "vitest";
import { DEFAULT_CONTROLS } from "@liyoxi/shared/purchase-policy";
import { StaffUpdateBodySchema } from "@liyoxi/contract";
import { satisfiesLevel } from "../../authz/index.js";
import { createRuntime } from "../../runtime.js";
import {
  createIdentityContext,
  createIdempotencyContext,
  loadEnv,
  uuidv7,
} from "../../kernel/index.js";
import {
  createClock,
  createFactories,
  createFakeProviders,
  fakeKeyEnv,
  sampleStaffContext,
  snapshotTables,
  TEST_KEYRING,
  useSeededDatabase,
  useTestRedis,
} from "../../testing/index.js";

const handle = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
let runtime: ReturnType<typeof createRuntime> | undefined;
beforeEach(() => handle.reset(), 60_000);
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

it("受控财务配置：异人审批、24小时边界、密文与幂等、驳回撤回保留历史", async () => {
  const db = await handle.prisma(),
    clock = createClock(new Date("2040-01-09T02:00:00Z"));
  const make = createFactories({ db, clock });
  const root = createRuntime({
    entry: "api",
    version: "w413-finance-test",
    clock,
    env: {
      ...loadEnv({
        APP_ENV: "test",
        DATABASE_URL: await handle.url(),
        REDIS_URL: process.env.REDIS_URL,
      }),
      ...fakeKeyEnv(),
    },
    billingKeyring: TEST_KEYRING,
    redisKeyPrefix: redis.prefix,
    providers: createFakeProviders({ clock }),
  });
  runtime = root;
  async function actor() {
    const row = await make.staff({ staffRoleKey: "finance" });
    return {
      row,
      ctx: createIdentityContext({ actor: { type: "staff", id: row.id, client: "admin" } }),
      staff: await sampleStaffContext(db, row.id, { stepUpAt: clock.now() }),
    };
  }
  const proposer = await actor(),
    approver = await actor(),
    service = root.billing.financeConfig;
  const input = {
    configKey: "bank_account" as const,
    payload: {
      accountName: "本轮虚构收款主体",
      bankName: "本轮虚构银行",
      accountNo: "6222000011119876",
    },
    changeNote: "测试收款账户异人复核",
    confirm: { configKey: "bank_account" as const, baseRevisionId: null },
  };
  const key = uuidv7(),
    idem = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "admin.financeConfigRevision.create",
        actor: proposer.ctx.actor,
        key,
        request: { method: "POST", body: input },
      });
  const created = await service.create(proposer.ctx, proposer.staff, input, { idem: idem() });
  expect(created.state).toBe("pending");
  expect(JSON.stringify(created)).not.toContain(input.payload.accountNo);
  const stored = await db.financeConfigRevision.findUniqueOrThrow({
    where: { id: created.financeConfigRevisionId },
  });
  expect(stored.accountNoEnc).toBeTruthy();
  expect(stored.accountNoEnc).not.toContain(input.payload.accountNo);
  expect(JSON.stringify(stored.payload)).not.toContain(input.payload.accountNo);
  const replayBefore = await snapshotTables(db, [
    "finance_config_revision",
    "approval_request",
    "audit_log",
    "outbox_event",
  ]);
  expect(
    (await service.create(proposer.ctx, proposer.staff, input, { idem: idem() }))
      .financeConfigRevisionId,
  ).toBe(created.financeConfigRevisionId);
  expect(
    await snapshotTables(db, [
      "finance_config_revision",
      "approval_request",
      "audit_log",
      "outbox_event",
    ]),
  ).toEqual(replayBefore);
  const approve = {
    lockVersion: 0,
    confirmChecks: ["change_reviewed"],
    confirm: {
      configKey: "bank_account" as const,
      financeConfigRevisionId: stored.id,
      accountNoLast4: "9876",
    },
  };
  const protectedBefore = await snapshotTables(db, [
    "finance_config_revision",
    "approval_request",
    "audit_log",
    "outbox_event",
  ]);
  await expect(
    service.approve(proposer.ctx, proposer.staff, stored.id, approve),
  ).rejects.toMatchObject({ error: "APPROVAL_SELF_FORBIDDEN" });
  await expect(
    service.approve(approver.ctx, approver.staff, stored.id, { ...approve, lockVersion: 1 }),
  ).rejects.toMatchObject({ error: "VERSION_CONFLICT" });
  await expect(
    service.approve(approver.ctx, approver.staff, stored.id, {
      ...approve,
      confirm: { ...approve.confirm, accountNoLast4: "0000" },
    }),
  ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
  expect(
    await snapshotTables(db, [
      "finance_config_revision",
      "approval_request",
      "audit_log",
      "outbox_event",
    ]),
  ).toEqual(protectedBefore);
  const approvalKey = uuidv7(),
    approvalIdem = () =>
      createIdempotencyContext({
        mode: "required",
        scope: "admin.financeConfigRevision.approve",
        actor: approver.ctx.actor,
        key: approvalKey,
        request: { method: "POST", body: approve },
      });
  const approvedAt = clock.now();
  const scheduled = await service.approve(approver.ctx, approver.staff, stored.id, approve, {
    idem: approvalIdem(),
  });
  expect(scheduled).toMatchObject({
    state: "scheduled",
    effectiveAt: new Date(approvedAt.getTime() + 86_400_000).toISOString(),
  });
  const approvedBefore = await snapshotTables(db, [
    "finance_config_revision",
    "approval_request",
    "audit_log",
    "outbox_event",
  ]);
  await service.approve(approver.ctx, approver.staff, stored.id, approve, { idem: approvalIdem() });
  expect(
    await snapshotTables(db, [
      "finance_config_revision",
      "approval_request",
      "audit_log",
      "outbox_event",
    ]),
  ).toEqual(approvedBefore);
  clock.advance(86_399_999);
  expect(
    (
      await service.list(approver.staff, {
        tab: "current",
        configKey: "bank_account",
        page: 1,
        pageSize: 20,
      })
    ).items,
  ).toEqual([expect.objectContaining({ state: "scheduled" })]);
  clock.advance(1);
  expect(
    (
      await service.list(approver.staff, {
        tab: "current",
        configKey: "bank_account",
        page: 1,
        pageSize: 20,
      })
    ).items,
  ).toEqual([expect.objectContaining({ state: "effective", financeConfigRevisionId: stored.id })]);
  proposer.staff = await sampleStaffContext(db, proposer.row.id, { stepUpAt: clock.now() });
  approver.staff = await sampleStaffContext(db, approver.row.id, { stepUpAt: clock.now() });
  await expect(
    service.create(proposer.ctx, proposer.staff, {
      ...input,
      confirm: { ...input.confirm, baseRevisionId: stored.id },
    }),
  ).rejects.toMatchObject({ error: "CHANGESET_EMPTY" });
  await expect(
    service.create(proposer.ctx, proposer.staff, {
      ...input,
      payload: { ...input.payload, bankName: "本轮另一银行" },
    }),
  ).rejects.toMatchObject({ error: "CONFIRM_MISMATCH" });
  const changed = {
    ...input,
    payload: { ...input.payload, accountNo: "6222000011111234" },
    confirm: { ...input.confirm, baseRevisionId: stored.id },
  };
  const rejected = await service.create(proposer.ctx, proposer.staff, changed);
  expect(
    (
      await service.reject(approver.ctx, approver.staff, rejected.financeConfigRevisionId, {
        note: "本轮资料复核不通过",
      })
    ).state,
  ).toBe("rejected");
  const withdrawn = await service.create(proposer.ctx, proposer.staff, changed);
  expect(
    (
      await service.withdraw(proposer.ctx, proposer.staff, withdrawn.financeConfigRevisionId, {
        note: "本轮申请人撤回",
      })
    ).state,
  ).toBe("withdrawn");
  const controls = await service.create(proposer.ctx, proposer.staff, {
    configKey: "controls",
    payload: { ...DEFAULT_CONTROLS, adminCreateOrder: true },
    changeNote: "本轮即时生效配置",
    confirm: { configKey: "controls", baseRevisionId: null },
  });
  expect(
    (
      await service.approve(approver.ctx, approver.staff, controls.financeConfigRevisionId, {
        lockVersion: 0,
        confirmChecks: ["change_reviewed"],
        confirm: {
          configKey: "controls",
          financeConfigRevisionId: controls.financeConfigRevisionId,
        },
      })
    ).state,
  ).toBe("effective");
  const history = await service.list(approver.staff, {
    tab: "history",
    configKey: "bank_account",
    page: 1,
    pageSize: 20,
  });
  expect(history.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ state: "effective" }),
      expect.objectContaining({ state: "rejected" }),
      expect.objectContaining({ state: "withdrawn" }),
    ]),
  );
  const exposed = JSON.stringify(
    {
      history,
      audits: await db.auditLog.findMany({ where: { category: "finance_config" } }),
      events: await db.outboxEvent.findMany({
        where: { eventType: { startsWith: "finance_config." } },
      }),
    },
    (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value),
  );
  expect(exposed).not.toContain(input.payload.accountNo);
  expect(exposed).not.toContain(changed.payload.accountNo);
  const moved = await service.create(proposer.ctx, proposer.staff, changed);
  const admin = await make.staff({ staffRoleKey: "super_admin" });
  const adminCtx = createIdentityContext({
    actor: { type: "staff", id: admin.id, client: "admin" },
  });
  await root.staffManagement.update(
    await sampleStaffContext(db, admin.id, { stepUpAt: clock.now() }),
    adminCtx,
    proposer.row.id,
    StaffUpdateBodySchema.parse({
      roleKey: "delivery_manager",
      isLead: false,
      ackNoLead: true,
      lockVersion: (await db.staff.findUniqueOrThrow({ where: { id: proposer.row.id } }))
        .lockVersion,
    }),
  );
  proposer.staff = await sampleStaffContext(db, proposer.row.id, { stepUpAt: clock.now() });
  expect(satisfiesLevel(proposer.staff.moduleLevels.finance, "view")).toBe(false);
  expect((await db.staff.findUniqueOrThrow({ where: { id: proposer.row.id } })).status).toBe(
    "active",
  );
  await expect(
    service.list(proposer.staff, { tab: "current", page: 1, pageSize: 20 }),
  ).rejects.toMatchObject({ error: "PERMISSION_DENIED" });
  const withdrawBody = { note: "原申请人转岗后仍可撤回" },
    withdrawKey = uuidv7();
  const withdrawal = () =>
    service.withdraw(proposer.ctx, proposer.staff, moved.financeConfigRevisionId, withdrawBody, {
      idem: createIdempotencyContext({
        mode: "required",
        scope: "admin.financeConfigRevision.withdraw",
        actor: proposer.ctx.actor,
        key: withdrawKey,
        request: { method: "POST", body: withdrawBody },
      }),
    });
  const withdrawnAfterMove = await withdrawal();
  expect(withdrawnAfterMove).toMatchObject({
    state: "withdrawn",
    actions: [],
    approval: { status: "withdrawn", actions: [] },
  });
  expect(JSON.stringify(withdrawnAfterMove)).not.toContain(changed.payload.accountNo);
  expect(
    (
      await db.approvalRequest.findUniqueOrThrow({
        where: { id: withdrawnAfterMove.approval.approvalId },
      })
    ).status,
  ).toBe("withdrawn");
  const afterMove = await snapshotTables(db, [
    "finance_config_revision",
    "approval_request",
    "audit_log",
    "outbox_event",
  ]);
  expect(await withdrawal()).toEqual(withdrawnAfterMove);
  expect(
    await snapshotTables(db, [
      "finance_config_revision",
      "approval_request",
      "audit_log",
      "outbox_event",
    ]),
  ).toEqual(afterMove);
}, 30_000);
