import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { calendarDate } from "@liyoxi/shared/time";
import {
  createLicenseConvergenceFixture,
  useSeededDatabase,
  useTestRedis,
} from "../testing/index.js";
import {
  canonicalLicenseJson,
  licenseContentFingerprint,
  reconcileLetters,
} from "./license-convergence.js";
import { parseLicenseLetterSnapshot } from "./license-facts.js";
import { findN6Violations } from "./license-invariants.js";
import type { LicenseConvergenceDeps, LicenseFacts } from "./license-facts.js";

const db = useSeededDatabase("services", { max: 1 }),
  redis = useTestRedis();
type Fixture = Awaited<ReturnType<typeof createLicenseConvergenceFixture>>;
let active: Fixture | undefined;
async function fresh() {
  active = await createLicenseConvergenceFixture(await db.prisma(), {
    databaseUrl: await db.url(),
    redisUrl: process.env.REDIS_URL!,
    redisKeyPrefix: redis.prefix,
  });
  return active;
}
afterEach(async () => {
  await active?.close();
  active = undefined;
});
const rows = async (f: Fixture) =>
  (await db.prisma()).licenseLetter.findMany({
    where: { orderItemId: f.order.itemId },
    include: { revisions: { orderBy: { revNo: "asc" } } },
    orderBy: { letterNo: "asc" },
  });
const align = (f: Fixture, deps = f.licenseDeps, trigger = "test:current-facts") =>
  f.runtime.tx.run((tx) => reconcileLetters(tx, deps, [f.order.itemId], trigger));
// Explicit injected-fact writer tests: these do not claim unimplemented M6 / post-confirmation producers.
const injected = (
  f: Fixture,
  map: (fact: LicenseFacts) => LicenseFacts,
): LicenseConvergenceDeps => ({
  ...f.licenseDeps,
  facts: {
    ...f.licenseDeps.facts,
    getLicenseFacts: async (tx, ids) =>
      (await f.licenseDeps.facts.getLicenseFacts(tx, ids)).map(map),
  },
});

