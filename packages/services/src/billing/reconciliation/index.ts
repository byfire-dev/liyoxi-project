import { createHash } from "node:crypto";
import type { ReconciliationMonthQuery, ReconciliationRerunBody } from "@liyoxi/contract";
import type { WxBillFile } from "@liyoxi/db";
import type { StaffContext } from "../../authz/index.js";
import { record } from "../../audit/index.js";
import { AppError, createThreePhaseRunner } from "../../kernel/index.js";
import type { IdentityContext, TxRunner, Tx } from "../../kernel/index.js";
import { assertStaff } from "../refund/context.js";
import type { ReconciliationDeps } from "./context.js";
import { dayLock, sourceOf, underDay } from "./context.js";
import { matchPayment } from "./match-payment.js";
import { matchRefund } from "./match-refund.js";
import { reverseMissing } from "./reverse.js";
import { finishDay, parsedFile } from "./summary.js";
import { dayView, monthView } from "./read.js";

type Options = NonNullable<Parameters<TxRunner["run"]>[1]>;
export async function runParsed(
  deps: ReconciliationDeps,
  ctx: IdentityContext,
  file: WxBillFile,
  signal: AbortSignal,
) {
  if (file.status !== "parsed" || !file.isHashVerified || !file.sha1 || !file.fileId)
    throw new AppError("RECON_BILL_NOT_READY", { details: { billFileStatus: file.status } });
  const lines = await deps.tx.run((tx) =>
    tx.wxBillLine.findMany({
      where: { wxBillFileId: file.id, isForeign: false },
      orderBy: { lineNo: "asc" },
    }),
  );
  for (const line of lines) {
    signal.throwIfAborted();
    if (line.lineKind === "payment") await matchPayment(deps, ctx, file, line, signal);
    else await matchRefund(deps, ctx, file, line, signal);
  }
  await reverseMissing(deps, ctx, file, signal);
}
export function createReconciliation(deps: ReconciliationDeps) {
  const phases = createThreePhaseRunner({ tx: deps.tx, clock: deps.clock });
  async function ready(tx: Tx, day: string) {
    const file = await parsedFile(tx, deps, day);
    if (!file || file.status !== "parsed")
      throw new AppError("RECON_BILL_NOT_READY", {
        details: { billFileStatus: file?.status ?? null },
      });
    return file;
  }
  return {
    list: (staff: StaffContext, query: ReconciliationMonthQuery) =>
      deps.tx.run((tx) => monthView(tx, deps, staff, query.month)),
    async rerun(
      ctx: IdentityContext,
      staff: StaffContext,
      id: string,
      input: ReconciliationRerunBody,
      options: Options,
    ) {
      if (options.idem?.mode !== "required") throw new AppError("INTERNAL");
      const original = await deps.tx.run(async (tx) => {
        await assertStaff(tx, deps, ctx, staff, "finance.recon.resolve");
        const row = await tx.reconDay.findUnique({ where: { id } });
        if (!row) throw new AppError("NOT_FOUND");
        if (row.channel !== "wechat_jsapi") throw new AppError("STATE_NOT_ALLOWED");
        const day = row.billDate.toISOString().slice(0, 10);
        if (input.confirm.billDate !== day) throw new AppError("CONFIRM_MISMATCH");
        return { day };
      });
      const day = original.day,
        source = sourceOf(deps);
      const runKey = createHash("sha256")
        .update(JSON.stringify([options.idem.actorKey, options.idem.scope, options.idem.key]))
        .digest("hex");
      return underDay(deps, day, (signal) =>
        phases.run(
          {
            async claim(tx) {
              await assertStaff(tx, deps, ctx, staff, "finance.recon.resolve");
              await dayLock(tx, source.mchid, day);
              return ready(tx, day);
            },
            async external(file) {
              try {
                await runParsed(deps, ctx, file, signal);
              } catch (error) {
                signal.throwIfAborted();
                await deps.tx.run(async (tx) => {
                  await dayLock(tx, source.mchid, day);
                  await tx.wxBillFile.updateMany({
                    where: {
                      id: file.id,
                      mchid: source.mchid,
                      billDate: file.billDate,
                      status: "parsed",
                      sha1: file.sha1,
                    },
                    data: { lastError: "matching_failed", updatedAt: deps.clock.now() },
                  });
                });
                throw error;
              }
              return file;
            },
            async settle(tx, file) {
              await assertStaff(tx, deps, ctx, staff, "finance.recon.resolve");
              const current = await ready(tx, day);
              if (current.id !== file.id || current.sha1 !== file.sha1)
                throw new AppError("RECON_BILL_NOT_READY");
              await finishDay(tx, deps, ctx, day, current, runKey);
              await record(
                tx,
                ctx.actor,
                {
                  requestId: ctx.requestId,
                  ip: ctx.ip,
                  userAgent: ctx.userAgent,
                  authMethod: null,
                  sessionId: null,
                },
                {
                  stream: "ops",
                  category: "recon",
                  action: "finance.reconciliation.rerun",
                  summary: "按原可信账单重新对账",
                  target: { type: "recon_day", id },
                },
              );
              return dayView(tx, deps, staff, day);
            },
          },
          { idem: options.idem },
        ),
      );
    },
  };
}
export type Reconciliation = ReturnType<typeof createReconciliation>;
export type { ReconciliationDeps } from "./context.js";
