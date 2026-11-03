// Same owned database, original HTTP intents, exact business counts and the complete dictionary.
import assert from "node:assert/strict";
import type { M5Support, M5Scope } from "./m5-support.js";

export interface M5DemoReplayContext {
  readonly scope: M5Scope;
  readonly replaySameIntent: () => Promise<void>;
}
async function snapshot(support: M5Support, scope: M5Scope) {
  assert.equal(process.env.APP_ENV, "test", "M5演示重放只接受test");
  const facts = await support.readM5Facts(scope); // also enforces resource and business ownership
  assert.ok(
    facts.orders.length && facts.ads.length && facts.letters.length,
    "M5不能以空业务范围证明零新增",
  );
  assert.ok(
    facts.cancelRequests.some((row) => row.status === "done"),
    "M5演示必须已经真实执行取消",
  );
  return support.runtime.tx.run(async (tx) => {
    const actual = await tx.$queryRaw<{ name: string }[]>`SELECT current_database()::text AS name`;
    assert.equal(actual[0]?.name, support.databaseName);
    const counts = {
      merchants: await tx.merchantUser.count(),
      staff: await tx.staff.count(),
      entities: await tx.entity.count(),
      members: await tx.entityMember.count(),
      stores: await tx.store.count(),
      storeMembers: await tx.storeMember.count(),
      billingAccounts: await tx.billingAccount.count(),
      billingOrders: await tx.billingOrder.count(),
      payments: await tx.paymentTxn.count(),
      transferProofs: await tx.transferProof.count(),
      terms: await tx.subscriptionTerm.count(),
      subscriptionEvents: await tx.subscriptionEvent.count(),
      schedules: await tx.grantSchedule.count(),
      lots: await tx.pointLot.count(),
      holds: await tx.pointHold.count(),
      holdAllocations: await tx.pointHoldAlloc.count(),
      ledgerOperations: await tx.ledgerOperation.count(),
      ledgerEntries: await tx.pointLedgerEntry.count(),
      orders: await tx.dramaOrder.count(),
      orderItems: await tx.orderItem.count(),
      placements: await tx.orderItemPlacement.count(),
      ads: await tx.ad.count(),
      adVersions: await tx.adVersion.count(),
      adRevisions: await tx.adRevision.count(),
      plans: await tx.deliveryPlan.count(),
      planVersions: await tx.deliveryPlanVersion.count(),
      tickets: await tx.deliveryTicket.count(),
      ticketPauses: await tx.deliveryTicketPause.count(),
      ticketStages: await tx.deliveryTicketStage.count(),
      samples: await tx.sample.count(),
      outputs: await tx.episodeOutput.count(),
      quality: await tx.qcRecord.count(),
      releases: await tx.deliveryRelease.count(),
      reissues: await tx.deliveryReissue.count(),
      grants: await tx.downloadGrant.count(),
      downloads: await tx.deliveryDownloadLog.count(),
      cancellations: await tx.cancelRequest.count(),
      cancellationLines: await tx.cancelRequestLine.count(),
      approvals: await tx.approvalRequest.count(),
      agreements: await tx.agreementConsent.count(),
      letters: await tx.licenseLetter.count(),
      revisions: await tx.licenseLetterRevision.count(),
      files: await tx.fileObject.count(),
      fileRefs: await tx.fileRef.count(),
      zipBundles: await tx.zipBundle.count(),
      mediaJobs: await tx.mediaJob.count(),
      production: await tx.productionRecord.count(),
      history: await tx.statusTransition.count(),
      audits: await tx.auditLog.count(),
      events: await tx.outboxEvent.count(),
    };
    return {
      counts,
      facts,
      types: await tx.dictType.findMany({ orderBy: { typeKey: "asc" } }),
      items: await tx.dictItem.findMany({ orderBy: [{ dictTypeKey: "asc" }, { code: "asc" }] }),
    };
  });
}
export async function verifyM5DemoReplay(support: M5Support, context: M5DemoReplayContext) {
  await support.drainZipPackages();
  await support.drainEvents();
  const before = await snapshot(support, context.scope);
  assert.ok(before.types.length && before.items.length);
  const seeded = await support.seedDemo();
  assert.equal(seeded.inserted, 0, "M5同库第二遍种子不得新增");
  await context.replaySameIntent();
  await support.drainZipPackages();
  await support.drainEvents();
  const after = await snapshot(support, context.scope);
  assert.deepEqual(after.counts, before.counts, "M5原意图重放不得新增任何业务行");
  assert.deepEqual(after.facts, before.facts, "M5原意图重放不得二次扣退或改变已有业务结果");
  assert.deepEqual(after.types, before.types, "M5完整字典类型必须保留");
  assert.deepEqual(after.items, before.items, "M5完整字典条目必须保留");
  return { inserted: 0 as const, dictionaryPreserved: true as const };
}
export type M5DemoReplayResult = Awaited<ReturnType<typeof verifyM5DemoReplay>>;
