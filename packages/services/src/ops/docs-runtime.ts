import { countActiveMerchantUsers } from "../identity/index.js";
import {
  createDocs,
  createDocsAdmin,
  findN4Violations,
  findN13Violations,
  scheduledDocsSweep,
  scheduledConsentDigest,
} from "../docs/index.js";
import type { DocsJobDeps } from "../docs/index.js";
import { createNotices, paramsAt } from "../config/index.js";
import type { Config } from "../config/index.js";
import { staffBriefs } from "../staff/index.js";
import { alertsOf, invariantNow } from "../kernel/index.js";
import type { Assembly, Clock, DocumentConverter, TxRunner } from "../kernel/index.js";
import type { Events } from "../events/index.js";
import type { Media } from "../media/index.js";
import type { StorageProvider } from "../providers/types.js";
import { createDocsFiles } from "./docs-files.js";
/** 只替换两个本域job，保留notify当前scope的N5及所有其它登记。 */
export function createDocsAssembly(base: Assembly) {
  let deps: DocsJobDeps | undefined;
  let closed = false;
  const lifetime = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const current = () => {
    if (closed || !deps) throw new TypeError("文书运行时尚未绑定或已经关闭");
    return deps;
  };
  const run = (kind: string, ctx: Parameters<typeof scheduledDocsSweep>[1]) => {
    const deps = current();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, lifetime.signal]) : lifetime.signal;
    const active =
      kind === "docs.sweep"
        ? scheduledDocsSweep(deps, { ...ctx, signal })
        : scheduledConsentDigest(deps, { ...ctx, signal });
    pending.add(active);
    void active.finally(() => pending.delete(active)).catch(() => undefined);
    return active;
  };
  const recurringJobs = base.recurringJobs.map((item) =>
    ["docs.sweep", "evidence.consent_digest"].includes(item.kind)
      ? { ...item, run: (ctx: Parameters<typeof item.run>[0]) => run(item.kind, ctx) }
      : item,
  );
  const invariants = base.invariants.map((item) =>
    item.code === "docs.N4" || item.code === "docs.N13"
      ? {
          ...item,
          run: (
            tx: Parameters<typeof findN4Violations>[0],
            _scope: Parameters<NonNullable<typeof item.run>>[1],
            ctx: Parameters<NonNullable<typeof item.run>>[2],
          ) => {
            current();
            return (item.code === "docs.N4" ? findN4Violations : findN13Violations)(tx, {
              now: invariantNow(ctx),
            });
          },
        }
      : item,
  );
  const invariantIndex = new Map(invariants.map((item) => [item.code, item]));
  const index = new Map(recurringJobs.map((item) => [item.kind, item]));
  const assembly: Assembly = {
    ...base,
    recurringJobs,
    invariants,
    recurringJob: (kind) => index.get(kind),
    invariant: (code) => invariantIndex.get(code),
  };
  return {
    assembly,
    attach(value: DocsJobDeps) {
      if (closed || deps) throw new TypeError("文书运行时只能绑定一次");
      deps = value;
    },
    async close() {
      closed = true;
      lifetime.abort();
      await Promise.allSettled([...pending]);
      deps = undefined;
    },
  };
}
export function createRuntimeDocs(deps: {
  tx: TxRunner;
  clock: Clock;
  assembly: Assembly;
  media: Media;
  storage: StorageProvider;
  converter: DocumentConverter | null;
  events: Events;
  config: Config;
  bumpAgreement: () => Promise<void>;
}) {
  const files = createDocsFiles(deps);
  const jobs: DocsJobDeps = {
    tx: deps.tx,
    clock: deps.clock,
    storage: deps.storage,
    alerts: alertsOf(deps.assembly),
    countActiveUsers: countActiveMerchantUsers,
  };
  return {
    docs: createDocs({ tx: deps.tx, clock: deps.clock, signPdf: files.signPdf }),
    admin: createDocsAdmin({
      tx: deps.tx,
      clock: deps.clock,
      files,
      notices: createNotices(deps),
      staffBriefs,
      announceMinDays: async (tx, now) =>
        (await paramsAt(tx, ["agreement.announce_min_days"], now))["agreement.announce_min_days"],
      bumpSite: () => deps.config.cache.bump("site"),
      bumpAgreement: deps.bumpAgreement,
    }),
    jobs,
  };
}
