import type { InvariantViolation, Tx } from "../kernel/index.js";
import { dateOf } from "./repo.js";
export const PUBLISH_INVARIANT_CODES = [
  "I1",
  "I2",
  "I3",
  "I4",
  "I5",
  "I6",
  "I7",
  "I8",
  "I9",
] as const;
export async function findPublishViolations(tx: Tx, code: string): Promise<InvariantViolation[]> {
  const result: InvariantViolation[] = [],
    bad = (type: string, id: string, entityId: string, detail: Record<string, unknown>) =>
      result.push({ subject: { type, id }, entityId, detail });
  if (code === "I1") {
    const rows = await tx.orderItemAccount.findMany({
      include: { orderItem: true, channelAccount: true },
    });
    for (const r of rows)
      if (r.orderItem.storeId !== r.channelAccount.storeId)
        bad("order_item", r.orderItemId, r.orderItem.entityId, {
          channelAccountId: r.channelAccountId,
        });
  }
  if (code === "I2") {
    const rows = await tx.channelAccount.findMany({
      include: {
        channelAccountSubmissions: {
          include: { approvalRequest: true },
          orderBy: { roundNo: "desc" },
        },
      },
    });
    for (const a of rows) {
      const pending = a.channelAccountSubmissions.filter(
        (s) => s.approvalRequest.status === "pending",
      );
      if (
        a.status === "pending_verify"
          ? pending.length !== 1 || pending[0]?.id !== a.channelAccountSubmissions[0]?.id
          : pending.length > 0
      )
        bad("channel_account", a.id, a.entityId, {
          status: a.status,
          pendingCount: pending.length,
        });
    }
  }
  if (["I3", "I4", "I5"].includes(code)) {
    const rows = await tx.channelAccountSubmission.findMany({
      include: { channelAccount: true, approvalRequest: true },
    });
    for (const s of rows) {
      const a = s.approvalRequest;
      if (
        code === "I3" &&
        (a.kind !== "channel_account" ||
          a.subjectType !== "channel_account" ||
          a.subjectId !== s.channelAccountId ||
          a.roundNo !== s.roundNo)
      )
        bad("channel_account_submission", s.id, s.entityId, { approvalRequestId: a.id });
      if (code === "I4" && ["approved", "rejected"].includes(a.status) && s.compareResult === null)
        bad("channel_account_submission", s.id, s.entityId, { missingCompareResult: true });
      if (
        code === "I5" &&
        (s.entityId !== s.channelAccount.entityId || s.storeId !== s.channelAccount.storeId)
      )
        bad("channel_account_submission", s.id, s.entityId, { scopeMismatch: true });
    }
  }
  if (["I6", "I7", "I8", "I9"].includes(code)) {
    const tasks = await tx.launchTask.findMany({
      include: {
        channelAccount: true,
        orderItem: true,
        deliveryTicket: true,
        launchSubmissions: true,
      },
    });
    for (const t of tasks) {
      const passed = t.launchSubmissions.filter((s) =>
          ["passed", "passed_partial"].includes(s.result),
        ),
        pending = t.launchSubmissions.filter((s) => s.result === "pending"),
        selected = await tx.orderItemAccount.findUnique({
          where: {
            orderItemId_channelAccountId: {
              orderItemId: t.orderItemId,
              channelAccountId: t.channelAccountId,
            },
          },
        });
      if (code === "I6" && t.isLive && (t.verifiedEpisodeCount <= 0 || !passed.length))
        bad("launch_task", t.id, t.entityId, { noPassedLaunch: true });
      if (
        code === "I7" &&
        ((!selected && t.voidReason !== "account_changed") ||
          t.storeId !== t.orderItem.storeId ||
          t.storeId !== t.channelAccount.storeId ||
          t.entityId !== t.orderItem.entityId ||
          t.entityId !== t.channelAccount.entityId ||
          t.platform !== t.channelAccount.platform)
      )
        bad("launch_task", t.id, t.entityId, { selectionOrScopeMismatch: true });
      const expectedCount = Math.max(0, ...passed.map((s) => s.verifiedEpisodeCount ?? 0)),
        expectedDate = passed.map((s) => dateOf(s.actualLaunchDate)!).sort()[0] ?? null;
      if (
        code === "I8" &&
        (t.verifiedEpisodeCount !== expectedCount ||
          dateOf(t.firstLaunchDate) !== expectedDate ||
          t.currentRoundNo !== Math.max(0, ...t.launchSubmissions.map((s) => s.roundNo)) ||
          (t.reviewStatus === "verifying") !== (pending.length === 1) ||
          pending.length > 1)
      )
        bad("launch_task", t.id, t.entityId, {
          expectedCount,
          expectedDate,
          pendingCount: pending.length,
        });
      if (
        code === "I9" &&
        (t.deliveryTicket.orderItemId !== t.orderItemId ||
          t.verifiedEpisodeCount > t.orderItem.episodeCount ||
          (["takedown", "archived", "terminated"].includes(t.deliveryTicket.step) &&
            !(t.reviewStatus === "void" || (t.reviewStatus === "passed" && t.isLive))))
      )
        bad("launch_task", t.id, t.entityId, {
          ticketId: t.deliveryTicketId,
          verifiedEpisodeCount: t.verifiedEpisodeCount,
        });
    }
    if (code === "I6") {
      const tickets = await tx.deliveryTicket.findMany({
        where: { step: { in: ["in_service", "awaiting_launch", "launch_verify"] } },
        include: { launchTasks: true },
      });
      for (const ticket of tickets) {
        const hasLive = ticket.launchTasks.some((t) => t.isLive);
        if (ticket.step === "in_service" ? !hasLive : hasLive)
          bad("delivery_ticket", ticket.id, ticket.entityId, { step: ticket.step, hasLive });
      }
    }
  }
  return result;
}
