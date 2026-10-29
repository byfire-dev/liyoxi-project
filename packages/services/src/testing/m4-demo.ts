// 同一M4隔离库内重放原资金意图；只读核验留在testing公口，不向应用层暴露数据库。
import assert from "node:assert/strict";
import type { M4Support } from "./m4-support.js";

export interface M4DemoReplayContext {
  readonly entityId: string;
  readonly replaySameIntent: () => Promise<void>;
}

async function snapshot(support: M4Support, entityId: string) {
  assert.equal(process.env.APP_ENV, "test", "M4演示重放只接受test环境");
  assert.equal(support.runtime.env.APP_ENV, "test", "M4演示运行环境已改变");
  assert.match(support.runId, /^[a-z0-9]{1,12}$/);
  assert.equal(support.databaseName, `lyx_test_api_${support.runId}_0_m1`);
  assert.equal(support.redisPrefix, `lyx:test:${support.runId}:0:`);
  const target = new URL(support.runtime.env.DATABASE_URL);
  assert.ok(["localhost", "127.0.0.1"].includes(target.hostname));
  assert.equal(target.pathname, `/${support.databaseName}`);
  // 沿原支架核关闭状态及实际业务归属，拒绝用空范围取得“零新增”。
  const facts = await support.financeFacts(entityId);
  assert.ok(facts.orders.some((row) => row.refundedAmountFen > 0));
  return support.runtime.tx.run(async (tx) => {
    const databases = await tx.$queryRaw<
      { name: string }[]
    >`SELECT current_database()::text AS name`;
    assert.equal(databases[0]?.name, support.databaseName, "M4演示数据库归属不一致");
    assert.equal(await tx.entity.count({ where: { id: entityId } }), 1);
    // 本轮独占新库的明确业务表逐项计数，包含平台配置；不比较会话、投递或不变量运行等技术行。
    const counts = {
      merchants: await tx.merchantUser.count(),
      staff: await tx.staff.count(),
      entities: await tx.entity.count(),
      members: await tx.entityMember.count(),
      stores: await tx.store.count(),
      storeMembers: await tx.storeMember.count(),
      accounts: await tx.billingAccount.count(),
      orders: await tx.billingOrder.count(),
      payments: await tx.paymentTxn.count(),
      transferProofs: await tx.transferProof.count(),
      refundRequests: await tx.refundRequest.count(),
      refundTransactions: await tx.refundTxn.count(),
      terms: await tx.subscriptionTerm.count(),
      subscriptionEvents: await tx.subscriptionEvent.count(),
      schedules: await tx.grantSchedule.count(),
      lots: await tx.pointLot.count(),
      adjustments: await tx.pointAdjustmentRequest.count(),
      extensions: await tx.termExtensionRequest.count(),
      approvals: await tx.approvalRequest.count(),
      configRevisions: await tx.financeConfigRevision.count(),
      operations: await tx.ledgerOperation.count(),
      ledgerEntries: await tx.pointLedgerEntry.count(),
      invoices: await tx.invoiceRequest.count(),
      exceptions: await tx.paymentException.count(),
      history: await tx.statusTransition.count(),
      audits: await tx.auditLog.count(),
      events: await tx.outboxEvent.count(),
      agreements: await tx.agreementConsent.count(),
      files: await tx.fileObject.count(),
      fileRefs: await tx.fileRef.count(),
      qualificationSubmissions: await tx.qualificationSubmission.count(),
      qualificationDocs: await tx.qualificationDoc.count(),
    };
    return {
      counts,
      // 完整字典行含停用项、扩展与版本，既不截断，也不只核几个演示code。
      types: await tx.dictType.findMany({ orderBy: { typeKey: "asc" } }),
      items: await tx.dictItem.findMany({ orderBy: [{ dictTypeKey: "asc" }, { code: "asc" }] }),
    };
  });
}

export async function verifyM4DemoReplay(support: M4Support, context: M4DemoReplayContext) {
  const before = await snapshot(support, context.entityId);
  assert.ok(before.types.length > 0 && before.items.length > 0, "M4演示必须已有真实字典");
  const seeded = await support.seedDemo();
  assert.equal(seeded.inserted, 0, "M4演示第二遍种子不得新增");
  await context.replaySameIntent();
  await support.drainEvents();
  const after = await snapshot(support, context.entityId);
  assert.deepEqual(after.counts, before.counts, "M4演示第二遍业务表数量必须逐项相等");
  assert.deepEqual(after.types, before.types, "M4演示必须保留完整字典类型");
  assert.deepEqual(after.items, before.items, "M4演示必须保留完整字典条目");
  return { inserted: 0 as const, dictionaryPreserved: true as const };
}

export type M4DemoReplayResult = Awaited<ReturnType<typeof verifyM4DemoReplay>>;
