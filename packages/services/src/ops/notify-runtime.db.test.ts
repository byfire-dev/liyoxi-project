import { afterAll, beforeAll, expect, it } from "vitest";
import { useSeededDatabase, notificationFixture } from "../testing/index.js";
import { uuidv7 } from "../kernel/index.js";
import { createNotifyAssembly } from "./notify-runtime.js";
const db = useSeededDatabase("services");
let a: ReturnType<typeof notificationFixture>, b: ReturnType<typeof notificationFixture>;
beforeAll(async () => {
  const prisma = await db.prisma();
  a = notificationFixture(prisma);
  b = notificationFixture(prisma);
}, 120_000);
afterAll(async () => {
  await Promise.all([a?.service.close(), b?.service.close()]);
});
it("两真实同时scope各用其clock/服务，所有索引指向自己的对象，关一不串另一", async () => {
  const aa = createNotifyAssembly(a.deps.assembly),
    bb = createNotifyAssembly(b.deps.assembly);
  aa.attach(a.service);
  bb.attach(b.service);
  expect(aa.assembly.subscriber("notify.onEvent")).toBe(
    aa.assembly.subscribers.find((v) => v.name === "notify.onEvent"),
  );
  expect(aa.assembly.recurringJob("notify.remind_scan")).toBe(
    aa.assembly.recurringJobs.find((v) => v.kind === "notify.remind_scan"),
  );
  expect(aa.assembly.invariant("notify.N15")).toBe(
    aa.assembly.invariants.find((v) => v.code === "notify.N15"),
  );
  expect(aa.assembly.invariant("docs.N5")).toBe(
    aa.assembly.invariants.find((v) => v.code === "docs.N5"),
  );
  const one = await a.merchant(),
    two = await b.merchant();
  await expect(
    a.tx.run((tx) =>
      a.deps.assembly.subscriber("notify.onEvent")!.handle(tx, {
        id: uuidv7(),
        type: "order.submitted",
        payload: { v: 1, dramaOrderId: one.order.id },
      }),
    ),
  ).rejects.toThrow("需要本运行时");
  b.clock.advance(86_400_000);
  await a.tx.run((t) =>
    aa.assembly.subscriber("notify.onEvent")!.handle(t, {
      id: uuidv7(),
      type: "order.submitted",
      payload: { v: 1, dramaOrderId: one.order.id },
    }),
  );
  await b.tx.run((t) =>
    bb.assembly.subscriber("notify.onEvent")!.handle(t, {
      id: uuidv7(),
      type: "order.submitted",
      payload: { v: 1, dramaOrderId: two.order.id },
    }),
  );
  expect(await a.prisma.notification.findFirst({ where: { bizId: one.order.id } })).toMatchObject({
    createdAt: a.clock.now(),
  });
  expect(await b.prisma.notification.findFirst({ where: { bizId: two.order.id } })).toMatchObject({
    createdAt: b.clock.now(),
  });
  // Exercise the registered deletion callback in the same scoped transaction.
  await a.prisma.merchantUser.update({
    where: { id: one.user.id },
    data: {
      status: "deleted",
      phoneEnc: null,
      phoneBidx: null,
      phoneMask: null,
      phoneLast4: null,
      displayName: null,
      deletedAt: a.clock.now(),
    },
  });
  await a.tx.run((tx) =>
    aa.assembly.subscriber("notify.onMerchantUserDeleted")!.handle(tx, {
      id: uuidv7(),
      type: "merchant_user.deleted",
      payload: { v: 1, merchantUserId: one.user.id },
    }),
  );
  expect(await a.prisma.merchantMessage.count({ where: { merchantUserId: one.user.id } })).toBe(0);
  expect(await b.prisma.merchantMessage.count({ where: { merchantUserId: two.user.id } })).toBe(1);
  await aa.close();
  await expect(
    a.tx.run((t) =>
      aa.assembly.subscriber("notify.onEvent")!.handle(t, {
        id: uuidv7(),
        type: "order.submitted",
        payload: { v: 1, dramaOrderId: one.order.id },
      }),
    ),
  ).rejects.toThrow("已经关闭");
  const next = await b.merchant();
  await b.tx.run((t) =>
    bb.assembly.subscriber("notify.onEvent")!.handle(t, {
      id: uuidv7(),
      type: "order.submitted",
      payload: { v: 1, dramaOrderId: next.order.id },
    }),
  );
  expect(await b.prisma.notification.count({ where: { bizId: next.order.id } })).toBe(1);
  await bb.close();
});
