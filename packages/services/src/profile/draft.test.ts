import { beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";

const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);

async function auditOf(id: string) {
  return h.prisma.auditLog.findFirstOrThrow({
    where: { targetId: id, action: "profile.qualification.save" },
    orderBy: { id: "desc" },
  });
}
describe("资质草稿审计实际值", { timeout: 60000 }, () => {
  it("显式清空主体类型记录真实变化，未传声明保持原值且不误记", async () => {
    const { viewer } = await h.owner();
    const initial = await h.profile.updateQualification(viewer, {
      lockVersion: null,
      claimedEntityType: "enterprise",
      declarationConfirmed: true,
      declarationVersion: "1",
    });
    const id = initial.openRound!.qualificationSubmissionId;
    const confirmedAt = h.clock.now();
    h.clock.advance(1000);
    await h.profile.updateQualification(viewer, {
      lockVersion: initial.openRound!.lockVersion,
      claimedEntityType: null,
    });
    expect(
      await h.prisma.qualificationSubmission.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({
      claimedEntityType: null,
      declarationConfirmedAt: confirmedAt,
      declarationVersion: "1",
    });
    expect(await auditOf(id)).toMatchObject({
      before: { claimedEntityType: "enterprise" },
      after: { claimedEntityType: null },
    });
  });
  it("声明未传无虚假变更，取消记真空，重新确认记本次版本与时间", async () => {
    const { viewer } = await h.owner();
    const initial = await h.profile.updateQualification(viewer, {
      lockVersion: null,
      claimedEntityType: "enterprise",
      declarationConfirmed: true,
      declarationVersion: "1",
    });
    const id = initial.openRound!.qualificationSubmissionId;
    const confirmedAt = h.clock.now();
    h.clock.advance(1000);
    const unchanged = await h.profile.updateQualification(viewer, {
      lockVersion: initial.openRound!.lockVersion,
    });
    expect(await auditOf(id)).toMatchObject({ before: null, after: null });
    expect(
      await h.prisma.qualificationSubmission.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ declarationConfirmedAt: confirmedAt, declarationVersion: "1" });
    const cleared = await h.profile.updateQualification(viewer, {
      lockVersion: unchanged.openRound!.lockVersion,
      declarationConfirmed: false,
    });
    expect(await auditOf(id)).toMatchObject({
      before: { declarationConfirmedAt: confirmedAt.toISOString(), declarationVersion: "1" },
      after: { declarationConfirmedAt: null, declarationVersion: null },
    });
    h.clock.advance(1000);
    await h.profile.updateQualification(viewer, {
      lockVersion: cleared.openRound!.lockVersion,
      declarationConfirmed: true,
      declarationVersion: "1",
    });
    expect(await auditOf(id)).toMatchObject({
      before: { declarationConfirmedAt: null, declarationVersion: null },
      after: { declarationConfirmedAt: h.clock.now().toISOString(), declarationVersion: "1" },
    });
    expect(
      await h.prisma.qualificationSubmission.findUniqueOrThrow({ where: { id } }),
    ).toMatchObject({ declarationConfirmedAt: h.clock.now(), declarationVersion: "1" });
  });
});
