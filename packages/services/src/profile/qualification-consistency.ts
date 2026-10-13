import { EVENT_PAYLOAD_SCHEMAS, QUALIFICATION_DUPLICATE_REJECT_NOTE } from "@liyoxi/contract";
import {
  alertsOf,
  AppError,
  createIdentityContext,
  invariantsOf,
  invariantNow,
  lockRows,
} from "../kernel/index.js";
import type {
  Assembly,
  DeliveredEvent,
  InvariantRunContext,
  InvariantScope,
  InvariantViolation,
  Tx,
} from "../kernel/index.js";
import type { ProfileDeps } from "./context.js";
import { findVerifiedEntityByUsccBidx } from "../tenant/index.js";
import { withSystemDuplicateCall } from "./qualification-kind.js";
import { qualificationDuplicateBatch } from "./qualification-duplicate-batch.js";
import type { ProfileConsistencyTransactions } from "./consistency-transactions.js";

export const PROFILE_APPROVED_EVENTS = [
  "store.qualification.approved",
  "store.qualification_change.approved",
] as const;
type Deps = Pick<ProfileDeps, "clock" | "tenant" | "approval" | "events"> & {
  readonly assembly: Assembly;
  readonly commits: ProfileConsistencyTransactions;
};
type Anchor = {
  entityId: string;
  storeId: string;
  submissionId: string;
  type: (typeof PROFILE_APPROVED_EVENTS)[number];
};
const ids = (values: readonly string[]) => [...new Set(values)].sort();
const changed = () => new AppError("PRECONDITION_CHANGED");
async function source(tx: Tx, input: Anchor) {
  const round = await tx.qualificationSubmission.findUnique({
    where: { id: input.submissionId },
    include: {
      entity: true,
      qualificationDocs: { where: { docType: "business_license", removedAt: null } },
    },
  });
  if (
    !round ||
    round.entityId !== input.entityId ||
    round.storeId !== input.storeId ||
    round.outcome !== "approved" ||
    !round.closedAt ||
    (round.kind === "change") !== (input.type === "store.qualification_change.approved")
  )
    return null;
  const doc = round.qualificationDocs[0];
  if (
    !doc?.certNoBidx ||
    !doc.effectiveAt ||
    doc.supersededAt ||
    round.entity.verificationStatus !== "verified" ||
    !round.entity.usccBidx ||
    !Buffer.from(doc.certNoBidx).equals(Buffer.from(round.entity.usccBidx))
  )
    return null;
  return { roundId: round.id, entityId: round.entityId, docId: doc.id, bidx: doc.certNoBidx };
}
async function discover(tx: Tx, scope: InvariantScope, anchor?: Anchor) {
  const winnerSource = anchor ? await source(tx, anchor) : null;
  if (anchor && !winnerSource) return { winnerSource, rows: [], more: false };
  const batch = await qualificationDuplicateBatch(tx, scope, winnerSource?.bidx);
  const docs = await tx.qualificationDoc.findMany({
    where: { id: { in: batch.ids } },
    orderBy: { id: "asc" },
    include: {
      qualificationSubmission: {
        select: {
          id: true,
          entityId: true,
          storeId: true,
          roundNo: true,
          kind: true,
          lockVersion: true,
          approvalRequestId: true,
          approvalRequest: {
            select: {
              status: true,
              entityId: true,
              storeId: true,
              roundNo: true,
              subjectType: true,
              subjectId: true,
              kind: true,
            },
          },
        },
      },
    },
  });
  const rows = [];
  for (const doc of docs) {
    const round = doc.qualificationSubmission,
      approval = round.approvalRequest;
    if (
      !approval ||
      approval.status !== "pending" ||
      !round.roundNo ||
      approval.kind !== "qualification" ||
      approval.entityId !== round.entityId ||
      approval.storeId !== round.storeId ||
      approval.roundNo !== round.roundNo ||
      approval.subjectType !== "store" ||
      approval.subjectId !== round.storeId
    )
      throw changed();
    // scope仅限制被检查主体；已认证赢家包括仍占用信用码的closed主体。
    const winner = await findVerifiedEntityByUsccBidx(tx, doc.certNoBidx!, round.entityId);
    if (winner)
      rows.push({
        docId: doc.id,
        bidx: doc.certNoBidx!,
        roundId: round.id,
        roundNo: round.roundNo,
        entityId: round.entityId,
        storeId: round.storeId,
        approvalId: round.approvalRequestId!,
        winnerId: winner.id,
        lockVersion: round.lockVersion,
      });
  }
  return { winnerSource, rows, more: batch.more };
}

