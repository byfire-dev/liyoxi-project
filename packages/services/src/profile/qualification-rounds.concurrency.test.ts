import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { harness, submit, uscc } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { qualified, newStoreReady, replacementLicense, reviewer } from "./__fixtures__/rounds.js";

const db = useSeededDatabase("services", { label: "roundconc", max: 1 });
let a: Harness, b: Harness, clients: PrismaClient[];
beforeAll(async () => {
  const url = await db.url();
  clients = [0, 1].map(() => createPrismaClient({ connectionString: url, max: 1 }));
  a = harness(clients[0]!);
  b = harness(clients[1]!);
  const pids = await Promise.all(
    clients.map(async (client) => {
      const [row] = await client.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      return row!.pid;
    }),
  );
  expect(new Set(pids).size).toBe(2);
}, 120000);
afterAll(async () => {
  await Promise.all(clients?.map((c) => c.$disconnect()) ?? []);
});

describe("多轮资质两个真实max1客户端竞争，各三轮", { timeout: 60000 }, () => {
  it("同主体两店同时提交更换执照，仅一轮在审且另一草稿完整", async () => {
    for (let n = 0; n < 3; n++) {
      const first = await qualified(a),
        second = await newStoreReady(a, first.viewer);
      await submit(a, second.viewer, second.roundId);
      await a.profile.approve(reviewer, second.roundId, {
        lockVersion: 0,
        confirm: { roundNo: 1 },
      });
      const ad = await replacementLicense(a, first.viewer),
        bd = await replacementLicense(a, second.viewer);
      const results = await Promise.allSettled([
        submit(a, first.viewer, ad.qualificationSubmissionId),
        submit(b, second.viewer, bd.qualificationSubmissionId),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { error: "ENTITY_LICENSE_CHANGE_PENDING" },
      });
      expect(
        await a.prisma.qualificationSubmission.count({
          where: {
            entityId: first.entity.id,
            kind: "change",
            closedAt: null,
            submittedAt: { not: null },
          },
        }),
      ).toBe(1);
      const loser = results[0]!.status === "rejected" ? ad : bd;
      expect(
        await a.prisma.qualificationSubmission.findUniqueOrThrow({
          where: { id: loser.qualificationSubmissionId },
        }),
      ).toMatchObject({ submittedAt: null, approvalRequestId: null });
      expect(
        await a.prisma.fileRef.findFirstOrThrow({
          where: { refType: "qualification_doc", refId: loser.doc.qualificationDocId },
        }),
      ).toMatchObject({ state: "live" });
    }
  });
  it("不同已认证主体同时批准同一新信用码，仅一通过；失败方仍在审且旧生效执照不变", async () => {
    for (let n = 0; n < 3; n++) {
      const first = await qualified(a),
        second = await qualified(a),
        number = uscc();
      const ad = await replacementLicense(a, first.viewer, number),
        bd = await replacementLicense(a, second.viewer, number);
      await submit(a, first.viewer, ad.qualificationSubmissionId);
      await submit(a, second.viewer, bd.qualificationSubmissionId);
      const results = await Promise.allSettled([
        a.profile.approve(reviewer, ad.qualificationSubmissionId, {
          lockVersion: 0,
          confirm: { roundNo: 2 },
        }),
        b.profile.approve(reviewer, bd.qualificationSubmissionId, {
          lockVersion: 0,
          confirm: { roundNo: 2 },
        }),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({
        reason: { error: "USCC_TAKEN" },
      });
      const loser =
        results[0]!.status === "rejected" ? { ...first, draft: ad } : { ...second, draft: bd };
      const round = await a.prisma.qualificationSubmission.findUniqueOrThrow({
        where: { id: loser.draft.qualificationSubmissionId },
      });
      expect(round).toMatchObject({ closedAt: null, outcome: null });
      expect(
        await a.prisma.approvalRequest.findUniqueOrThrow({
          where: { id: round.approvalRequestId! },
        }),
      ).toMatchObject({ status: "pending" });
      expect(
        await a.prisma.qualificationDoc.findUniqueOrThrow({ where: { id: loser.ready.docId } }),
      ).toMatchObject({ supersededAt: null });
      expect(
        await a.prisma.fileRef.findFirstOrThrow({
          where: { refType: "qualification_doc", refId: loser.ready.docId },
        }),
      ).toMatchObject({ state: "live" });
    }
  });
});
