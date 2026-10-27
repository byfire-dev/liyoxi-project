import { createSessionMutexConnectionFactory } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { createReconciliation, createReconciliationAssembly } from "../billing/index.js";
import type { ReconciliationDeps } from "../billing/index.js";
import { createSessionMutex } from "../kernel/index.js";
import { createMedia } from "../media/index.js";
import { createBillMissingObserver } from "../ops/index.js";
import { createVerifiedTradeBill } from "../providers/index.js";
import { createRefundHarness } from "./billing-refund.js";

/** 只通过领域公口组合真实资金/媒体/会话锁，生产入口不引本文件。 */
export function createReconciliationHarness(db: PrismaClient, url: string) {
  const h = createRefundHarness(db),
    scope = createReconciliationAssembly(h.assembly);
  const mutex = createSessionMutex({
    connect: createSessionMutexConnectionFactory({ connectionString: url }),
  });
  const media = createMedia({
    tx: h.tx,
    clock: h.clock,
    assembly: scope.assembly,
    events: h.deps.events,
    storage: h.provider.storage,
  });
  const deps: ReconciliationDeps = {
    ...h.deps,
    assembly: scope.assembly,
    sessionMutex: mutex,
    systemFiles: media,
    orderPrefix: "FK",
    observeBillMissing: createBillMissingObserver({ tx: h.tx, clock: h.clock }),
  };
  scope.attach(deps);
  return {
    ...h,
    deps,
    reconciliation: createReconciliation(deps),
    media,
    scope,
    mutex,
    invalidDigest(day: string, bytes: Uint8Array) {
      return createVerifiedTradeBill({
        billDate: day,
        appid: deps.wechatPay!.appid,
        mchid: deps.wechatPay!.mchid,
        sha1: "0".repeat(40),
        bytes,
      });
    },
    async close() {
      scope.close();
      await mutex.close();
      h.close();
    },
  };
}
export type ReconciliationHarness = ReturnType<typeof createReconciliationHarness>;