export function createProfileQualificationConsistency(deps: Deps) {
  let stopping = false;
  async function repair(
    tx: Tx,
    scope: InvariantScope,
    at: Date,
    anchor?: Anchor,
    requestId?: string,
  ) {
    const first = await discover(tx, scope, anchor);
    if (!first.rows.length) return { violations: [], more: false };
    await lockRows(tx, "approval_request", ids(first.rows.map((r) => r.approvalId)));
    await lockRows(tx, "qualification_submission", ids(first.rows.map((r) => r.roundId)));
    await lockRows(tx, "entity", ids(first.rows.flatMap((r) => [r.entityId, r.winnerId])));
    await lockRows(tx, "store", ids(first.rows.map((r) => r.storeId)));
    await lockRows(tx, "store_profile", ids(first.rows.map((r) => r.storeId)));
    const current = await discover(tx, scope, anchor);
    if (JSON.stringify(current) !== JSON.stringify(first)) throw changed();
    const violations: InvariantViolation[] = [];
    for (const row of current.rows) {
      const ctx = createIdentityContext({
        actor: { type: "system", job: "profile.qualification_consistency" },
        entityId: row.entityId,
        storeId: row.storeId,
        requestId: requestId ?? `profile.I7:${row.roundId}`,
      });
      await withSystemDuplicateCall(
        tx,
        deps,
        ctx,
        { roundId: row.roundId, winnerId: row.winnerId },
        () =>
          deps.approval.reject(tx, ctx, {
            approvalId: row.approvalId,
            note: QUALIFICATION_DUPLICATE_REJECT_NOTE,
            reasonCodes: [],
            args: { confirm: { roundNo: row.roundNo }, rejectedDocIds: [row.docId] },
          }),
      );
      violations.push({
        subject: { type: "qualification_submission", id: row.roundId },
        entityId: row.entityId,
        detail: { systemRejectCode: "duplicate_entity", verifiedEntityId: row.winnerId },
        healed: { action: "系统驳回重复主体资质轮次", at },
      });
    }
    return { violations, more: current.more };
  }
  async function alert(violations: readonly InvariantViolation[]) {
    for (const violation of violations)
      await alertsOf(deps.assembly).raise({
        rule: "profile.qualification_duplicate",
        dimension:
          violation.subject && "id" in violation.subject ? violation.subject.id : undefined,
        severity: "P2",
        detail: { entityId: violation.entityId, ...violation.detail },
      });
  }
  async function publish(violations: readonly InvariantViolation[], report: boolean) {
    if (report)
      for (const violation of violations)
        await invariantsOf(deps.assembly).report({
          code: "profile.I7",
          module: "profile",
          severity: "P2",
          ...violation,
        });
    await alert(violations);
  }
  async function continueApproved(anchor: Anchor, requestId: string) {
    // 最外消费run追踪此循环；续批run只返回已提交事实，不递归注册提交后回调。
    while (!stopping) {
      try {
        const next = await deps.commits.tx.run((tx) =>
          repair(tx, {}, deps.clock.now(), anchor, requestId),
        );
        await publish(next.violations, true);
        if (!next.more) return;
      } catch {
        deps.commits.failed();
        await alertsOf(deps.assembly).raise({
          rule: "profile.qualification_duplicate",
          dimension: anchor.submissionId,
          severity: "P2",
          detail: { entityId: anchor.entityId, storeId: anchor.storeId, continuationFailed: true },
        });
        return;
      }
    }
  }
  return {
    async onQualificationApproved(tx: Tx, event: DeliveredEvent) {
      let anchor: Anchor;
      if (event.type === "store.qualification.approved") {
        const payload = EVENT_PAYLOAD_SCHEMAS[event.type].parse(event.payload);
        anchor = { ...payload, type: event.type };
        if (payload.kind === "new_store") return;
      } else if (event.type === "store.qualification_change.approved") {
        anchor = { ...EVENT_PAYLOAD_SCHEMAS[event.type].parse(event.payload), type: event.type };
      } else throw new TypeError("资质通过订阅收到未登记事件");
      const stored = await tx.outboxEvent.findUnique({ where: { id: event.id } });
      if (
        !stored ||
        stored.eventType !== event.type ||
        stored.aggregateType !== "store" ||
        stored.aggregateId !== anchor.storeId ||
        JSON.stringify(EVENT_PAYLOAD_SCHEMAS[event.type].parse(stored.payload)) !==
          JSON.stringify(EVENT_PAYLOAD_SCHEMAS[event.type].parse(event.payload))
      )
        throw changed();
      const first = await repair(tx, {}, deps.clock.now(), anchor, event.id);
      if (first.violations.length)
        deps.commits.afterCommit(tx, async () => {
          await publish(first.violations, true);
          if (first.more) await continueApproved(anchor, event.id);
        });
    },
    close() {
      stopping = true;
      return deps.commits.close();
    },
    async runI7(tx: Tx, scope: InvariantScope, ctx?: InvariantRunContext) {
      const batch = await repair(tx, scope, invariantNow(ctx));
      if (batch.violations.length)
        deps.commits.afterCommit(tx, () => publish(batch.violations, false));
      return batch.violations;
    },
  };
}
export type ProfileQualificationConsistency = ReturnType<
  typeof createProfileQualificationConsistency
