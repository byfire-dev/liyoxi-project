import { EVENT_PAYLOAD_SCHEMAS } from "@liyoxi/contract";
import { AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type { DeliveredEvent, Tx } from "../kernel/index.js";
import type { RefRetentionInput } from "../media/index.js";
import type { ProfileLifecycleDeps } from "./context.js";
import { withLifecycleWithdrawal } from "./lifecycle-withdrawal.js";
import { refreshCompleteness } from "./repo.js";

export const PROFILE_TENANT_EVENTS = [
  "entity.abandoned",
  "entity.closed",
  "store.archived",
  "store.draft_deleted",
  "store.restored",
] as const;
type Message = {
  type: (typeof PROFILE_TENANT_EVENTS)[number];
  entityId: string;
  storeId?: string;
  archiveReason?: string;
};
function message(event: DeliveredEvent): Message {
  switch (event.type) {
    case "entity.abandoned":
    case "entity.closed":
    case "store.draft_deleted":
    case "store.restored":
    case "store.archived":
      return { type: event.type, ...EVENT_PAYLOAD_SCHEMAS[event.type].parse(event.payload) };
    default:
      throw new TypeError("profile 生命周期订阅收到未登记事件");
  }
}
const changed = () => new AppError("PRECONDITION_CHANGED");
const ids = (values: readonly string[]) => [...new Set(values)].sort();
const daysAfter = (anchor: Date, days: number) => new Date(anchor.getTime() + days * 86_400_000);
const yearsAfter = (anchor: Date) => {
  const target = new Date(anchor);
  target.setUTCFullYear(target.getUTCFullYear() + 3);
  return target;
};

async function discover(tx: Tx, input: Message) {
  const entity = await tx.entity.findUnique({
    where: { id: input.entityId },
    select: {
      id: true,
      lifecycle: true,
      closedAt: true,
      verificationStatus: true,
      lockVersion: true,
    },
  });
  if (!entity) throw new AppError("NOT_FOUND");
  const scope = { entityId: entity.id, ...(input.storeId ? { storeId: input.storeId } : {}) };
  const stores = await tx.store.findMany({
    where: { entityId: entity.id, ...(input.storeId ? { id: input.storeId } : {}) },
    orderBy: { id: "asc" },
    select: {
      id: true,
      entityId: true,
      lifecycle: true,
      archiveReason: true,
      archivedAt: true,
      qualificationStatus: true,
      isPrimary: true,
    },
  });
  if (input.storeId && stores.length !== 1) throw new AppError("NOT_FOUND");
  const isEntity = input.type.startsWith("entity.");
  const [rounds, profiles, media, services, docs] = await Promise.all([
    tx.qualificationSubmission.findMany({
      where: {
        ...scope,
        closedAt: null,
        ...(isEntity ? {} : { submittedAt: null }),
        ...(input.type === "store.restored" ? { id: { in: [] } } : {}),
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        entityId: true,
        storeId: true,
        kind: true,
        approvalRequestId: true,
        submittedAt: true,
        closedAt: true,
        outcome: true,
        roundNo: true,
        lockVersion: true,
      },
    }),
    tx.storeProfile.findMany({ where: scope, orderBy: { storeId: "asc" } }),
    tx.storeProfileMedia.findMany({
      where: { ...scope, removedAt: null },
      orderBy: { id: "asc" },
      select: {
        id: true,
        entityId: true,
        storeId: true,
        fileId: true,
        removedAt: true,
        updatedAt: true,
      },
    }),
    tx.storeServiceItem.findMany({
      where: { ...scope, removedAt: null, imageFileId: { not: null } },
      orderBy: { id: "asc" },
      select: {
        id: true,
        entityId: true,
        storeId: true,
        imageFileId: true,
        removedAt: true,
        updatedAt: true,
      },
    }),
    tx.qualificationDoc.findMany({
      where: {
        ...scope,
        ...(input.type === "entity.closed"
          ? {}
          : {
              qualificationSubmission: { closedAt: null, submittedAt: null },
            }),
        ...(input.type === "store.restored" ? { id: { in: [] } } : {}),
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        entityId: true,
        storeId: true,
        qualificationSubmissionId: true,
        fileId: true,
        removedAt: true,
        verdict: true,
        effectiveAt: true,
        supersededAt: true,
        updatedAt: true,
      },
    }),
  ]);
  const approvals = await tx.approvalRequest.findMany({
    where: {
      id: {
        in: rounds.flatMap((round) => (round.approvalRequestId ? [round.approvalRequestId] : [])),
      },
    },
    orderBy: { id: "asc" },
    select: {
      id: true,
      kind: true,
      entityId: true,
      storeId: true,
      subjectType: true,
      subjectId: true,
      status: true,
      roundNo: true,
      lockVersion: true,
    },
  });
  return { entity, stores, rounds, approvals, profiles, media, services, docs };
}
type Graph = Awaited<ReturnType<typeof discover>>;
function isCurrent(graph: Graph, input: Message) {
  if (input.type === "entity.closed" || input.type === "entity.abandoned")
    return graph.entity.lifecycle === (input.type === "entity.closed" ? "closed" : "abandoned");
  const store = graph.stores[0]!;
  if (input.type === "store.restored")
    return store.lifecycle === "active" && graph.entity.lifecycle === "active";
  return (
    store.lifecycle === "archived" &&
    (input.type === "store.draft_deleted"
      ? store.archiveReason === "draft_deleted"
      : store.archiveReason === input.archiveReason)
  );
}
function validate(graph: Graph, input: Message) {
  if (!isCurrent(graph, input)) throw changed();
  if (
    input.type.startsWith("entity.") &&
    (!graph.entity.closedAt || graph.stores.some((store) => store.lifecycle !== "archived"))
  )
    throw changed();
  if (input.type !== "store.restored" && graph.stores.some((store) => !store.archivedAt))
    throw changed();
  for (const round of graph.rounds) {
    if (!["initial", "new_store", "change"].includes(round.kind)) throw changed();
    if (!round.submittedAt) {
      if (round.approvalRequestId !== null) throw changed();
      continue;
    }
    const approval = graph.approvals.find((row) => row.id === round.approvalRequestId);
    if (
      !approval ||
      approval.status !== "pending" ||
      approval.kind !== "qualification" ||
      approval.entityId !== round.entityId ||
      approval.storeId !== round.storeId ||
      approval.subjectType !== "store" ||
      approval.subjectId !== round.storeId ||
      approval.roundNo !== round.roundNo
    )
      throw changed();
  }
  const drafts = new Set(
    graph.rounds.filter((round) => !round.submittedAt).map((round) => round.id),
  );
  if (
    graph.docs.some(
      (doc) =>
        drafts.has(doc.qualificationSubmissionId) &&
        !doc.removedAt &&
        (doc.verdict !== null || doc.effectiveAt !== null),
    )
  )
    throw changed();
}
type Reference = RefRetentionInput & { source: "logo" | "media" | "service" | "doc" };
function references(graph: Graph): Reference[] {
  const values: Reference[] = [
    ...graph.profiles.flatMap((profile): Reference[] =>
      profile.logoFileId
        ? [
            {
              source: "logo",
              fileId: profile.logoFileId,
              refType: "store_profile",
              refId: profile.storeId,
              role: "logo",
              entityId: profile.entityId,
              storeId: profile.storeId,
            },
          ]
        : [],
    ),
    ...graph.media.map((row): Reference => ({
      source: "media",
      fileId: row.fileId,
      refType: "store_profile_media",
      refId: row.id,
      role: "main",
      entityId: row.entityId,
      storeId: row.storeId,
    })),
    ...graph.services.map((row): Reference => ({
      source: "service",
      fileId: row.imageFileId!,
      refType: "store_service_item",
      refId: row.id,
      role: "image",
      entityId: row.entityId,
      storeId: row.storeId,
    })),
    ...graph.docs.map((row): Reference => ({
      source: "doc",
      fileId: row.fileId,
      refType: "qualification_doc",
      refId: row.id,
      role: "main",
      entityId: row.entityId,
      storeId: row.storeId,
    })),
  ];
  return values.sort(
    (a, b) =>
      a.fileId.localeCompare(b.fileId) ||
      a.refType.localeCompare(b.refType) ||
      a.refId.localeCompare(b.refId),
  );
}
const ownerInput = (ref: Reference): RefRetentionInput => ({
  fileId: ref.fileId,
  refType: ref.refType,
  refId: ref.refId,
  role: ref.role,
  entityId: ref.entityId,
  storeId: ref.storeId,
});

async function release(tx: Tx, deps: ProfileLifecycleDeps, ref: Reference, target: Date) {
  const input = ownerInput(ref);
  const fact = await deps.media.readRefRetention(tx, input);
  if (!fact)
    throw new AppError("FILE_NOT_AVAILABLE", { details: { reason: "missing_business_file_ref" } });
  // 稳定事实已经覆盖目标时，不再让原 release 的当前时钟最低期顺延历史。
  if (fact.state === "released" && fact.keepUntil >= target) return;
  await deps.media.release(tx, { ...input, keepUntil: target });
}

async function restore(
  tx: Tx,
  deps: ProfileLifecycleDeps,
  graph: Graph,
  refs: Reference[],
  now: Date,
) {
  // 沿本域 snapshot/views 的既有技术事实只读；410 全集已锁，引用归属与写入仍由 media 校验。
  const files = new Map(
    (
      await tx.fileObject.findMany({
        where: { id: { in: ids(refs.map((ref) => ref.fileId)) } },
        select: { id: true, status: true, category: true, moderationState: true },
      })
    ).map((file) => [file.id, file]),
  );
  const cleaned = new Set<string>();
  for (const ref of refs) {
    const file = files.get(ref.fileId);
    if (!file) throw new AppError("FILE_NOT_AVAILABLE");
    const categories =
      ref.source === "media"
        ? ["profile_image", "profile_video", "profile_promo"]
        : ["profile_image"];
    if (
      file.status !== "deleted" ||
      file.moderationState === "block" ||
      !categories.includes(file.category)
    ) {
      // stored 文件由真正 link 校验审核、类别与归属；过渡态保持可重试，不能删行冒充恢复。
      await deps.media.link(tx, ownerInput(ref));
      continue;
    }
    // deleted 同样先交 owner 核归属，不能把串主体/门店的错误吞成“已清除”。
    await deps.media.readRefRetention(tx, ownerInput(ref));
    if (ref.source === "logo")
      await tx.storeProfile.update({
        where: { storeId: ref.storeId! },
        data: { logoFileId: null, updatedAt: now },
      });
    else if (ref.source === "media")
      await tx.storeProfileMedia.update({
        where: { id: ref.refId },
        data: { removedAt: now, updatedAt: now },
      });
    else if (ref.source === "service")
      await tx.storeServiceItem.update({
        where: { id: ref.refId },
        data: { removedAt: now, updatedAt: now },
      });
    cleaned.add(ref.storeId!);
  }
  for (const profile of graph.profiles) {
    if (cleaned.has(profile.storeId))
      await tx.storeProfile.update({
        where: { storeId: profile.storeId },
        data: { lockVersion: { increment: 1 }, updatedAt: now },
      });
    await refreshCompleteness(tx, profile.storeId, now);
  }
}

export function createProfileTenantLifecycle(deps: ProfileLifecycleDeps) {
  return {
    async onTenantLifecycle(tx: Tx, event: DeliveredEvent): Promise<void> {
      const input = message(event);
      const first = await discover(tx, input);
      if (!isCurrent(first, input)) return;
      const stamp = JSON.stringify(first);
      // 低锁全集先锁完；后续审批回调只重入既有锁，绝不在文件锁后发现另一轮再补低锁。
      await lockRows(tx, "approval_request", ids(first.approvals.map((row) => row.id)));
      await lockRows(tx, "qualification_submission", ids(first.rounds.map((row) => row.id)));
      await lockRows(tx, "entity", [input.entityId]);
      await lockRows(tx, "store", ids(first.stores.map((row) => row.id)));
      await lockRows(tx, "store_profile", ids(first.stores.map((row) => row.id)));
      const locked = await discover(tx, input);
      if (JSON.stringify(locked) !== stamp) throw changed();
      validate(locked, input);
      const refs = references(locked);
      await lockRows(tx, "file_object", ids(refs.map((ref) => ref.fileId)));
      const graph = await discover(tx, input);
      if (JSON.stringify(graph) !== stamp) throw changed();
      validate(graph, input);
      const now = deps.clock.now();
      if (input.type === "store.restored") return restore(tx, deps, graph, refs, now);
      const ctx = createIdentityContext({
        actor: { type: "system", job: "profile.on_tenant_lifecycle" },
        entityId: input.entityId,
        storeId: input.storeId ?? null,
        requestId: event.id,
      });
      const drafts = new Set<string>();
      for (const round of graph.rounds) {
        if (round.submittedAt) {
          await withLifecycleWithdrawal(tx, deps, ctx, input.entityId, () =>
            deps.approval.withdraw(tx, ctx, {
              approvalId: round.approvalRequestId!,
              note: "经营主体终止，系统撤回在审资质",
            }),
          );
        } else {
          drafts.add(round.id);
          await tx.qualificationSubmission.update({
            where: { id: round.id },
            data: { closedAt: now, outcome: "discarded", updatedAt: now },
          });
          await tx.qualificationDoc.updateMany({
            where: { qualificationSubmissionId: round.id, removedAt: null },
            data: { removedAt: now, updatedAt: now },
          });
        }
      }
      for (const ref of refs) {
        if (ref.source === "doc") {
          if (input.type === "entity.closed")
            await release(tx, deps, ref, yearsAfter(graph.entity.closedAt!));
          else if (
            drafts.has(graph.docs.find((doc) => doc.id === ref.refId)!.qualificationSubmissionId)
          ) {
            const anchor =
              input.type === "entity.abandoned"
                ? graph.entity.closedAt!
                : graph.stores.find((store) => store.id === ref.storeId)!.archivedAt!;
            await release(tx, deps, ref, daysAfter(anchor, 7));
          }
        } else if (!input.type.startsWith("entity.")) {
          const store = graph.stores.find((row) => row.id === ref.storeId)!;
          await release(tx, deps, ref, daysAfter(store.archivedAt!, 180));
        }
      }
      for (const profile of graph.profiles)
        if (drafts.size) await refreshCompleteness(tx, profile.storeId, now);
    },
  };
}
export type ProfileTenantLifecycle = ReturnType<typeof createProfileTenantLifecycle>;

export async function unboundTenantLifecycle(): Promise<never> {
  throw new TypeError("profile 生命周期订阅必须绑定本 worker 的真实服务");
}