describe("授权当前事实唯一writer", { timeout: 120000 }, () => {
  it("真实订购未开工零信；真实开工后双账号首版含真实历史同意、许可及法定快照；重放零写", async () => {
    const f = await fresh();
    expect(await align(f)).toMatchObject({ created: 0, revised: 0, voided: 0 });
    await f.start();
    expect(await align(f)).toMatchObject({ created: 2, revised: 0 });
    const before = await rows(f);
    expect(before).toHaveLength(2);
    const consent = await (
      await db.prisma()
    ).agreementConsent.findFirstOrThrow({
      where: { bizId: f.order.id, agreementKey: "custom_license" },
    });
    for (const letter of before) {
      expect(letter.status).toBe("pending_effective");
      expect(letter.currentRevisionId).toBeNull();
      expect(letter.revisions).toHaveLength(1);
      const revision = letter.revisions[0]!,
        value = parseLicenseLetterSnapshot(revision.letterSnapshot);
      expect(revision.renderStatus).toBe("queued");
      expect(value.consent.consentNo).toBe(String(consent.seq));
      expect(value.orderNo).toBe(
        (await (await db.prisma()).dramaOrder.findUniqueOrThrow({ where: { id: f.order.id } }))
          .orderNo,
      );
      expect(value.period.start).toBeNull();
      expect(value.period.territory).not.toBe("");
      expect(value.licensor.creditCode).toHaveLength(18);
      expect(value.licensee.creditCode).toHaveLength(18);
      expect(new URL(value.verifyUrl).searchParams.get("rev")).toBe("1");
      expect(revision.contentFp).toBe(licenseContentFingerprint(value));
    }
    const evidence = await evidenceCounts(f);
    expect(
      await f.runtime.tx.run((tx) =>
        reconcileLetters(
          tx,
          f.licenseDeps,
          [f.order.itemId.toUpperCase(), f.order.itemId],
          "test:uuid-alias",
        ),
      ),
    ).toMatchObject({ created: 0, revised: 0, voided: 0 });
    expect(await align(f)).toMatchObject({ created: 0, revised: 0, voided: 0 });
    expect(await rows(f)).toEqual(before);
    expect(await evidenceCounts(f)).toEqual(evidence);
  });

  it("纯注入三法律项：统一起日、止日、撤上线和ended派生；名称变化不自动改版", async () => {
    const f = await fresh();
    await f.start();
    await align(f);
    const start = calendarDate(f.clock.now());
    const live = injected(f, (fact) => ({ ...fact, phase: "live", usageStartDate: start }));
    expect(await align(f, live)).toMatchObject({ revised: 2 });
    const liveRows = await rows(f);
    expect(
      liveRows.every(
        (letter) =>
          letter.status === "effective" &&
          letter.periodStart?.toISOString().slice(0, 10) === start &&
          letter.revisions.at(-1)?.reason === "go_live",
      ),
    ).toBe(true);
    const queuedEvidence = await evidenceCounts(f);
    const notRendered = await f.runtime.tx.run((tx) =>
      findN6Violations(tx, live, { entityIds: [f.merchant.entity.id] }),
    );
    expect(notRendered).toHaveLength(2);
    expect(
      notRendered.every(
        (row) =>
          row.detail.problem === "effective_without_ready_revision" && row.healed === undefined,
      ),
    ).toBe(true);
    expect(await evidenceCounts(f)).toEqual(queuedEvidence);
    const renamed = injected(f, (fact) => ({
      ...fact,
      phase: "live",
      usageStartDate: start,
      accounts: fact.accounts.map((account) => ({ ...account, name: "名称笔误更正留后继" })),
    }));
    expect(await align(f, renamed)).toMatchObject({ created: 0, revised: 0, voided: 0 });
    const end = "2030-12-31",
      transitionCount = await (
        await db.prisma()
      ).statusTransition.count({
        where: {
          machine: "license_letter",
          subjectId: { in: liveRows.map((letter) => letter.id) },
        },
      });
    expect(
      await align(
        f,
        injected(f, (fact) => ({
          ...fact,
          phase: "live",
          usageStartDate: start,
          usageEndDate: end,
        })),
      ),
    ).toMatchObject({ revised: 2 });
    expect(
      await (
        await db.prisma()
      ).statusTransition.count({
        where: {
          machine: "license_letter",
          subjectId: { in: liveRows.map((letter) => letter.id) },
        },
      }),
    ).toBe(transitionCount);
    expect(
      await align(
        f,
        injected(f, (fact) => ({
          ...fact,
          phase: "ended",
          usageStartDate: start,
          usageEndDate: end,
        })),
      ),
    ).toMatchObject({ revised: 0, voided: 0 });
    expect(
      await align(
        f,
        injected(f, (fact) => ({ ...fact, phase: "to_launch", usageEndDate: end })),
      ),
    ).toMatchObject({ revised: 2 });
    expect(
      (await rows(f)).every(
        (letter) => letter.status === "pending_effective" && letter.periodStart === null,
      ),
    ).toBe(true);
  });

  it("真实首次确认移出账号即作废；纯注入重选新建且旧信/验真码不复活，终态乱序不建信", async () => {
    const f = await fresh();
    await f.start();
    await align(f);
    const initial = await rows(f);
    await f.confirmAccounts([f.accounts[0]]);
    expect(await align(f)).toMatchObject({ voided: 1 });
    const removed = (await rows(f)).find((letter) => letter.channelAccountId === f.accounts[1])!;
    expect(removed).toMatchObject({ status: "voided", voidReason: "account_removed" });
    const selected = initial.map((letter) => ({
      channelAccountId: letter.channelAccountId,
      platform: letter.platform,
      name: "纯注入重选事实",
      accountNo: `test-${letter.platform}`,
    }));
    expect(
      await align(
        f,
        injected(f, (fact) => ({ ...fact, accounts: selected })),
      ),
    ).toMatchObject({ created: 1 });
    const after = await rows(f),
      replacement = after.find(
        (letter) =>
          letter.channelAccountId === removed.channelAccountId && letter.status !== "voided",
      )!;
    expect(replacement.id).not.toBe(removed.id);
    expect(replacement.letterNo).toBe(`${removed.letterNo}-2`);
    expect(replacement.verifyCode).not.toBe(removed.verifyCode);
    expect(after.find((letter) => letter.id === removed.id)?.status).toBe("voided");
    const terminal = injected(f, (fact) => ({ ...fact, phase: "cancelled", accounts: selected }));
    expect(await align(f, terminal)).toMatchObject({ voided: 2 });
    expect(await align(f, terminal, "late:order.started")).toMatchObject({
      created: 0,
      revised: 0,
      voided: 0,
    });
    expect((await rows(f)).every((letter) => letter.status === "voided")).toBe(true);
  });

  it("缺origin的新快照受控回滚，作废旧信不需要origin或主体配置", async () => {
    const f = await fresh();
    await f.start();
    const missing = {
      ...f.licenseDeps,
      snapshot: { ...f.licenseDeps.snapshot, portalOrigin: undefined },
    };
    await expect(align(f, missing)).rejects.toMatchObject({ error: "PROVIDER_UNAVAILABLE" });
    expect(await rows(f)).toEqual([]);
    await align(f);
    const terminal = {
      ...injected(f, (fact) => ({ ...fact, phase: "terminated" })),
      snapshot: missing.snapshot,
    };
    expect(await align(f, terminal)).toMatchObject({ voided: 2 });
    expect((await rows(f)).every((letter) => letter.voidReason === "terminated")).toBe(true);
  });
});

async function evidenceCounts(f: Fixture) {
  const prisma = await db.prisma(),
    ids = (await rows(f)).map((letter) => letter.id);
  return {
    revisions: await prisma.licenseLetterRevision.count({
      where: { licenseLetterId: { in: ids } },
    }),
    events: await prisma.outboxEvent.count({ where: { aggregateId: { in: ids } } }),
    histories: await prisma.statusTransition.count({
      where: { machine: "license_letter", subjectId: { in: ids } },
    }),
    audits: await prisma.auditLog.count({ where: { targetId: { in: ids } } }),
  };
}

it("规范JSON按UTF16码元排序非ASCII键，快照严格解析不回显敏感输入", () => {
  const expected = '{"Z":1,"a":{"é":2,"中":3},"é":4,"中":5,"😀":6}';
  const value = { "😀": 6, 中: 5, é: 4, a: { 中: 3, é: 2 }, Z: 1 };
  expect(canonicalLicenseJson(value)).toBe(expected);
  expect(createHash("sha256").update(canonicalLicenseJson(value), "utf8").digest("hex")).toBe(
    createHash("sha256").update(expected, "utf8").digest("hex"),
  );
  expect(() => canonicalLicenseJson({ missing: undefined })).toThrow();
  try {
    parseLicenseLetterSnapshot({ licensee: { creditCode: "private-marker" }, surprise: true });
    expect.fail();
  } catch (error) {
    expect((error as Error).message).not.toContain("private-marker");
    expect(error).toMatchObject({ error: "PRECONDITION_CHANGED" });
  }
});
