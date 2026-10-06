import { beforeAll, describe, expect, it } from "vitest";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { complete, harness, submit } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { findViolations, PROFILE_INVARIANT_CODES } from "./invariants.js";
// 属主仅供本文件隔离测试库的 I1 回滚夹具；不改迁移或共享库。
const db = useSeededDatabase("services", { role: null });
let h: Harness;
const ctx = createIdentityContext({ actor: { type: "system", job: "lyxtest.profile_invariant" } });
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
const check = (code: (typeof PROFILE_INVARIANT_CODES)[number], entityId: string) =>
  h.tx.run((tx) => findViolations(tx, code, { entityIds: [entityId] }, { now: h.clock.now() }));
async function approved() {
  const owner = await h.owner(),
    ready = await complete(h, owner.viewer);
  await submit(h, owner.viewer, ready.submissionId);
  await h.profile.approve(ctx, ready.submissionId, { lockVersion: 0, confirm: { roundNo: 1 } });
  return { ...owner, ...ready };
}
describe("profile 九项全量不变量", { timeout: 60000 }, () => {
  it("正常提交通过的库九项均零违规", async () => {
    const { entity } = await approved();
    for (const code of PROFILE_INVARIANT_CODES)
      expect(await check(code, entity.id), code).toEqual([]);
  });
  it("I1 索引损坏反例仅在本测试会话单事务，强制回滚恢复索引与唯一性", async () => {
    const { viewer, entity, store, user } = await h.owner();
    await h.profile.updateQualification(viewer, { lockVersion: null });
    const session = process.env.LYX_TEST_SESSION;
    expect(session).toMatch(/^[a-z0-9]{1,12}$/);
    expect(db.name.startsWith(`lyx_test_services_${session}_`)).toBe(true);
    const rollback = new Error("lyxtest_I1_force_rollback");
    await expect(
      h.tx.run(async (tx) => {
        const [current] = await tx.$queryRawUnsafe<{ name: string }[]>(
          "SELECT current_database() AS name",
        );
        expect(current!.name).toBe(db.name);
        await tx.$executeRawUnsafe("DROP INDEX uq_qualification_submission_open");
        await tx.$executeRawUnsafe("DROP INDEX uq_qualification_submission_entity_open");
        await tx.qualificationSubmission.create({
          data: {
            id: uuidv7(),
            storeId: store.id,
            entityId: entity.id,
            kind: "initial",
            createdByUserId: user.id,
            createdAt: h.clock.now(),
            updatedAt: h.clock.now(),
          },
        });
        expect(await findViolations(tx, "I1", { entityIds: [entity.id] })).toMatchObject([
          { subject: { type: "store", id: store.id } },
        ]);
        throw rollback;
      }),
    ).rejects.toBe(rollback);
    const indexes = await h.prisma.$queryRawUnsafe<{ name: string }[]>(
      "SELECT indexname AS name FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('uq_qualification_submission_open', 'uq_qualification_submission_entity_open')",
    );
    expect(indexes).toHaveLength(2);
    expect(await check("I1", entity.id)).toEqual([]);
    await expect(
      h.prisma.qualificationSubmission.create({
        data: {
          id: uuidv7(),
          storeId: store.id,
          entityId: entity.id,
          kind: "initial",
          createdByUserId: user.id,
          createdAt: h.clock.now(),
          updatedAt: h.clock.now(),
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });
  it("I2 审批待审与已关闭轮次不一致", async () => {
    const { viewer, entity } = await h.owner(),
      ready = await complete(h, viewer);
    await submit(h, viewer, ready.submissionId);
    await h.prisma.qualificationSubmission.update({
      where: { id: ready.submissionId },
      data: { closedAt: h.clock.now(), outcome: "rejected" },
    });
    expect(await check("I2", entity.id)).toMatchObject([{ subject: { id: ready.submissionId } }]);
  });
  it("I3 门店 pending 与在审轮次不一致", async () => {
    const { viewer, store, entity } = await h.owner(),
      ready = await complete(h, viewer);
    await submit(h, viewer, ready.submissionId);
    await h.prisma.store.update({
      where: { id: store.id },
      data: { qualificationStatus: "unsubmitted" },
    });
    expect(await check("I3", entity.id)).toHaveLength(1);
  });
  it("I4 生效执照盲索引不同于主体", async () => {
    const { entity, docId } = await approved();
    await h.prisma.qualificationDoc.update({
      where: { id: docId },
      data: { certNoBidx: Buffer.alloc(32, 0x09) },
    });
    expect(await check("I4", entity.id)).toHaveLength(1);
  });
  it("I5 已通过门店缺少品类新增许可证", async () => {
    const { entity } = await approved();
    await h.prisma.dictItem.update({
      where: { dictTypeKey_code: { dictTypeKey: "industry", code: "C901" } },
      data: { ext: { open: true, special: false, requiredCerts: ["P01"] } },
    });
    try {
      expect(await check("I5", entity.id)).toMatchObject([{ detail: { missingPermits: ["P01"] } }]);
    } finally {
      await h.prisma.dictItem.update({
        where: { dictTypeKey_code: { dictTypeKey: "industry", code: "C901" } },
        data: { ext: { open: true, special: false, requiredCerts: [] } },
      });
    }
  });
  it("I6 三列完整度缓存一起自愈且不改乐观锁版本", async () => {
    const { entity, store } = await approved();
    const old = await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: store.id } });
    await h.prisma.storeProfile.update({
      where: { storeId: store.id },
      data: { completenessPct: 1, requiredFilled: 1, requiredTotal: 2 },
    });
    expect(await check("I6", entity.id)).toMatchObject([{ healed: { at: h.clock.now() } }]);
    expect(
      await h.prisma.storeProfile.findUniqueOrThrow({ where: { storeId: store.id } }),
    ).toMatchObject({
      completenessPct: 100,
      requiredFilled: 15,
      requiredTotal: 15,
      lockVersion: old.lockVersion,
    });
    expect(await check("I6", entity.id)).toEqual([]);
  });
  it("I8 最近通过快照与当前档案地址不一致", async () => {
    const { entity, store } = await approved();
    await h.prisma.storeProfile.update({
      where: { storeId: store.id },
      data: { addressDetail: "错误写回地址" },
    });
    expect(await check("I8", entity.id)).toHaveLength(1);
  });
  it("I9 未移除证照丢失 live 引用", async () => {
    const { entity, docId } = await approved();
    await h.prisma.fileRef.updateMany({
      where: { refType: "qualification_doc", refId: docId },
      data: {
        state: "released",
        releasedAt: h.clock.now(),
        keepUntil: new Date(h.clock.now().getTime() + 7 * 86400000),
      },
    });
    expect(await check("I9", entity.id)).toMatchObject([{ subject: { id: docId } }]);
  });
  it("I10 无门店的主体 pending 也必须有在审 initial", async () => {
    const entity = await h.make.entity({ verificationStatus: "pending" });
    expect(await check("I10", entity.id)).toMatchObject([
      { subject: { type: "entity", id: entity.id } },
    ]);
  });
});
