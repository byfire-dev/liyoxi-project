import { beforeAll, afterAll, it, expect } from "vitest";
import { useSeededDatabase } from "../testing/index.js";
import { createIdentityContext, uuidv7 } from "../kernel/index.js";
import { harness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { lockTickets } from "./repo.js";
import { reevaluate, reevaluateSweep } from "./reevaluate.js";
const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = harness(await db.prisma());
}, 120000);
afterAll(() => h?.unbind());
it("质检写入 × 补偿扫描同一父锁串行，只迁移一次并回调最新步骤", { timeout: 60000 }, async () => {
  const o = await h.order(true),
    id = o.deliveryTicketIds[0]!,
    a = await h.staff(),
    file = await h.make.fileObject({
      category: "final_episode",
      bucket: "secure",
      scopeType: "store",
      entityId: o.entity.id,
      storeId: o.store.id,
    });
  await h.prisma.deliveryTicket.update({ where: { id }, data: { step: "batch_compose" } });
  await h.prisma.deliveryTicketStage.updateMany({
    where: { deliveryTicketId: id, completedAt: null },
    data: { step: "batch_compose" },
  });
  for (let n = 1; n <= o.items[0]!.episodeCount; n++) {
    const outputId = uuidv7(),
      qcId = uuidv7();
    await h.prisma.qcRecord.create({
      data: {
        id: qcId,
        entityId: o.entity.id,
        storeId: o.store.id,
        deliveryTicketId: id,
        targetType: "episode_output",
        targetId: outputId,
        checklistCode: "qc.episode",
        checklistVersionNo: 1,
        results: [],
        verdict: "pass",
        inspectedByStaffId: a.row.id,
        inspectedAt: h.clock.now(),
        createdAt: h.clock.now(),
      },
    });
    await h.prisma.episodeOutput.create({
      data: {
        id: outputId,
        entityId: o.entity.id,
        storeId: o.store.id,
        deliveryTicketId: id,
        episodeNo: n,
        fileId: file.id,
        sizeBytes: 1024,
        status: "qc_passed",
        isCurrent: true,
        qcRecordId: qcId,
        uploadedByStaffId: a.row.id,
        uploadedAt: h.clock.now(),
        createdAt: h.clock.now(),
        updatedAt: h.clock.now(),
      },
    });
  }
  const ctx = createIdentityContext({ actor: { type: "system", job: "lyxtest.qc" } }),
    callbacks = h.rederivations.length;
  const [qc, sweep] = await Promise.all([
    h.tx.run(async (tx) => {
      // PR2 的 QC 写入模拟只造本域事实，生产 handler 在 PR2 交付。
      await lockTickets(tx, [id]);
      await tx.qcRecord.create({
        data: {
          id: uuidv7(),
          entityId: o.entity.id,
          storeId: o.store.id,
          deliveryTicketId: id,
          targetType: "delivery_ticket",
          targetId: id,
          checklistCode: "qc.package",
          checklistVersionNo: 1,
          results: [],
          verdict: "pass",
          inspectedByStaffId: a.row.id,
          inspectedAt: h.clock.now(),
          createdAt: h.clock.now(),
        },
      });
      return reevaluate(tx, h.deps, ctx, id);
    }),
    reevaluateSweep(h.deps),
  ]);
  expect(qc.moved + sweep.moved).toBe(1);
  expect(
    await h.prisma.statusTransition.count({
      where: { subjectId: id, event: "episodes.all_passed" },
    }),
  ).toBe(1);
  expect(
    await h.prisma.outboxEvent.count({
      where: { aggregateId: id, eventType: "ticket.step_changed" },
    }),
  ).toBe(1);
  expect(h.rederivations.slice(callbacks).map((r) => r.steps)).toEqual([["delivering"]]);
});
