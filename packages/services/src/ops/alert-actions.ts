// W2-23：人工作用仅现有告警/死信技术行，不生成告警、不发恢复通知。
import { z, IdSchema } from "@liyoxi/contract";
import { assertPermission } from "../authz/index.js";
import { record } from "../audit/index.js";
import { AppError, createActor } from "../kernel/index.js";
import type { Clock, TxRunner } from "../kernel/index.js";
import { loadCliStaffContext } from "../staff/index.js";
import { retryDeadWebhook } from "../security/index.js";
export type AlertCliCommand = "ack" | "close" | "reset-webhook";
export interface AlertCliInput {
  staffId: string;
  command: AlertCliCommand;
  targetId: string;
  note: string;
}
export interface AlertCliResult {
  command: AlertCliCommand;
  targetId: string;
  status: "acked" | "resolved" | "received";
}
const inputSchema = z.strictObject({
  staffId: IdSchema,
  command: z.enum(["ack", "close", "reset-webhook"]),
  targetId: IdSchema,
  note: z
    .string()
    .trim()
    .refine(
      (value) => Array.from(value).length >= 5 && Array.from(value).length <= 200,
      "原因须5–200字",
    ),
});
export function createAlertActions(deps: { tx: TxRunner; clock: Clock }) {
  return {
    async runCli(input: AlertCliInput): Promise<AlertCliResult> {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) throw new AppError("VALIDATION_FAILED");
      const value = parsed.data;
      return deps.tx.run(async (tx) => {
        const ctx = await loadCliStaffContext(tx, value.staffId),
          now = deps.clock.now();
        assertPermission(
          ctx,
          value.command === "reset-webhook" ? "flow.ops.manage" : "sys.health.manage",
          now,
        );
        const actor = createActor({ type: "staff", id: ctx.staff.id, client: "cli" });
        const meta = {
          requestId: null,
          ip: null,
          userAgent: null,
          authMethod: null,
          sessionId: null,
          jobName: "cli.alerts.ack",
          actorRole: ctx.staff.roleKey,
        };
        let status: AlertCliResult["status"];
        if (value.command === "reset-webhook") {
          const { before, after } = await retryDeadWebhook(tx, value.targetId, now);
          await record(tx, actor, meta, {
            stream: "ops",
            category: "system_ops",
            action: "ops.webhook.retry",
            summary: "ops.webhook.retry",
            target: { type: "webhook_event", id: value.targetId },
            reason: { code: "other", text: value.note },
            before,
            after,
            fields: ["processState", "attempts", "nextAttemptAt"],
          });
          status = "received";
        } else {
          await tx.$queryRawUnsafe(
            "SELECT id FROM alert_event WHERE id=$1::uuid FOR UPDATE",
            value.targetId,
          );
          const before = await tx.alertEvent.findUnique({ where: { id: value.targetId } });
          if (!before) throw new AppError("NOT_FOUND");
          if (
            value.command === "ack"
              ? before.status !== "open"
              : before.status !== "open" && before.status !== "acked"
          )
            throw new AppError("STATE_NOT_ALLOWED");
          const after = await tx.alertEvent.update({
            where: { id: value.targetId },
            data:
              value.command === "ack"
                ? {
                    status: "acked",
                    ackedAt: now,
                    ackedByStaffId: ctx.staff.id,
                    note: value.note,
                    updatedAt: now,
                  }
                : { status: "resolved", resolvedAt: now, note: value.note, updatedAt: now },
          });
          const action = value.command === "ack" ? "ops.alert.acknowledge" : "ops.alert.resolve";
          await record(tx, actor, meta, {
            stream: "ops",
            category: "system_ops",
            action,
            summary: action,
            target: { type: "alert_event", id: value.targetId },
            reason: { code: "other", text: value.note },
            before,
            after,
            fields: ["status", "ackedAt", "ackedByStaffId", "resolvedAt", "note"],
          });
          status = value.command === "ack" ? "acked" : "resolved";
        }
        return { command: value.command, targetId: value.targetId, status };
      });
    },
  };
}
export type AlertActions = ReturnType<typeof createAlertActions>;
