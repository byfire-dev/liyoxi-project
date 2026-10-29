import type { Prisma } from "@liyoxi/db";
import { lockRows } from "../kernel/index.js";
import type { IdempotencyContext, Tx } from "../kernel/index.js";
import { CancelRecheckError } from "./cancel-context.js";
import type { CancelDeps } from "./cancel-context.js";

/** Failed evidence commits only after the complete business transaction has rolled back. */
export async function runCancelUseCase<T>(
  deps: CancelDeps,
  fn: (tx: Tx) => Promise<T>,
  idem?: IdempotencyContext,
): Promise<T> {
  try {
    return await deps.tx.run(fn, idem ? { idem } : {});
  } catch (error) {
    if (error instanceof CancelRecheckError)
      await deps.tx.run(async (tx) => {
        await lockRows(tx, "cancel_request", [error.requestId]);
        const row = await tx.cancelRequest.findUniqueOrThrow({ where: { id: error.requestId } });
        if (row.status !== (error.phase === "execute" ? "pending_execution" : "pending_approval"))
          return;
        const prior =
          typeof row.recheckLog === "object" &&
          row.recheckLog !== null &&
          !Array.isArray(row.recheckLog)
            ? row.recheckLog
            : {};
        await tx.cancelRequest.update({
          where: { id: row.id },
          data: {
            recheckLog: { ...prior, [error.phase]: error.entry } as Prisma.InputJsonValue,
          },
        });
      });
    throw error;
  }
}
