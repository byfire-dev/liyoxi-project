import { subscriptionInvariants } from "../subscription/invariants.js";
import { Prisma } from "@liyoxi/db";
import { beforeAll, expect, it, vi } from "vitest";
import {
  createPaymentHarness,
  pendingPlanOrder,
  transferReceipt,
  useSeededDatabase,
  snapshotTables,
  assertSnapshotsEqual,
} from "../../testing/index.js";
import type { PaymentHarness } from "../../testing/index.js";
import { LegacyEvidenceSchema } from "./legacy-evidence-schema.js";
import { readLegacyEvidence } from "./legacy-read-evidence.js";
import { LEGACY_EVENT_ID, legacyHash, reconstructLegacySnapshot } from "./legacy-reconstruction.js";
import { recoverLegacyDailySnapshot } from "./legacy-recovery.js";
import type { LegacyRecoveryInput } from "./legacy-recovery.js";
import { resolveLegacyDailyPayload } from "./legacy-supplement.js";
import { BillingDailyHistoryMissingError, computeEntityDaily } from "./daily.js";
import { createBillingDailyProjection } from "./daily.js";

const db = useSeededDatabase("services", { max: 2 });
let h: PaymentHarness, entityId: string, input: LegacyRecoveryInput;
let captured: unknown;
const sourceTables = [
  "billing_account",
  "billing_order",
  "payment_txn",
  "subscription_term",
  "subscription_event",
  "grant_schedule",
  "point_lot",
  "ledger_operation",
  "point_ledger_entry",
  "outbox_event",
];
beforeAll(async () => {
  h = createPaymentHarness(await db.prisma());
  h.clock.set(new Date("2040-11-17T04:00:00.000Z"));
  const merchant = await h.make.merchant({ verified: true });
  entityId = merchant.entity.id;
  const staff = await h.make.staff({ staffRoleKey: "super_admin" });
  const order = await pendingPlanOrder(h, { entityId, months: 12 });
  const receipt = await transferReceipt(h, order);
  await h.tx.run(async (tx) => {
    const original = tx.subscriptionEvent.create.bind(tx.subscriptionEvent);
    const spy = vi.spyOn(tx.subscriptionEvent, "create").mockImplementation((args) => {
      captured = args.data.payload;
      return original({
        ...args,
        data: { ...args.data, id: LEGACY_EVENT_ID, payload: Prisma.DbNull },
      });
    });
    try {
      await h.payment.applyPayment(tx, { paymentTxnId: receipt.id });
    } finally {
      spy.mockRestore();
    }
  });
  input = {
    eventId: LEGACY_EVENT_ID,
    apply: false,
    authorizedByStaffId: staff.id,
    operator: "test operator",
    reason: "authorized synthetic legacy recovery",
    sourceSha: "a".repeat(40),
  };
  h.clock.set(new Date("2040-11-20T04:00:00.000Z"));
}, 120_000);

