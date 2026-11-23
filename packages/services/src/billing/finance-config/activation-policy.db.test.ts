import { beforeEach, expect, it } from "vitest";
import { createApproval } from "../../approval/index.js";
import { createEvents } from "../../events/index.js";
import { createFlow } from "../../flow/index.js";
import {
  createBizNoIssuer,
  createIdentityContext,
  createTxRunner,
  uuidv7,
} from "../../kernel/index.js";
import type { AppEnv } from "../../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  sampleStaffContext,
  TEST_KEYRING,
  useSeededDatabase,
} from "../../testing/index.js";
import { financeConfigAt, proposeFinanceConfig } from "./index.js";
import { financeConfigView, listFinanceConfigs } from "./read.js";
import { purchaseInvariants } from "../payment/purchase-registration.js";

const handle = useSeededDatabase("services", { max: 1 });
beforeEach(() => handle.reset(), 60_000);
async function setup(appEnv: AppEnv) {
  const db = await handle.prisma(),
    clock = createClock(new Date("2041-02-10T03:00:00Z")),
    tx = createTxRunner({ prisma: db, appEnv: "test" }),
    assembly = assembleForTest({ entry: "api", appEnv }),
    events = createEvents({ assembly, clock, tx }),
    flow = createFlow({ assembly, clock, events }),
    approval = createApproval({
      assembly,
      clock,
      events,
      flow,
      bizNo: createBizNoIssuer({ clock, appEnv }),
    }),
    make = createFactories({ db, clock }),
    proposer = await make.staff({ staffRoleKey: "finance" }),
    reviewer = await make.staff({ staffRoleKey: "finance" });
  const ctx = (id: string) =>
    createIdentityContext({ actor: { type: "staff", id, client: "admin" } });
  const input = {
    configKey: "bank_account" as const,
    payload: {
      accountName: "隔离测试收款户",
      bankName: "隔离测试银行",
      accountNo: "6222000000012345",
    },
    changeNote: "验证按环境等待时间",
  };
  async function propose(env: AppEnv | undefined = appEnv) {
    const staff = await sampleStaffContext(db, proposer.id, { stepUpAt: clock.now() });
    return tx.run((t) =>
      proposeFinanceConfig(
        t,
        { approval, clock, keyring: TEST_KEYRING, ...(env === undefined ? {} : { appEnv: env }) },
        ctx(proposer.id),
        input,
        staff,
      ),
    );
  }
  async function approve(id: string) {
    const staff = await sampleStaffContext(db, reviewer.id, { stepUpAt: clock.now() });
    return tx.run((t) =>
      approval.approve(t, ctx(reviewer.id), {
        approvalId: id,
        staff,
        lockVersion: 0,
        confirmChecks: ["change_reviewed"],
      }),
    );
  }
  return { db, tx, clock, approval, make, proposer, reviewer, ctx, input, propose, approve };
}

it.each([
  ["local", 0],
  ["test", 0],
  ["stg", 30_000],
  ["prod", 86_400_000],
] as const)(
  "%s real approval enforces the exact %i ms boundary",
  async (appEnv, delay) => {
    const h = await setup(appEnv),
      created = await h.propose(),
      approvedAt = h.clock.now();
    await h.approve(created.approvalId);
    const row = await h.db.financeConfigRevision.findUniqueOrThrow({
      where: { id: created.financeConfigRevisionId },
    });
    expect(row.effectiveAt!.getTime()).toBe(approvedAt.getTime() + delay);
    expect(
      (await h.tx.run((tx) => financeConfigAt(tx, new Date(row.effectiveAt!.getTime() - 1)))).bank,
    ).toBeNull();
    expect((await h.tx.run((tx) => financeConfigAt(tx, row.effectiveAt!))).bank?.id).toBe(row.id);
    expect(
      await h.tx.run((tx) => purchaseInvariants[0]!.run!(tx, {}, { now: h.clock.now() })),
    ).toEqual([]);
  },
  60_000,
);

it("staging policy cannot cross into a production approval", async () => {
  const h = await setup("prod"),
    created = await h.propose("stg");
  await expect(h.approve(created.approvalId)).rejects.toMatchObject({
    error: "PRECONDITION_CHANGED",
  });
  expect(
    (await h.db.approvalRequest.findUniqueOrThrow({ where: { id: created.approvalId } })).status,
  ).toBe("pending");
  expect(
    (
      await h.db.financeConfigRevision.findUniqueOrThrow({
        where: { id: created.financeConfigRevisionId },
      })
    ).effectiveAt,
  ).toBeNull();
}, 60_000);

