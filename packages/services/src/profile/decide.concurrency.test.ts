import { beforeAll, describe, expect, it } from "vitest";
import { createIdentityContext } from "../kernel/index.js";
import { sampleStaffContext, useSeededDatabase } from "../testing/index.js";
import { complete, harness, submit, uscc } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
describe("审核并发", { timeout: 60000 }, () => {
  it("两名真实审核员通过×驳回仅一个成功", async () => {
    const { viewer } = await h.owner(),
      ready = await complete(h, viewer);
    await submit(h, viewer, ready.submissionId);
    const a = await h.make.staff({ staffRoleKey: "super_admin" }),
      b = await h.make.staff({ staffRoleKey: "super_admin" });
    const ac = createIdentityContext({ actor: { type: "staff", id: a.id, client: "admin" } }),
      bc = createIdentityContext({ actor: { type: "staff", id: b.id, client: "admin" } });
    const results = await Promise.allSettled([
      h.profile.approve(ac, ready.submissionId, {
        staff: await sampleStaffContext(h.prisma, a.id),
        lockVersion: 0,
        confirm: { roundNo: 1 },
      }),
      h.profile.reject(bc, ready.submissionId, {
        staff: await sampleStaffContext(h.prisma, b.id),
        confirm: { roundNo: 1 },
        note: "请补正",
        reasonCodes: ["R01"],
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { error: "APPROVAL_NOT_PENDING" },
    });
    const row = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: ready.submissionId },
    });
    expect(
      await h.prisma.statusTransition.count({
        where: { subjectId: row.approvalRequestId!, fromState: "pending" },
      }),
    ).toBe(1);
  });
  it("同信用代码的不同主体同时通过，后者 USCC_TAKEN 且三条链均保持在审", async () => {
    const first = await h.owner(),
      second = await h.owner(),
      number = uscc();
    const a = await complete(h, first.viewer, number),
      b = await complete(h, second.viewer, number);
    await submit(h, first.viewer, a.submissionId);
    await submit(h, second.viewer, b.submissionId);
    const sys = createIdentityContext({
      actor: { type: "system", job: "lyxtest.profile_concurrent" },
    });
    const results = await Promise.allSettled([
      h.profile.approve(sys, a.submissionId, { lockVersion: 0, confirm: { roundNo: 1 } }),
      h.profile.approve(sys, b.submissionId, { lockVersion: 0, confirm: { roundNo: 1 } }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { error: "USCC_TAKEN" },
    });
    const loser =
      results[0]!.status === "rejected"
        ? { viewer: first.viewer, id: a.submissionId }
        : { viewer: second.viewer, id: b.submissionId };
    const row = await h.prisma.qualificationSubmission.findUniqueOrThrow({
      where: { id: loser.id },
    });
    expect(row.closedAt).toBeNull();
    expect(
      (await h.prisma.approvalRequest.findUniqueOrThrow({ where: { id: row.approvalRequestId! } }))
        .status,
    ).toBe("pending");
    expect(
      (await h.prisma.store.findUniqueOrThrow({ where: { id: loser.viewer.membership.storeId } }))
        .qualificationStatus,
    ).toBe("pending");
    expect(
      (await h.prisma.entity.findUniqueOrThrow({ where: { id: loser.viewer.membership.entityId } }))
        .verificationStatus,
    ).toBe("pending");
    expect(
      await h.prisma.statusTransition.count({ where: { subjectId: row.approvalRequestId! } }),
    ).toBe(1);
  });
  it("并发建立草稿只有一个在途行，新建null版本不能覆盖已存在草稿", async () => {
    const { viewer } = await h.owner();
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        h.profile.updateQualification(viewer, {
          lockVersion: null,
          claimedEntityType: "enterprise",
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({
      reason: { error: "VERSION_CONFLICT" },
    });
    expect(
      await h.prisma.qualificationSubmission.count({
        where: { storeId: viewer.membership.storeId, closedAt: null },
      }),
    ).toBe(1);
  });
});
