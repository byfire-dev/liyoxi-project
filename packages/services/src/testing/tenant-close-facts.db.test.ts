import { beforeAll, expect, it } from "vitest";
import { assembleServices } from "../assembly.js";
import { countBlockingStoreAds } from "../ad/index.js";
import { deletionGuard } from "../billing/index.js";
import { countBlockingStoreTickets, countOnlineReleaseTicketsByEntity } from "../delivery/index.js";
import { AssemblyError, createTxRunner, defineRegistration, implement } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { countBlockingStoreOrders, countOpenOrdersByEntity } from "../order/index.js";
import {
  countQualificationSubmissionsInReview,
  countUnverifiedPrimaryStore,
} from "../profile/index.js";
import { countPendingChannelAccountsByStore } from "../publish/index.js";
import {
  assembleForTest,
  createClock,
  createFactories,
  useSeededDatabase,
} from "../testing/index.js";
import {
  adCloseFactsPort,
  billingCloseFactsPort,
  CLOSE_FACTS_PORTS,
  deliveryCloseFactsPort,
  orderCloseFactsPort,
  profileCloseFactsPort,
  publishCloseFactsPort,
  readEntityDeletionCounts,
  readStoreCloseCounts,
} from "../tenant/index.js";

const db = useSeededDatabase("services", { max: 1 });
let tx: ReturnType<typeof createTxRunner>;
let merchant: Awaited<ReturnType<ReturnType<typeof createFactories>["merchant"]>>;
beforeAll(async () => {
  const prisma = await db.prisma();
  tx = createTxRunner({ prisma, appEnv: "test" });
  merchant = await createFactories({ db: prisma, clock: createClock() }).merchant();
}, 120000);

const owners = ["billing", "order", "delivery", "publish", "profile", "ad"] as const;
it.each(["api", "worker"] as const)(
  "%s 真实组合根收集六个必需所属实现，函数就是已验公开出口",
  (entry) => {
    const assembly = assembleServices({ entry, appEnv: "test" });
    for (const [index, port] of CLOSE_FACTS_PORTS.entries()) {
      expect(port.fallback).toBeUndefined();
      expect(assembly.ports.filter((item) => item.port === port)).toEqual([
        { port, module: "tenant" },
      ]);
      const implementations = assembly.portImplementations.filter((item) => item.port === port);
      expect(implementations).toHaveLength(1);
      expect(implementations[0]?.module).toBe(owners[index]);
    }
    expect(assembly.port(billingCloseFactsPort).deletionGuard).toBe(deletionGuard);
    expect(assembly.port(orderCloseFactsPort).countOpenOrdersByEntity).toBe(
      countOpenOrdersByEntity,
    );
    expect(assembly.port(orderCloseFactsPort).countBlockingStoreOrders).toBe(
      countBlockingStoreOrders,
    );
    expect(assembly.port(deliveryCloseFactsPort).countOnlineReleaseTicketsByEntity).toBe(
      countOnlineReleaseTicketsByEntity,
    );
    expect(assembly.port(deliveryCloseFactsPort).countBlockingStoreTickets).toBe(
      countBlockingStoreTickets,
    );
    expect(assembly.port(publishCloseFactsPort).countPendingChannelAccountsByStore).toBe(
      countPendingChannelAccountsByStore,
    );
    expect(assembly.port(profileCloseFactsPort).countQualificationSubmissionsInReview).toBe(
      countQualificationSubmissionsInReview,
    );
    expect(assembly.port(profileCloseFactsPort).countUnverifiedPrimaryStore).toBe(
      countUnverifiedPrimaryStore,
    );
    expect(assembly.port(adCloseFactsPort).countBlockingStoreAds).toBe(countBlockingStoreAds);
  },
);

for (const entry of ["api", "worker"] as const)
  it.each(CLOSE_FACTS_PORTS.map((port) => ({ port, name: port.name })))(
    `${entry} 缺 $name 实现明确拒绝启动，不当作无业务`,
    ({ port }) => {
      let caught: unknown;
      try {
        assembleForTest({ entry, withoutRealPorts: [port] });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AssemblyError);
      if (!(caught instanceof AssemblyError)) throw new Error("缺实现本该拒绝装配");
      expect(caught.issues).toEqual([
        expect.objectContaining({
          category: "port",
          name: port.name,
          modules: ["tenant"],
          reason: "缺实现：端口没有默认实现，也没有模块实现它",
        }),
      ]);
    },
  );

function fixture(failure?: Error) {
  const calls: { tx: Tx; id: string }[] = [];
  const count = (result: number) => async (t: Tx, id: string) => {
    calls.push({ tx: t, id });
    if (failure && result === 3) throw failure;
    return result;
  };
  const assembly = assembleForTest({
    entry: "api",
    extra: [
      defineRegistration("lyxtest_close_facts", {
        portImplementations: [
          implement(billingCloseFactsPort, {
            deletionGuard: async (t, id) => {
              calls.push({ tx: t, id });
              return { subscription_active: 7, payment_open: 8, refund_open: 9, invoice_open: 10 };
            },
          }),
          implement(orderCloseFactsPort, {
            countBlockingStoreOrders: count(1),
            countOpenOrdersByEntity: count(11),
          }),
          implement(deliveryCloseFactsPort, {
            countBlockingStoreTickets: count(2),
            countOnlineReleaseTicketsByEntity: count(12),
          }),
          implement(adCloseFactsPort, { countBlockingStoreAds: count(3) }),
          implement(profileCloseFactsPort, {
            countQualificationSubmissionsInReview: count(4),
            countUnverifiedPrimaryStore: count(6),
          }),
          implement(publishCloseFactsPort, { countPendingChannelAccountsByStore: count(5) }),
        ],
      }),
    ],
  });
  return { assembly, calls };
}

it("两组六类事实映射各所属值，所有来源收到同一真实调用方事务与准确范围", async () => {
  const f = fixture();
  await tx.run(async (t) => {
    expect(await readStoreCloseCounts(t, f.assembly, merchant.store.id)).toEqual({
      open_order: 1,
      open_delivery_ticket: 2,
      ad_in_production: 3,
      qualification_in_review: 4,
      channel_account_in_review: 5,
      unverified_primary_store: 6,
    });
    expect(await readEntityDeletionCounts(t, f.assembly, merchant.entity.id)).toEqual({
      subscription_active: 7,
      payment_open: 8,
      refund_open: 9,
      invoice_open: 10,
      open_order: 11,
      release_online: 12,
    });
    expect(f.calls).toHaveLength(9);
    expect(f.calls.every((call) => call.tx === t)).toBe(true);
    expect(f.calls.slice(0, 6).every((call) => call.id === merchant.store.id)).toBe(true);
    expect(f.calls.slice(6).every((call) => call.id === merchant.entity.id)).toBe(true);
  });
});

it("所属事实失败原样传播，调用方先前写入回滚而非吞错为零", async () => {
  const failure = new Error("广告所属事实不可读");
  const f = fixture(failure);
  const prisma = await db.prisma();
  const before = await prisma.store.findUniqueOrThrow({ where: { id: merchant.store.id } });
  await expect(
    tx.run(async (t) => {
      await t.store.update({
        where: { id: merchant.store.id },
        data: { name: "调用方未提交名称" },
      });
      await readStoreCloseCounts(t, f.assembly, merchant.store.id);
    }),
  ).rejects.toBe(failure);
  expect(await prisma.store.findUniqueOrThrow({ where: { id: merchant.store.id } })).toEqual(
    before,
  );
});