it("真实收款履约的旧写入形态复现历史缺失，12 类反例拒绝；冻结证据重建等于原正式快照", async () => {
  await expect(
    computeEntityDaily(h.prisma, entityId, "2040-11-19", h.clock.now()),
  ).rejects.toBeInstanceOf(BillingDailyHistoryMissingError);
  const evidence = await h.tx.run((tx) => readLegacyEvidence(tx));
  const reconstructed = reconstructLegacySnapshot(evidence);
  expect(reconstructed).toEqual(captured);
  const changes: [string[], unknown][] = [
    [["activationOutbox"], []],
    [["events"], []],
    [["orders", "0", "paid_amount_fen"], 1],
    [["terms", "0", "extended_days"], 1],
    [["grants"], []],
    [["grants", "0", "status"], "pending"],
    [["grants", "1", "value_fen"], 1],
    [["event", "payload"], {}],
    [["activationOutbox", "0", "payload", "endsAt"], "2099-01-01T00:00:00Z"],
    [["entries"], []],
    [["events", "0", "to_plan_id"], entityId],
    [["activationOutbox", "0", "created_at"], "2099-01-01T00:00:00Z"],
  ];
  for (const [path, value] of changes) {
    const changed = structuredClone(evidence);
    let node = changed as Record<string, unknown>;
    for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
    node[path.at(-1)!] = value;
    expect(
      () => reconstructLegacySnapshot(LegacyEvidenceSchema.parse(changed)),
      path.join("."),
    ).toThrow();
  }
});
it("预览不写；错授权、过期指纹、缺确认均拒绝，双连接争用仅一条补充及一条审计", async () => {
  const before = await snapshotTables(h.prisma, sourceTables);
  const preview = await h.tx.run((tx) => recoverLegacyDailySnapshot(tx, input, h.clock.now()));
  expect(preview.status).toBe("preview");
  expect(await h.prisma.subscriptionEventDailySupplement.count()).toBe(0);
  const ordinary = await h.make.staff();
  await expect(
    h.tx.run((tx) =>
      recoverLegacyDailySnapshot(tx, { ...input, authorizedByStaffId: ordinary.id }, h.clock.now()),
    ),
  ).rejects.toThrow("AUTHORIZER_INVALID");
  await expect(
    h.tx.run((tx) => recoverLegacyDailySnapshot(tx, { ...input, apply: true }, h.clock.now())),
  ).rejects.toThrow("EXPECTED_HASHES_REQUIRED");
  const apply = {
    ...input,
    apply: true,
    evidenceHash: preview.evidenceHash,
    payloadHash: preview.payloadHash,
  };
  await expect(
    h.tx.run((tx) =>
      recoverLegacyDailySnapshot(tx, { ...apply, evidenceHash: "f".repeat(64) }, h.clock.now()),
    ),
  ).rejects.toThrow("FRESH_EVIDENCE_CHANGED");
  for (let round = 0; round < 3; round++) {
    const results = await Promise.all([
      h.tx.run((tx) => recoverLegacyDailySnapshot(tx, apply, h.clock.now())),
      h.tx.run((tx) => recoverLegacyDailySnapshot(tx, apply, h.clock.now())),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(
      round === 0 ? ["already_applied", "applied"] : ["already_applied", "already_applied"],
    );
  }
  await expect(
    h.tx.run((tx) =>
      recoverLegacyDailySnapshot(tx, { ...apply, payloadHash: "f".repeat(64) }, h.clock.now()),
    ),
  ).rejects.toThrow("REPLAY_CONFLICT");
  expect(await h.prisma.subscriptionEventDailySupplement.count()).toBe(1);
  expect(
    await h.prisma.auditLog.count({ where: { action: "billing.subscription.recover_snapshot" } }),
  ).toBe(1);
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, sourceTables));
});
it("正式日投影共享补充读取，归属、指纹、内容篡改拒绝，原 payload 保持 null", async () => {
  const event = await h.prisma.subscriptionEvent.findUniqueOrThrow({
    where: { id: LEGACY_EVENT_ID },
  });
  const record = await h.prisma.subscriptionEventDailySupplement.findUniqueOrThrow({
    where: { eventId: event.id },
  });
  expect(resolveLegacyDailyPayload(event, [record])).toEqual(captured);
  for (const changed of [
    { ...record, entityId: record.id },
    { ...record, evidenceHash: "f".repeat(64) },
    { ...record, payload: {}, payloadHash: legacyHash({}) },
    { ...record, eventFingerprint: "f".repeat(64) },
  ])
    expect(() => resolveLegacyDailyPayload(event, [changed])).toThrow();
  expect(() => resolveLegacyDailyPayload({ ...event, payload: {} }, [record])).toThrow();
  const before = await snapshotTables(h.prisma, sourceTables);
  const projected = await computeEntityDaily(h.prisma, entityId, "2040-11-19", h.clock.now());
  const projection = createBillingDailyProjection({ ledger: h.ledger });
  await h.tx.run((tx) => projection.snapshot(tx, entityId, "2040-11-19"));
  expect(
    await h.prisma.billingEntityDaily.findMany({
      where: { entityId },
      orderBy: { bizDate: "asc" },
    }),
  ).toEqual(projected.days);
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, sourceTables));
  for (const invariant of subscriptionInvariants.filter((rule) =>
    ["billing.I11", "billing.I13"].includes(rule.code),
  )) {
    const violations = await h.tx.run((tx) =>
      invariant.run!(tx, { entityIds: [entityId] }, { now: h.clock.now() }),
    );
    expect(violations, invariant.code).toEqual([]);
  }
  expect(event.payload).toBeNull();
});
