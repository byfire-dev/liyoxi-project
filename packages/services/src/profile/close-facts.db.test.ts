import type { PrismaClient } from "@liyoxi/db";
import { beforeAll, expect, it } from "vitest";
import { uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { createFactories, useSeededDatabase } from "../testing/index.js";
import { complete, harness, submit } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { countQualificationSubmissionsInReview, countUnverifiedPrimaryStore } from "./index.js";

const db = useSeededDatabase("services", { max: 1 });
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);

type Outcome = "approved" | "rejected" | "withdrawn" | "discarded" | null;

// new_store/change 写侧尚未交付；这里仅构造符合正式约束的计数事实，不代替其 producer 验收。
async function roundFact(
  connection: PrismaClient | Tx,
  store: { id: string; entityId: string },
  userId: string,
  kind: "initial" | "new_store" | "change",
  roundNo: number | null,
  outcome: Outcome = null,
) {
  const now = h.clock.now();
  const submitted = roundNo !== null;
  const closed = outcome !== null;
  const approval = submitted
    ? await connection.approvalRequest.create({
        data: {
          id: uuidv7(),
          kind: "qualification",
          category: "review",
          subjectType: "store",
          subjectId: store.id,
          entityId: store.entityId,
          storeId: store.id,
          roundNo,
          status: outcome ?? "pending",
          summarySnapshot: { title: "资质计数事实" },
          submitActorType: "merchant",
          submitActorId: userId,
          submitClient: "weapp",
          submittedAt: now,
          decidedAt: closed ? now : null,
          isDecidedBySystem: outcome === "approved" || outcome === "rejected",
          decisionNote: outcome === "rejected" ? "计数事实" : null,
          dedupeKey: `qualification:${store.id}`,
          createdAt: now,
          updatedAt: now,
        },
      })
    : null;
  return connection.qualificationSubmission.create({
    data: {
      id: uuidv7(),
      entityId: store.entityId,
      storeId: store.id,
      kind,
      roundNo,
      claimedEntityType: submitted && kind === "initial" ? "enterprise" : null,
      proposedStoreName: submitted ? "计数门店" : null,
      proposedIndustryCode: submitted ? "C900" : null,
      proposedCategoryCode: submitted ? "C901" : null,
      ...(submitted ? { proposedAddressSnapshot: { detail: "测试路一号" } } : {}),
      changedFields: kind === "change" ? ["docs"] : [],
      declarationConfirmedAt: submitted ? now : null,
      declarationVersion: submitted ? "1" : null,
      approvalRequestId: approval?.id ?? null,
      submittedAt: submitted ? now : null,
      submittedByUserId: submitted ? userId : null,
      closedAt: closed ? now : null,
      outcome,
      approveMode: outcome === "approved" ? "normal" : null,
      createdByUserId: userId,
      createdAt: now,
      updatedAt: now,
    },
  });
}

it("真实 initial 提交前不阻断，公开提交后在同事务读到在审轮次", async () => {
  const { viewer, store } = await h.owner();
  const ready = await complete(h, viewer);
  await h.tx.run(async (t) => {
    expect(await countQualificationSubmissionsInReview(t, store.id)).toBe(0);
    expect(await countUnverifiedPrimaryStore(t, store.id)).toBe(1);
  });
  await submit(h, viewer, ready.submissionId);
  await h.tx.run(async (t) => {
    expect(await countQualificationSubmissionsInReview(t, store.id)).toBe(1);
    expect(await countUnverifiedPrimaryStore(t, store.id)).toBe(1);
  });
}, 60000);

