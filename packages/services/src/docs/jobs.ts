import { createIdentityContext } from "../kernel/index.js";
import type { Alerts, Clock, RecurringRunContext, Tx, TxRunner } from "../kernel/index.js";
import type { StorageProvider } from "../providers/types.js";
import { record } from "../audit/index.js";
import { lockAgreement } from "./admin-write.js";
import { runConsentDigest } from "./consent-digest.js";
export interface DocsJobDeps {
  readonly tx: TxRunner;
  readonly clock: Clock;
  readonly storage: StorageProvider;
  readonly alerts: Alerts;
  readonly countActiveUsers: (tx: Tx) => Promise<number>;
}
export async function sweepAgreementVersions(
  tx: Tx,
  deps: Pick<DocsJobDeps, "clock" | "countActiveUsers">,
  timerId?: string,
  signal?: AbortSignal,
) {
  const now = deps.clock.now(),
    ctx = createIdentityContext({
      actor: { type: "system", job: "docs.sweep" },
      requestId: "docs_sweep",
      ip: null,
      userAgent: null,
    });
  const keys = await tx.agreementVersion.findMany({
    where: { status: "pending", effectiveAt: { lte: now } },
    select: { agreementKey: true },
    distinct: ["agreementKey"],
    orderBy: { agreementKey: "asc" },
  });
  let activated = 0,
    superseded = 0;
  for (const { agreementKey: key } of keys) {
    signal?.throwIfAborted();
    await lockAgreement(tx, key);
    const due = await tx.agreementVersion.findMany({
      where: { agreementKey: key, status: "pending", effectiveAt: { lte: now } },
      orderBy: [{ effectiveAt: "asc" }, { major: "asc" }, { minor: "asc" }, { id: "asc" }],
    });
    if (!due.length) continue;
    const expected = await deps.countActiveUsers(tx);
    for (const next of due) {
      const prior = await tx.agreementVersion.findMany({
        where: { agreementKey: key, status: "active" },
      });
      for (const old of prior) {
        await tx.agreementVersion.update({
          where: { id: old.id },
          data: { status: "superseded", lockVersion: { increment: 1 }, updatedAt: now },
        });
        superseded += 1;
        await record(
          tx,
          ctx.actor,
          {
            requestId: ctx.requestId,
            ip: null,
            userAgent: null,
            authMethod: null,
            sessionId: null,
            ...(timerId ? { timerId } : {}),
          },
          {
            stream: "ops",
            category: "agreement",
            action: "docs.agreement_version.supersede",
            summary: "协议旧版本簿记失效",
            target: { type: "agreement_version", id: old.id },
            before: { status: "active" },
            after: { status: "superseded" },
            fields: ["status"],
          },
        );
      }
      await tx.agreementVersion.update({
        where: { id: next.id },
        data: {
          status: "active",
          activatedAt: now,
          expectedConsents: expected,
          lockVersion: { increment: 1 },
          updatedAt: now,
        },
      });
      activated += 1;
      await record(
        tx,
        ctx.actor,
        {
          requestId: ctx.requestId,
          ip: null,
          userAgent: null,
          authMethod: null,
          sessionId: null,
          ...(timerId ? { timerId } : {}),
        },
        {
          stream: "ops",
          category: "agreement",
          action: "docs.agreement_version.activate",
          summary: "协议版本到点簿记生效",
          target: { type: "agreement_version", id: next.id },
          before: { status: "pending" },
          after: { status: "active", expectedConsents: expected },
          fields: ["status", "expectedConsents"],
        },
      );
    }
  }
  signal?.throwIfAborted();
  return { activated, superseded };
}
export async function scheduledDocsSweep(deps: DocsJobDeps, ctx: RecurringRunContext) {
  ctx.signal?.throwIfAborted();
  return deps.tx.run((tx) => sweepAgreementVersions(tx, deps, undefined, ctx.signal));
}
export async function scheduledConsentDigest(deps: DocsJobDeps, ctx: RecurringRunContext) {
  return runConsentDigest(deps, ctx.scheduledFor, ctx.signal);
}
