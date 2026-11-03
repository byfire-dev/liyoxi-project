import type { Prisma } from "@liyoxi/db";
import { byStore, hasPermission } from "../authz/index.js";
import type { StaffContext } from "../authz/index.js";
import { AppError, createIdentityContext, lockRows } from "../kernel/index.js";
import type { IdentityContext, Tx } from "../kernel/index.js";
import type { PublishDeps, PublishViewer, PublishWriteOptions } from "./context.js";
import { accountInclude, accountOf } from "./repo.js";
import { accountCard, accountDetail, accountRow } from "./views.js";
import { checked } from "./machines.js";
import { invalid, normalize, owner, reasonScene } from "./validate.js";
import { withAccountUnbind } from "./account-unbind.js";
type Filter = { storeId?: string; platform?: string; q?: string };
const activePhases = ["pending_start", "producing", "to_launch", "live"];
function where(staff: StaffContext, query: Filter): Prisma.ChannelAccountWhereInput {
  return {
    AND: [byStore(staff.scope), ...(query.storeId ? [{ storeId: query.storeId }] : [])],
    ...(query.platform ? { platform: query.platform } : {}),
    ...(query.q
      ? {
          OR: [
            { accountName: { contains: query.q, mode: "insensitive" } },
            { accountUidNorm: { startsWith: normalize(query.q) } },
          ],
        }
      : {}),
  };
}
async function unbindTx(tx: Tx, deps: PublishDeps, viewer: PublishViewer, id: string) {
  owner(viewer);
  const first = await accountOf(tx, id);
  if (first.storeId !== viewer.membership.storeId || first.entityId !== viewer.membership.entityId)
    throw new AppError("NOT_FOUND");
  const pending = first.channelAccountSubmissions
    .filter((s) => s.approvalRequest.status === "pending")
    .map((s) => s.approvalRequestId)
    .sort();
  await lockRows(tx, "approval_request", pending);
  await lockRows(tx, "channel_account", [id]);
  const row = await accountOf(tx, id);
  if (row.status === "unbound") throw new AppError("STATE_NOT_ALLOWED");
  const currentPending = row.channelAccountSubmissions
    .filter((s) => s.approvalRequest.status === "pending")
    .map((s) => s.approvalRequestId)
    .sort();
  // A reviewer may finish while we wait for its lock. Only a newly submitted,
  // unowned approval requires restarting the lock plan. Finished reviews are safe.
  if (currentPending.some((approvalId) => !pending.includes(approvalId)))
    throw new AppError("PRECONDITION_CHANGED");
  const active = await tx.orderItemAccount.findMany({
    where: { channelAccountId: id, orderItem: { phase: { in: activePhases } } },
    select: { orderItemId: true },
  });
  const tasks = await tx.takedownTask.findMany({
    where: { channelAccountId: id, status: { in: ["pending_merchant", "merchant_confirmed"] } },
    select: { id: true },
  });
  if (active.length || tasks.length)
    throw new AppError("CHANNEL_ACCOUNT_IN_USE", {
      details: { activeOrderItemCount: active.length, openTakedownTaskCount: tasks.length },
    });
  const system = createIdentityContext({
    actor: { type: "system", job: "publish.account_unbind" },
    requestId: viewer.ctx.requestId,
  });
  await withAccountUnbind(tx, id, async () => {
    for (const approvalId of currentPending)
      await deps.approval.withdraw(tx, system, {
        approvalId,
        note: "商家解绑渠道账号，撤回在途核验",
      });
  });
  await deps.flow.transition(tx, viewer.ctx, {
    machine: "channel_account",
    stateField: "status",
    id,
    event: "account.unbind",
    ref: "11:134",
    args: checked(),
    entityId: row.entityId,
    storeId: row.storeId,
    set: { unbound_at: deps.clock.now() },
    emit: {
      type: "account.unbound",
      payload: { v: 1, channelAccountId: id, entityId: row.entityId, storeId: row.storeId },
    },
  });
  return accountCard(tx, await accountOf(tx, id));
}
export function createChannelHealth(deps: PublishDeps) {
  return {
    list: (
      staff: StaffContext,
      query: Filter & { status?: string[]; page: number; pageSize: number },
    ) =>
      deps.tx.run(async (tx) => {
        const rows = await tx.channelAccount.findMany({
          where: {
            ...where(staff, query),
            status: query.status ? { in: query.status } : { not: "unbound" },
          },
          include: accountInclude,
        });
        const rank = ["abnormal", "pending_verify", "available", "unbound"];
        rows.sort(
          (a, b) =>
            rank.indexOf(a.status) - rank.indexOf(b.status) ||
            a.createdAt.getTime() - b.createdAt.getTime() ||
            a.id.localeCompare(b.id),
        );
        return {
          items: await Promise.all(
            rows
              .slice((query.page - 1) * query.pageSize, query.page * query.pageSize)
              .map((r) => accountRow(tx, r, staff)),
          ),
          total: rows.length,
          page: query.page,
          pageSize: query.pageSize,
        };
      }),
    summary: (staff: StaffContext, query: Filter) =>
      deps.tx.run(async (tx) => {
        const rows = await tx.channelAccount.findMany({
          where: where(staff, query),
          select: { status: true },
        });
        const count = (status: string) => rows.filter((r) => r.status === status).length;
        return {
          total: rows.filter((r) => r.status !== "unbound").length,
          pendingVerify: count("pending_verify"),
          available: count("available"),
          abnormal: count("abnormal"),
          unbound: count("unbound"),
        };
      }),
    markAbnormal: (
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      body: { reasonCode: string; note: string },
      options: PublishWriteOptions = {},
    ) =>
      deps.tx.run(async (tx) => {
        if (!hasPermission(staff, "publish.account.mark_abnormal"))
          throw new AppError("PERMISSION_DENIED");
        await accountOf(tx, id, staff);
        await lockRows(tx, "channel_account", [id]);
        const row = await accountOf(tx, id, staff);
        if (row.status !== "available") throw new AppError("STATE_NOT_ALLOWED");
        if (!body.note.trim() || body.note.length > 200) throw invalid("note", "说明须为1–200字");
        await reasonScene(tx, [body.reasonCode], "account_verify");
        await deps.flow.transition(tx, ctx, {
          machine: "channel_account",
          stateField: "status",
          id,
          event: "account.mark_abnormal",
          ref: "11:133",
          args: checked(),
          entityId: row.entityId,
          storeId: row.storeId,
          reasonCode: body.reasonCode,
          note: body.note,
          set: {
            abnormal_source: "manual",
            abnormal_reason_code: body.reasonCode,
            abnormal_note: body.note,
          },
          emit: {
            type: "account.abnormal",
            payload: {
              v: 1,
              channelAccountId: id,
              entityId: row.entityId,
              storeId: row.storeId,
              abnormalSource: "manual",
              reasonCode: body.reasonCode,
            },
          },
        });
        return accountDetail(tx, deps, id, staff);
      }, options),
    unbind: (viewer: PublishViewer, id: string, options: PublishWriteOptions = {}) =>
      deps.tx.run((tx) => unbindTx(tx, deps, viewer, id), options),
  };
}
