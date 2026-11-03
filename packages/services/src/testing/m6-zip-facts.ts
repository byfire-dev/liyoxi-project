// Read-only receipt for the owned full chain; production writers establish every fact.
import assert from "node:assert/strict";
import type { M1Scope, M1Support } from "./m1-types.js";

export async function readM6ZipFacts(support: M1Support, scope: M1Scope) {
  const owner = support.sharedScope();
  assert.equal(support.runtime.env.APP_ENV, "test");
  assert.ok(owner.databaseName.startsWith("lyx_test_"));
  assert.equal(new URL(support.runtime.env.DATABASE_URL).pathname, `/${owner.databaseName}`);
  return support.runtime.tx.run(async (tx) => {
    await tx.orderItem.findFirstOrThrow({
      where: {
        id: scope.orderItemId,
        dramaOrderId: scope.orderId,
        entityId: scope.entityId,
        storeId: scope.storeId,
        dramaOrder: { placedByUserId: scope.merchantUserId },
      },
    });
    const release = await tx.deliveryRelease.findFirstOrThrow({
      where: {
        orderItemId: scope.orderItemId,
        deliveryTicketId: scope.deliveryTicketId,
        entityId: scope.entityId,
        storeId: scope.storeId,
      },
      orderBy: { releaseNo: "desc" },
    });
    const bundle = await tx.zipBundle.findUniqueOrThrow({
      where: {
        ownerType_ownerId: { ownerType: "delivery_release", ownerId: release.id },
      },
    });
    const refs = await tx.fileRef.findMany({
      where: {
        OR: [
          { refType: "zip_bundle", refId: bundle.id },
          { refType: "delivery_release", refId: release.id, role: "ep" },
        ],
      },
      orderBy: { id: "asc" },
    });
    const jobs = await tx.mediaJob.findMany({
      where: { kind: "zip_package", parentId: bundle.id },
      select: { state: true, attemptNo: true },
      orderBy: { id: "asc" },
    });
    const files = await tx.fileObject.findMany({
      where: { id: { in: refs.map((ref) => ref.fileId) } },
      select: { id: true, status: true, category: true, purgeAfter: true },
      orderBy: { id: "asc" },
    });
    return { release, bundle, refs, jobs, files };
  });
}