it("三种轮次均只计已提交未关闭，草稿及全部关闭结论排除并隔离门店", async () => {
  for (const kind of ["initial", "new_store", "change"] as const) {
    const user = await h.make.merchantUser();
    const entity = await h.make.entity({ createdByUserId: user.id });
    const store = await h.make.store({ entityId: entity.id });
    const sibling = await h.make.store({ entityId: entity.id });
    const foreign = await h.make.store();
    for (const [index, outcome] of (["approved", "rejected", "withdrawn"] as const).entries())
      await roundFact(h.prisma, store, user.id, kind, index + 1, outcome);
    await roundFact(h.prisma, store, user.id, kind, null, "discarded");
    await roundFact(h.prisma, store, user.id, kind, null);
    await h.tx.run(async (t) => {
      expect(await countQualificationSubmissionsInReview(t, store.id)).toBe(0);
    });
    // 在本测试夹具中关闭草稿后插入在审事实，不宣称完成未来资质写侧。
    await h.prisma.qualificationSubmission.updateMany({
      where: { storeId: store.id, closedAt: null },
      data: { closedAt: h.clock.now(), outcome: "discarded" },
    });
    await roundFact(h.prisma, store, user.id, kind, 4);
    await h.tx.run(async (t) => {
      expect(await countQualificationSubmissionsInReview(t, store.id)).toBe(1);
      expect(await countQualificationSubmissionsInReview(t, sibling.id)).toBe(0);
      expect(await countQualificationSubmissionsInReview(t, foreign.id)).toBe(0);
    });
  }
}, 60000);

it("四种主体认证结论与首店标记组合，重复读取不改事实或证据", async () => {
  const stores: { primary: string; sibling: string; expected: number }[] = [];
  for (const verificationStatus of ["unsubmitted", "pending", "rejected", "verified"]) {
    const entity = await h.make.entity({ verificationStatus });
    const primary = await h.make.store({ entityId: entity.id, isPrimary: true });
    const sibling = await h.make.store({ entityId: entity.id });
    stores.push({
      primary: primary.id,
      sibling: sibling.id,
      expected: verificationStatus === "verified" ? 0 : 1,
    });
  }
  const snapshot = async () => ({
    rounds: await h.prisma.qualificationSubmission.findMany({ orderBy: { id: "asc" } }),
    approvals: await h.prisma.approvalRequest.findMany({ orderBy: { id: "asc" } }),
    stores: await h.prisma.store.findMany({ orderBy: { id: "asc" } }),
    entities: await h.prisma.entity.findMany({ orderBy: { id: "asc" } }),
    audit: await h.prisma.auditLog.count(),
    history: await h.prisma.statusTransition.count(),
    outbox: await h.prisma.outboxEvent.count(),
  });
  const before = await snapshot();
  for (let n = 0; n < 2; n++)
    await h.tx.run(async (t) => {
      for (const store of stores) {
        expect(await countUnverifiedPrimaryStore(t, store.primary)).toBe(store.expected);
        expect(await countUnverifiedPrimaryStore(t, store.sibling)).toBe(0);
        await countQualificationSubmissionsInReview(t, store.primary);
      }
      expect(await countUnverifiedPrimaryStore(t, uuidv7())).toBe(0);
      expect(await countQualificationSubmissionsInReview(t, uuidv7())).toBe(0);
    });
  expect(await snapshot()).toEqual(before);
}, 60000);

it("复用调用方未提交的主体门店与资质事实，外层失败整批回滚", async () => {
  let storeId = "";
  let entityId = "";
  await expect(
    h.tx.run(async (t) => {
      const make = createFactories({ db: t, clock: h.clock });
      const entity = await make.entity();
      const store = await make.store({ entityId: entity.id, isPrimary: true });
      storeId = store.id;
      entityId = entity.id;
      await roundFact(t, store, entity.createdByUserId, "initial", 1);
      expect(await countQualificationSubmissionsInReview(t, store.id)).toBe(1);
      expect(await countUnverifiedPrimaryStore(t, store.id)).toBe(1);
      throw new Error("测试调用方回滚");
    }),
  ).rejects.toThrow("测试调用方回滚");
  await h.tx.run(async (t) => {
    expect(await countQualificationSubmissionsInReview(t, storeId)).toBe(0);
    expect(await countUnverifiedPrimaryStore(t, storeId)).toBe(0);
  });
  expect(await h.prisma.entity.count({ where: { id: entityId } })).toBe(0);
  expect(await h.prisma.store.count({ where: { id: storeId } })).toBe(0);
  expect(await h.prisma.approvalRequest.count({ where: { storeId } })).toBe(0);
}, 60000);
