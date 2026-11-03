import type {
  AdminTakedownTaskListQuery,
  AdminTakedownTaskSummaryQuery,
  MerchantTakedownTaskListQuery,
  MerchantTakedownTaskSummaryQuery,
  TakedownTaskBatchCheckBody,
  TakedownTaskCheckBody,
  TakedownTaskConfirmBody,
  TakedownTaskNoteBody,
} from "@liyoxi/contract";
import type { StaffContext } from "../authz/index.js";
import { AppError } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { PublishViewer, PublishWriteOptions } from "./context.js";
import type { TakedownDeps } from "./takedown-context.js";
import { createTakedownAsync } from "./takedown-async.js";
import { repairMissingTakedowns } from "./takedown-invariants.js";
import {
  listTakedowns,
  merchantTakedownList,
  merchantTakedownSummary,
  takedownCard,
  takedownDetail,
  takedownRow,
  takedownSummary,
} from "./takedown-read.js";
import { assertTakedownStaff, takedownAccess, takedownOf } from "./takedown-repo.js";
import { snapshotOf } from "./repo.js";
import { invalid, owner } from "./validate.js";
import {
  adminTakedownAction,
  applyTakedownCheck,
  confirmTakedown,
  evaluateTakedowns,
  prelockTakedowns,
  validateTakedownCheck,
} from "./takedown-write.js";
export function createPublishTakedown(deps: TakedownDeps) {
  async function runStaff<T>(
    ctx: IdentityContext,
    staff: StaffContext,
    ids: readonly string[],
    breach: boolean,
    options: PublishWriteOptions,
    write: (tx: Tx) => Promise<T>,
  ) {
    if (ctx.actor.type !== "staff" || ctx.actor.id !== staff.staff.id)
      throw new AppError("PERMISSION_DENIED");
    takedownAccess(staff);
    // C50 must not replay a frozen response after the caller loses task ownership/scope.
    await deps.tx.run(async (tx) => {
      for (const id of ids) assertTakedownStaff(staff, await takedownOf(tx, id, staff), breach);
    });
    return deps.tx.run(write, options);
  }
  const action = (
    ctx: IdentityContext,
    staff: StaffContext,
    id: string,
    operation: "markOnline" | "escalate" | "sendBreachNotice",
    body: TakedownTaskNoteBody,
    options: PublishWriteOptions,
  ) =>
    runStaff(ctx, staff, [id], operation === "sendBreachNotice", options, async (tx) => {
      await adminTakedownAction(tx, deps, ctx, staff, id, operation, body);
      return takedownDetail(tx, deps, staff, id);
    });
  return {
    ...createTakedownAsync(deps),
    reconcile: (tx: Tx, now: Date) => repairMissingTakedowns(tx, deps, now),
    list: (staff: StaffContext, query: AdminTakedownTaskListQuery) =>
      deps.tx.run((tx) => listTakedowns(tx, deps, staff, query)),
    summary: (staff: StaffContext, query: AdminTakedownTaskSummaryQuery = {}) =>
      deps.tx.run((tx) => takedownSummary(tx, deps, staff, query)),
    get: (staff: StaffContext, id: string) =>
      deps.tx.run((tx) => takedownDetail(tx, deps, staff, id)),
    async merchantList(viewer: PublishViewer, query: MerchantTakedownTaskListQuery) {
      const raw = await deps.tx.run((tx) => merchantTakedownList(tx, deps, viewer, query));
      const items = [];
      for (const { card, posterFileId } of raw.items) {
        if (posterFileId)
          card.posterUrl = await deps.media.signRead({
            fileId: posterFileId,
            audience: "merchant",
          });
        items.push(card);
      }
      return { items, nextCursor: raw.nextCursor, hasMore: raw.hasMore };
    },
    merchantSummary: (viewer: PublishViewer, query: MerchantTakedownTaskSummaryQuery = {}) =>
      deps.tx.run((tx) => merchantTakedownSummary(tx, deps, viewer, query)),
    async confirm(
      viewer: PublishViewer,
      id: string,
      body: TakedownTaskConfirmBody,
      options: PublishWriteOptions = {},
    ) {
      owner(viewer);
      await deps.tx.run((tx) => takedownOf(tx, id, viewer));
      const raw = await deps.tx.run(async (tx) => {
        await confirmTakedown(tx, deps, viewer, id, body);
        const row = await takedownOf(tx, id, viewer);
        return {
          card: takedownCard(row, deps.clock.now()),
          posterFileId: snapshotOf(row.orderItem.dramaSnapshot).posterFileId ?? null,
        };
      }, options);
      const replayed = options.idem?.replayed ?? false;
      if (!replayed && raw.posterFileId)
        raw.card.posterUrl = await deps.media.signRead({
          fileId: raw.posterFileId,
          audience: "merchant",
        });
      return { ...raw.card, posterUrl: replayed ? null : raw.card.posterUrl, replayed };
    },
    check: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: TakedownTaskCheckBody,
      options: PublishWriteOptions = {},
    ) =>
      runStaff(ctx, staff, [id], false, options, async (tx) => {
        const first = await takedownOf(tx, id, staff);
        await prelockTakedowns(tx, deps, [first], staff.staff.id, body.evidenceFileIds);
        const row = await takedownOf(tx, id, staff);
        await validateTakedownCheck(tx, row, staff, body);
        await applyTakedownCheck(tx, deps, ctx, staff, row, body);
        await evaluateTakedowns(tx, deps, [row]);
        return takedownDetail(tx, deps, staff, id);
      }),
    batchCheck: (
      ctx: IdentityContext,
      staff: StaffContext,
      body: TakedownTaskBatchCheckBody,
      options: PublishWriteOptions = {},
    ) =>
      runStaff(
        ctx,
        staff,
        body.items.map((i) => i.takedownTaskId),
        false,
        options,
        async (tx) => {
          if (
            !body.items.length ||
            body.items.length > 50 ||
            new Set(body.items.map((i) => i.takedownTaskId)).size !== body.items.length
          )
            throw invalid("items", "须提交1–50个不同下架任务");
          // Scope failures stay 404 before collecting business errors; they disclose no row facts.
          const first = [];
          for (const item of body.items)
            first.push(await takedownOf(tx, item.takedownTaskId, staff));
          await prelockTakedowns(
            tx,
            deps,
            first,
            staff.staff.id,
            body.items.flatMap((i) => i.evidenceFileIds),
          );
          const rows = [],
            errors = [];
          for (const [index, item] of body.items.entries()) {
            const row = await takedownOf(tx, item.takedownTaskId, staff);
            rows.push(row);
            try {
              await validateTakedownCheck(tx, row, staff, item);
            } catch (error) {
              if (
                !(error instanceof AppError) ||
                ["NOT_FOUND", "PERMISSION_DENIED"].includes(error.error)
              )
                throw error;
              errors.push({
                index,
                takedownTaskId: item.takedownTaskId,
                error: error.error,
                message: error.message,
              });
            }
          }
          if (errors.length)
            throw new AppError("TAKEDOWN_BATCH_REJECTED", { details: { items: errors } });
          for (const [index, row] of rows.entries())
            await applyTakedownCheck(tx, deps, ctx, staff, row, body.items[index]!);
          const archivedTicketIds = await evaluateTakedowns(tx, deps, rows),
            items = [];
          for (const row of rows)
            items.push(
              await takedownRow(tx, await takedownOf(tx, row.id, staff), staff, deps.clock.now()),
            );
          return { items, archivedTicketIds };
        },
      ),
    markOnline: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: TakedownTaskNoteBody,
      options: PublishWriteOptions = {},
    ) => action(ctx, staff, id, "markOnline", body, options),
    escalate: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: TakedownTaskNoteBody,
      options: PublishWriteOptions = {},
    ) => action(ctx, staff, id, "escalate", body, options),
    sendBreachNotice: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      options: PublishWriteOptions = {},
    ) => action(ctx, staff, id, "sendBreachNotice", {}, options),
  };
}
export type PublishTakedown = ReturnType<typeof createPublishTakedown>;
