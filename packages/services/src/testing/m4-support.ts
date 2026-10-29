// M4 只借用M1的隔离/runtime/close，不执行媒体交付主链。
import { createNotices, insertDictItemsMissing } from "../config/index.js";
import { DEMO_SEED_STEPS, runDemoSeed } from "../demo-seed.js";
import { DEMO_DICT_ITEMS } from "../content/index.js";
import { loadKeyring } from "../security/index.js";
import { prepareClosedBillingDays } from "./billing-daily.js";
import { createM1Support } from "./m1-support.js";
import { createM2Background } from "./m2-background.js";
import { seedM1ProfileDefaults } from "./m1-profile-defaults.js";
import type { M1SupportOptions } from "./m1-types.js";

export async function createM4Support(options: Pick<M1SupportOptions, "runId" | "clock"> = {}) {
  const base = await createM1Support({
    ...options,
    wechatPay: { appid: "wxlyxm1demo000001", mchid: "1900000109" },
    prepareProviders(providers) {
      providers.wechatPay.useWireFormat({ appid: "wxlyxm1demo000001", mchid: "1900000109" });
    },
  });
  let closed = false;
  const owned = () => {
    if (closed || base.runtime.env.APP_ENV !== "test") throw new Error("M4隔离支架已关闭");
  };
  const drainBackground = createM2Background(base, base.clock.now(), owned);
  return {
    ...base,
    drainBackground,
    async seedDemo() {
      owned();
      const runtime = base.runtime;
      const report = await runDemoSeed({
        ...runtime,
        keyring: loadKeyring(runtime.env),
        appEnv: "test",
        steps: DEMO_SEED_STEPS.filter((step) =>
          ["staff", "media", "docs", "billing", "parameters"].includes(step.name),
        ),
        billing: { assembly: runtime.assembly, bizNo: runtime.bizNo },
        notices: createNotices({ clock: base.clock, events: runtime.events }),
        params: runtime.config.params,
      });
      const profile = await seedM1ProfileDefaults(runtime);
      const reasons = await runtime.tx.run((tx) =>
        insertDictItemsMissing(
          tx,
          [
            // 原M1从content种子取得；M4只复用合法行业元数据，不造剧或媒体任务。
            ...DEMO_DICT_ITEMS.filter(
              (item) => item.dictTypeKey === "industry" && ["C07", "C08"].includes(item.code),
            ),
            {
              dictTypeKey: "refund_reason",
              code: "RF419",
              name: "M4隔离退款",
              parentCode: null,
              description: null,
              position: 0,
              ext: {},
            },
            {
              dictTypeKey: "extend_reason",
              code: "EX419",
              name: "M4隔离补偿",
              parentCode: null,
              description: null,
              position: 0,
              ext: {},
            },
          ],
          base.clock.now(),
        ),
      );
      if (reasons.inserted) await runtime.config.cache.bump("dict");
      return { ...report, inserted: report.inserted + profile.inserted + reasons.inserted };
    },
    async financeFacts(entityId: string) {
      owned();
      return base.runtime.tx.run(async (tx) => {
        const orders = await tx.billingOrder.findMany({
          where: { entityId },
          select: {
            id: true,
            status: true,
            fulfillmentStatus: true,
            paidAmountFen: true,
            refundedAmountFen: true,
          },
        });
        const orderIds = orders.map((row) => row.id);
        return {
          orders,
          payments: await tx.paymentTxn.findMany({
            where: { billingOrderId: { in: orderIds } },
            select: {
              id: true,
              billingOrderId: true,
              outTradeNo: true,
              channelTxnNo: true,
              status: true,
              appliedAt: true,
              channelAmountFen: true,
            },
          }),
          ledgerEntries: await tx.pointLedgerEntry.count({ where: { entityId } }),
          operations: await tx.ledgerOperation.count({ where: { entityId } }),
          history: await tx.statusTransition.findMany({
            where: { entityId },
            select: { machine: true, subjectId: true, event: true, fromState: true, toState: true },
          }),
          audits: await tx.auditLog.count({ where: { entityId } }),
          events: await tx.outboxEvent.findMany({
            where: { entityId },
            select: { eventType: true, aggregateId: true },
          }),
        };
      });
    },
    async fullInvariants() {
      owned();
      await prepareClosedBillingDays(base.runtime);
      await drainBackground();
      return base.fullInvariants();
    },
    async close() {
      closed = true;
      await base.close();
    },
  };
}
export type M4Support = Awaited<ReturnType<typeof createM4Support>>;
