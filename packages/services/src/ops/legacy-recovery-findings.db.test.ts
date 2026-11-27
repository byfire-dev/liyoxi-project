import { Prisma } from "@liyoxi/db";
import { beforeAll, expect, it, vi } from "vitest";
import {
  createPaymentHarness,
  pendingPlanOrder,
  transferReceipt,
  useSeededDatabase,
  snapshotTables,
  assertSnapshotsEqual,
} from "../testing/index.js";
import type { PaymentHarness } from "../testing/index.js";
import {
  recoverLegacyDailySnapshot,
  LegacyRecoveryInputSchema,
  createBillingDailyProjection,
} from "../billing/index.js";
import type { LegacyRecoveryInput } from "../billing/index.js";
import {
  LEGACY_RECOVERY_FINDING_IDS,
  resolveLegacyRecoveryFindings,
} from "./legacy-recovery-findings.js";
const LEGACY_EVENT_ID = LegacyRecoveryInputSchema.shape.eventId.value;
const db = useSeededDatabase("services", { max: 2 });
let h: PaymentHarness, entityId: string, input: LegacyRecoveryInput;
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
  const preview = await h.tx.run((tx) => recoverLegacyDailySnapshot(tx, input, h.clock.now()));
  await h.tx.run((tx) =>
    recoverLegacyDailySnapshot(
      tx,
      {
        ...input,
        apply: true,
        evidenceHash: preview.evidenceHash,
        payloadHash: preview.payloadHash,
      },
      h.clock.now(),
    ),
  );
}, 120_000);

it("历史违规收尾在投影缺失时拒绝，不将缺少估值或日快照误记为已处理", async () => {
  const preview = await h.tx.run((tx) => recoverLegacyDailySnapshot(tx, input, h.clock.now()));
  await expect(
    h.tx.run((tx) =>
      resolveLegacyRecoveryFindings(
        tx,
        {
          ...input,
          evidenceHash: preview.evidenceHash,
          payloadHash: preview.payloadHash,
          apply: true,
        },
        h.clock.now(),
      ),
    ),
  ).rejects.toThrow("CHECKS_FAILED");
  expect(await h.prisma.invariantViolation.count({ where: { resolvedAt: { not: null } } })).toBe(0);
});
it("只处理固定五条同主体旧违规，保留无关项；错范围拒绝，重复收尾不重复审计", async () => {
  const projection = createBillingDailyProjection({ ledger: h.ledger });
  await h.tx.run((tx) => projection.snapshot(tx, entityId, "2040-11-19"));
  const supplement = await h.prisma.subscriptionEventDailySupplement.findUniqueOrThrow({
    where: { eventId: LEGACY_EVENT_ID },
  });
  const apply = {
    ...input,
    apply: true,
    evidenceHash: supplement.evidenceHash,
    payloadHash: supplement.payloadHash,
  };
  const entry = await h.prisma.pointLedgerEntry.findFirstOrThrow({ where: { entityId } });
  const ids = [...LEGACY_RECOVERY_FINDING_IDS];
  await h.prisma.invariantViolation.createMany({
    data: ids.map((id, i) => ({
      id,
      code: i < 2 ? "billing.I11" : "billing.I13",
      module: "billing",
      severity: "P1",
      subjectType: i < 2 ? "point_lot" : "billing_entity_daily",
      subjectId: i < 2 ? entry.pointLotId : null,
      subjectKey: i < 2 ? null : `2040-11-${15 + i}:${entityId}`,
      detail: {
        entityId,
        problem: i < 2 ? "valuation_missing" : "history_snapshot_missing",
        ...(i < 2 ? { pointLedgerEntryId: entry.id } : {}),
      },
      firstSeenAt: h.clock.now(),
      lastSeenAt: h.clock.now(),
      ...(i === 1
        ? {
            resolvedAt: h.clock.now(),
            resolvedByStaffId: input.authorizedByStaffId,
            resolution: "prior verified finding",
          }
        : {}),
    })),
  });
  const otherId = "11111111-1111-4111-8111-111111111111";
  await h.prisma.invariantViolation.create({
    data: {
      id: otherId,
      code: "docs.N5",
      module: "docs",
      severity: "P2",
      detail: { entityId },
      firstSeenAt: h.clock.now(),
      lastSeenAt: h.clock.now(),
    },
  });
  const original = await h.prisma.invariantViolation.findUniqueOrThrow({ where: { id: ids[0] } });
  await h.prisma.invariantViolation.update({
    where: { id: ids[0] },
    data: { detail: { ...(original.detail as Record<string, unknown>), entityId: otherId } },
  });
  await expect(
    h.tx.run((tx) => resolveLegacyRecoveryFindings(tx, apply, h.clock.now())),
  ).rejects.toThrow("SCOPE_INVALID");
  await h.prisma.invariantViolation.update({
    where: { id: ids[0] },
    data: { detail: original.detail! },
  });
  const before = await snapshotTables(h.prisma, sourceTables);
  expect(
    await h.tx.run((tx) => resolveLegacyRecoveryFindings(tx, apply, h.clock.now())),
  ).toMatchObject({ status: "resolved", resolved: 4 });
  expect(
    await h.tx.run((tx) => resolveLegacyRecoveryFindings(tx, apply, h.clock.now())),
  ).toMatchObject({ status: "already_resolved", resolved: 0 });
  expect(
    await h.prisma.auditLog.count({ where: { action: "ops.invariant.resolve_legacy_recovery" } }),
  ).toBe(1);
  expect(
    (await h.prisma.invariantViolation.findUniqueOrThrow({ where: { id: otherId } })).resolvedAt,
  ).toBeNull();
  expect(
    await h.prisma.invariantViolation.count({
      where: {
        id: { in: ids },
        resolvedByStaffId: input.authorizedByStaffId,
        resolvedAt: h.clock.now(),
      },
    }),
  ).toBe(5);
  assertSnapshotsEqual(before, await snapshotTables(h.prisma, sourceTables));
});