it("an unrecognized stored policy is refused by approval and reported by I12 without SQL casts", async () => {
  const h = await setup("stg"),
    id = uuidv7(),
    at = h.clock.now();
  const request = await h.db.approvalRequest.create({
    data: {
      id: uuidv7(),
      kind: "finance_config_change",
      category: "approval",
      subjectType: "finance_config_revision",
      subjectId: id,
      status: "pending",
      summarySnapshot: { title: "隔离测试非法策略" },
      submitActorType: "staff",
      submitActorId: h.proposer.id,
      submitClient: "admin",
      requesterStaffId: h.proposer.id,
      submittedAt: at,
      dedupeKey: "finance_config_change:bank_account",
      createdAt: at,
      updatedAt: at,
    },
  });
  await h.db.financeConfigRevision.create({
    data: {
      id,
      configKey: "bank_account",
      payload: { activationPolicy: { invalid: true } },
      changeNote: "非法快照隔离测试",
      accountNoEnc: "lyxtest.invalid.enc",
      accountNoMask: "****2345",
      approvalRequestId: request.id,
      createdAt: at,
    },
  });
  await expect(h.approve(request.id)).rejects.toMatchObject({ error: "PRECONDITION_CHANGED" });
  expect(await h.tx.run((tx) => purchaseInvariants[0]!.run!(tx, {}, { now: at }))).toEqual([
    {
      subject: { type: "finance_config_revision", id },
      detail: { problem: "approval_or_effective" },
    },
  ]);
}, 60_000);

it("a later fast approval supersedes an earlier legacy 24h version without changing its history", async () => {
  const h = await setup("stg"),
    proposer = await sampleStaffContext(h.db, h.proposer.id, { stepUpAt: h.clock.now() });
  const legacy = await h.tx.run((tx) =>
    proposeFinanceConfig(
      tx,
      { approval: h.approval, clock: h.clock, keyring: TEST_KEYRING },
      h.ctx(h.proposer.id),
      h.input,
      proposer,
    ),
  );
  await h.approve(legacy.approvalId);
  const legacyRow = await h.db.financeConfigRevision.findUniqueOrThrow({
    where: { id: legacy.financeConfigRevisionId },
  });
  expect(legacyRow.effectiveAt!.getTime() - h.clock.now().getTime()).toBe(86_400_000);
  h.clock.advance(1_000);
  const fast = await h.propose();
  await h.approve(fast.approvalId);
  h.clock.advance(30_000);
  const staff = await sampleStaffContext(h.db, h.reviewer.id, { stepUpAt: h.clock.now() });
  const oldView = await h.tx.run((tx) =>
    financeConfigView(tx, h.approval, staff, legacyRow, h.clock.now()),
  );
  expect(oldView).toMatchObject({ state: "superseded", activationDelaySeconds: 86_400 });
  const list = await h.tx.run((tx) =>
    listFinanceConfigs(
      tx,
      h.approval,
      staff,
      { tab: "current", page: 1, pageSize: 20 },
      h.clock.now(),
    ),
  );
  expect(list.items.map((row) => row.financeConfigRevisionId)).toEqual([
    fast.financeConfigRevisionId,
  ]);
  const { entity } = await h.make.merchant({ verified: true });
  await h.make.billingOrder({
    entityId: entity.id,
    status: "pending_payment",
    channel: "bank_transfer",
    transferState: "awaiting_proof",
    bankAccountFinanceConfigRevisionId: fast.financeConfigRevisionId,
    createdAt: h.clock.now(),
  });
  h.clock.set(new Date(legacyRow.effectiveAt!.getTime() + 1));
  expect((await h.tx.run((tx) => financeConfigAt(tx, h.clock.now()))).bank?.id).toBe(
    fast.financeConfigRevisionId,
  );
  expect(
    await h.db.financeConfigRevision.findUniqueOrThrow({ where: { id: legacyRow.id } }),
  ).toEqual(legacyRow);
  expect(
    await h.tx.run((tx) => purchaseInvariants[0]!.run!(tx, {}, { now: h.clock.now() })),
  ).toEqual([]);
}, 60_000);
