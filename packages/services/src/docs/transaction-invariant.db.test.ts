import { beforeAll, expect, it } from "vitest";
import { createTxRunner, defineRegistration, notifyReadPort, uuidv7 } from "../kernel/index.js";
import type { Tx, TxRunner } from "../kernel/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  useSeededDatabase,
} from "../testing/index.js";
import { findN5Violations } from "./transaction-invariant.js";

const db = useSeededDatabase("services");
const clock = createClock(new Date("2026-10-08T08:00:00.000Z"));
let runner: TxRunner;
beforeAll(async () => {
  runner = createTxRunner({ prisma: await db.prisma(), appEnv: "test" });
}, 120_000);
async function isolated(run: (tx: Tx) => Promise<void>) {
  const rollback = new Error("fictional consent fixture rollback");
  await expect(
    runner.run(async (tx) => {
      await run(tx);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
}
const actual = () => assembleForTest({ entry: "worker" });
const ownFailures = async (tx: Tx, id: string) =>
  (await findN5Violations(tx, actual())).filter(
    (item) => item.subject !== undefined && "id" in item.subject && item.subject.id === id,
  );

it("N5 reads a real submitted order and its selected consent through owning-domain registration", async () => {
  await isolated(async (tx) => {
    const order = await createFactories({ db: tx, clock }).dramaOrder();
    expect(await ownFailures(tx, order.id)).toEqual([]);
  });
});

it("N5 reads both required agreements for an actual paid weapp billing order", async () => {
  await isolated(async (tx) => {
    const order = await createFactories({ db: tx, clock }).billingOrder();
    const failures = await ownFailures(tx, order.id);
    expect(failures).toHaveLength(2);
    expect(failures.map((item) => item.detail?.["agreementKey"]).sort()).toEqual([
      "member",
      "points",
    ]);
    expect(failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: { type: "billing_order", id: order.id },
          detail: { problem: "missing_consent", agreementKey: "member" },
        }),
        expect.objectContaining({
          subject: { type: "billing_order", id: order.id },
          detail: { problem: "missing_consent", agreementKey: "points" },
        }),
      ]),
    );
  });
});

it("N5 rejects an existing consent belonging to a different business object", async () => {
  await isolated(async (tx) => {
    const make = createFactories({ db: tx, clock });
    const own = await make.merchant();
    const wrong = await make.agreementConsent({
      entityId: own.entity.id,
      storeId: own.store.id,
      merchantUserId: own.user.id,
      bizId: uuidv7(),
    });
    const order = await make.dramaOrder({
      entityId: own.entity.id,
      storeId: own.store.id,
      placedByUserId: own.user.id,
      agreementConsentId: wrong.id,
    });
    expect(await ownFailures(tx, order.id)).toMatchObject([
      {
        subject: { type: "drama_order", id: order.id },
        detail: { problem: "missing_consent", agreementKey: "custom_license" },
      },
    ]);
  });
});

it("N5 checks actual entity and business number instead of accepting an existing consent id", async () => {
  await isolated(async (tx) => {
    const make = createFactories({ db: tx, clock });
    const own = await make.merchant();
    const other = await make.merchant();
    const orderId = uuidv7();
    const wrong = await make.agreementConsent({
      entityId: other.entity.id,
      storeId: other.store.id,
      merchantUserId: other.user.id,
      bizId: orderId,
      bizNo: "LYX261008900001",
    });
    const order = await make.dramaOrder({
      id: orderId,
      entityId: own.entity.id,
      storeId: own.store.id,
      placedByUserId: own.user.id,
      orderNo: "LYX261008900002",
      agreementConsentId: wrong.id,
    });
    expect(await ownFailures(tx, order.id)).toMatchObject([
      { detail: { problem: "consent_reference_mismatch" } },
    ]);
  });
});

it("N5 rejects consent collected after the business transaction", async () => {
  await isolated(async (tx) => {
    const order = await createFactories({ db: tx, clock }).dramaOrder({
      submittedAt: new Date(clock.now().getTime() - 1),
    });
    expect(await ownFailures(tx, order.id)).toMatchObject([
      { detail: { problem: "consent_version_not_effective" } },
    ]);
  });
});

it("N5 checks the effective version at consent time; later effective versions do not invalidate history", async () => {
  await isolated(async (tx) => {
    const make = createFactories({ db: tx, clock });
    const order = await make.dramaOrder();
    await make.agreementVersion({
      agreementKey: "custom_license",
      status: "pending",
      effectiveAt: new Date(clock.now().getTime() + 60_000),
    });
    expect(await ownFailures(tx, order.id)).toEqual([]);
  });
});

it("N5 rejects signing an older version after a newer version has become effective", async () => {
  await isolated(async (tx) => {
    const make = createFactories({ db: tx, clock });
    const version = await make.agreementVersion({
      agreementKey: "custom_license",
      effectiveAt: new Date(clock.now().getTime() - 60_000),
    });
    await make.agreementVersion({
      agreementKey: "custom_license",
      status: "pending",
      effectiveAt: new Date(clock.now().getTime() - 1),
    });
    const order = await make.dramaOrder();
    expect(
      (await tx.agreementConsent.findUniqueOrThrow({ where: { id: order.agreementConsentId } }))
        .agreementVersionId,
    ).toBe(version.id);
    expect(await ownFailures(tx, order.id)).toMatchObject([
      { detail: { problem: "consent_version_not_effective" } },
    ]);
  });
});

it("N5 treats missing domain registration as a failed check, not zero violations", async () => {
  await isolated(async (tx) => {
    const missing = assembleForTest({
      entry: "worker",
      isolated: true,
      extra: [defineRegistration("lyxtest_docs_missing", { ports: [notifyReadPort] })],
    });
    await expect(findN5Violations(tx, missing)).rejects.toThrow("缺少实际单据事实登记");
  });
});