>;
export async function unboundQualificationConsistency(): Promise<never> {
  throw new TypeError("资质系统一致性必须绑定当前运行时实例");
}

/** API与worker各自绑定，不覆盖已有生命周期订阅，不共享可变服务实例。 */
export function createProfileConsistencyAssembly(base: Assembly) {
  const subscriber = base.subscribers.filter((s) => s.name === "profile.onQualificationApproved");
  const checks = base.invariants.filter((c) => c.code === "profile.I7");
  if (
    subscriber.length !== 1 ||
    checks.length !== 1 ||
    [...subscriber[0]!.events].sort().join() !== [...PROFILE_APPROVED_EVENTS].sort().join()
  )
    throw new TypeError("资质一致性登记必须唯一且完整");
  let service: ProfileQualificationConsistency | undefined,
    closed = false,
    closing: Promise<void> | undefined;
  const current = () => {
    if (!service || closed) throw new TypeError("资质一致性实例未绑定或已关闭");
    return service;
  };
  const subscribers = base.subscribers.map((s) =>
    s.name === "profile.onQualificationApproved"
      ? {
          ...s,
          handle: (...args: Parameters<typeof s.handle>) =>
            current().onQualificationApproved(...args),
        }
      : s,
  );
  const invariants = base.invariants.map((c) =>
    c.code === "profile.I7"
      ? {
          ...c,
          run: (...args: Parameters<ProfileQualificationConsistency["runI7"]>) =>
            current().runI7(...args),
        }
      : c,
  );
  return {
    assembly: {
      ...base,
      subscribers,
      invariants,
      subscriber: (name: string) => subscribers.find((s) => s.name === name),
      invariant: (code: string) => invariants.find((c) => c.code === code),
    } satisfies Assembly,
    attach(value: ProfileQualificationConsistency) {
      if (closed || service) throw new TypeError("资质一致性实例只能绑定一次");
      service = value;
    },
    close() {
      closed = true;
      return (closing ??= (async () => {
        await service?.close();
        service = undefined;
      })());
    },
  };
}
