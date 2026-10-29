import { expect, it } from "vitest";
import { ownTaskScope } from "../../authz/index.js";
import {
  createRefundHarnessForTest,
  snapshotTables,
  useSeededDatabase,
} from "../../testing/index.js";
import { orderRefundProjection } from "./order-projection.js";
const db = useSeededDatabase("services", { max: 1, label: "refundview" });
it("真实付款与退款申请只读投影七字段，同scope/同单防串单且零业务写", async () => {
  await db.reset();
  const h = createRefundHarnessForTest(await db.prisma());
  try {
    const r = await h.request(),
      other = await h.paid();
    const tables = [
        "refund_request",
        "refund_txn",
        "billing_order",
        "payment_txn",
        "approval_request",
        "audit_log",
        "outbox_event",
      ],
      before = await snapshotTables(h.prisma, tables);
    const rows = await h.tx.run((tx) =>
      orderRefundProjection(tx, r.creator.staff.scope, r.order.id),
    );
    expect(rows).toEqual([
      {
        refundRequestId: r.created.refundRequestId,
        requestNo: r.created.requestNo,
        ruleCode: r.created.ruleCode,
        amountFen: r.created.amountFen,
        status: "pending_approval",
        closeReason: null,
        createdAt: r.created.createdAt,
      },
    ]);
    expect(Object.keys(rows[0]!).sort()).toEqual(
      [
        "refundRequestId",
        "requestNo",
        "ruleCode",
        "amountFen",
        "status",
        "closeReason",
        "createdAt",
      ].sort(),
    );
    expect(
      await h.tx.run((tx) => orderRefundProjection(tx, r.creator.staff.scope, other.order.id)),
    ).toEqual([]);
    expect(
      await h.tx.run((tx) =>
        orderRefundProjection(tx, ownTaskScope({ id: r.executor.row.id }), r.order.id),
      ),
    ).toEqual([]);
    expect(await snapshotTables(h.prisma, tables)).toEqual(before);
    await h.prisma.store.update({
      where: { id: r.store.id },
      data: { deliveryManagerId: r.executor.row.id },
    });
    expect(
      await h.tx.run((tx) =>
        orderRefundProjection(tx, ownTaskScope({ id: r.executor.row.id }), r.order.id),
      ),
    ).toEqual(rows);
  } finally {
    await h.close();
  }
});
