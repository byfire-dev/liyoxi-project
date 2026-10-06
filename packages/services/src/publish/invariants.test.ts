import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { Prisma } from "@liyoxi/db";
import { uuidv7 } from "../kernel/index.js";
import { useSeededDatabase } from "../testing/index.js";
import { findPublishViolations, PUBLISH_INVARIANT_CODES } from "./invariants.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
describe("publish 九项真库巡检", { timeout: 60000 }, () => {
  it("正常主链九项为零；每项都发现自己的可存储反例，回滚后恢复", async () => {
    const { viewer } = await h.owner(),
      accountId = await h.account(viewer),
      fixture = await h.tasks(viewer, [accountId]);
    const otherStore = await h.make.store({
      entityId: viewer.membership.entityId,
      qualificationStatus: "verified",
    });
    const otherItem = await h.make.orderItem({
        dramaOrderId: fixture.order.id,
        phase: "to_launch",
      }),
      otherTicket = await h.make.deliveryTicket({
        orderItemId: otherItem.id,
        step: "awaiting_launch",
        deliveredAt: h.clock.now(),
      });
    const submission = await h.prisma.channelAccountSubmission.findFirstOrThrow({
      where: { channelAccountId: accountId },
    });
    for (const code of PUBLISH_INVARIANT_CODES)
      expect(await h.tx.run((tx) => findPublishViolations(tx, code)), code).toEqual([]);
    expect(h.assembly.invariants.filter((i) => i.code.startsWith("publish."))).toHaveLength(9);
    for (const code of PUBLISH_INVARIANT_CODES) {
      const rollback = new Error(`lyxtest_${code}_rollback`);
      await expect(
        h.tx.run(async (tx) => {
          if (code === "I1")
            await tx.channelAccount.update({
              where: { id: accountId },
              data: { storeId: otherStore.id },
            });
          if (code === "I2")
            await tx.channelAccount.update({
              where: { id: accountId },
              data: { status: "pending_verify" },
            });
          if (code === "I3") {
            const source = await tx.approvalRequest.findUniqueOrThrow({
              where: { id: submission.approvalRequestId },
            });
            const copy = source;
            const id = uuidv7();
            await tx.approvalRequest.create({
              data: {
                ...copy,
                id,
                subjectId: uuidv7(),
                dedupeKey: `lyxtest:${id}`,
                slaSnapshot:
                  copy.slaSnapshot === null
                    ? Prisma.DbNull
                    : (copy.slaSnapshot as Prisma.InputJsonValue),
                summarySnapshot: copy.summarySnapshot as Prisma.InputJsonValue,
                checklistResult: copy.checklistResult as Prisma.InputJsonValue,
              },
            });
            await tx.channelAccountSubmission.update({
              where: { id: submission.id },
              data: { approvalRequestId: id },
            });
          }
          if (code === "I4")
            await tx.channelAccountSubmission.update({
              where: { id: submission.id },
              data: { compareResult: Prisma.DbNull },
            });
          if (code === "I5")
            await tx.channelAccountSubmission.update({
              where: { id: submission.id },
              data: { storeId: otherStore.id },
            });
          if (code === "I6")
            await tx.deliveryTicket.update({
              where: { id: fixture.ticket.id },
              data: { step: "in_service" },
            });
          if (code === "I7")
            await tx.orderItemAccount.delete({
              where: {
                orderItemId_channelAccountId: {
                  orderItemId: fixture.item.id,
                  channelAccountId: accountId,
                },
              },
            });
          if (code === "I8")
            await tx.launchTask.update({
              where: { id: fixture.ids[0]! },
              data: { currentRoundNo: 1, reviewStatus: "verifying" },
            });
          if (code === "I9")
            await tx.launchTask.update({
              where: { id: fixture.ids[0]! },
              data: { deliveryTicketId: otherTicket.id },
            });
          expect(await findPublishViolations(tx, code), code).not.toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
      expect(await h.tx.run((tx) => findPublishViolations(tx, code)), code).toEqual([]);
    }
  });
});
