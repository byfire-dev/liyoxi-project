import type { FileObject } from "@liyoxi/db";
import { assertConfirm } from "../../authz/index.js";
import { FileEraseBodySchema, FileRestoreBodySchema } from "@liyoxi/contract";
import {
  AppError,
  createThreePhaseRunner,
  lockRows,
  SessionMutexError,
} from "../../kernel/index.js";
import type { IdempotencyContext, SessionMutexScope, Tx } from "../../kernel/index.js";
import type { ObjectRef, ProviderResult } from "../../providers/types.js";
import { retentionFileView } from "./view.js";
import { inStaffScope } from "../access.js";
import { currentStaff, audit } from "./auth.js";
import { afterPurged } from "./hooks.js";
import { fileMutexKey } from "./types.js";
import type { RetentionActor, RetentionDeps } from "./types.js";
import { assertErasable } from "./erase-guard.js";

const object = (file: FileObject): ObjectRef => ({
  bucket: file.bucket as ObjectRef["bucket"],
  key: file.objectKey,
});
class StorageActionUnknown extends Error {}
function provider(result: ProviderResult<void>, restore = false, deletedAt?: string): void {
  if (!result.ok) {
    if (restore && result.reason === "rejected")
      throw new AppError("FILE_RESTORE_WINDOW_PASSED", { details: { deletedAt } });
    throw new StorageActionUnknown("存储操作未取得可验证结果");
  }
}
async function fileIn(
  deps: RetentionDeps,
  tx: Tx,
  actor: RetentionActor,
  id: string,
  erase: boolean,
) {
  const staff = await currentStaff(deps, tx, actor, erase ? "files.erase" : "files.restore", true);
  await lockRows(tx, "file_object", [id]);
  const file = await tx.fileObject.findFirst({ where: { id, AND: [inStaffScope(staff)] } });
  if (!file) throw new AppError("NOT_FOUND");
  return { file, staff };
}
function restoreGuard(file: FileObject, now: Date) {
  if (file.status !== "deleted" || file.erasedAt) throw new AppError("STATE_NOT_ALLOWED");
  if (!file.deletedAt) throw new TypeError("deleted文件缺少删除时间");
  if (now.getTime() > file.deletedAt.getTime() + (file.bucket === "secure" ? 90 : 30) * 86_400_000)
    throw new AppError("FILE_RESTORE_WINDOW_PASSED", {
      details: { deletedAt: file.deletedAt.toISOString() },
    });
}
/** 恢复失败的补偿在新互斥作用域执行，先读最终DB状态，绝不撤销已提交或后继成功恢复。 */
async function replaceMarker(deps: RetentionDeps, id: string, ref: ObjectRef) {
  const retention = deps.retention!;
  await retention.sessionMutex.run(fileMutexKey(id), async (scope) => {
    const needsMarker = await deps.tx.run(async (tx) => {
      await lockRows(tx, "file_object", [id]);
      const file = await tx.fileObject.findUnique({ where: { id } });
      return file?.status === "deleted" && !file.erasedAt;
    });
    if (needsMarker) {
      await scope.assertHeld();
      provider(await deps.storage.delete({ ...ref, signal: scope.signal }));
    }
  });
}
export function createFileActions(deps: RetentionDeps) {
  const phases = createThreePhaseRunner(deps);
  async function run(
    actor: RetentionActor,
    id: string,
    body: { reason: string; confirm?: { fileId: string; category: string } },
    input: { idem?: IdempotencyContext },
    erase: boolean,
  ) {
    if (input.idem?.mode !== "required") throw new AppError("INTERNAL");
    if (!deps.retention) throw new AppError("PROVIDER_UNAVAILABLE");
    await deps.tx.run(async (tx) => {
      const fresh = await currentStaff(deps, tx, actor, erase ? "files.erase" : "files.restore");
      if (
        !(await tx.fileObject.findFirst({
          where: { id, AND: [inStaffScope(fresh)] },
          select: { id: true },
        }))
      )
        throw new AppError("NOT_FOUND");
    });
    const parsed = (erase ? FileEraseBodySchema : FileRestoreBodySchema).safeParse(body);
    if (!parsed.success) throw new AppError("VALIDATION_FAILED");
    body = parsed.data;
    let restored: ObjectRef | undefined,
      external: Promise<ProviderResult<void>> | undefined,
      deletedAt: string | undefined;
    try {
      return await deps.retention.sessionMutex.run(
        fileMutexKey(id),
        async (scope: SessionMutexScope) =>
          phases.run(
            {
              claim: async (tx, { resumed }) => {
                const { file } = await fileIn(deps, tx, actor, id, erase);
                deletedAt = file.deletedAt?.toISOString();
                if (!erase) restoreGuard(file, deps.clock.now());
                else {
                  if (
                    file.erasedAt ||
                    !["stored", "deleted", ...(resumed ? ["deleting"] : [])].includes(file.status)
                  )
                    throw new AppError("STATE_NOT_ALLOWED");
                  assertConfirm(body.confirm, { fileId: id, category: file.category });
                  await assertErasable(deps, tx, id);
                  if (file.status === "stored")
                    await tx.fileObject.update({
                      where: { id },
                      data: { status: "deleting", updatedAt: deps.clock.now() },
                    });
                }
                return object(file);
              },
              external: async (ref) => {
                await scope.assertHeld();
                // 操作可能已移除marker而应答/HEAD未知；在开始前记录补偿目标。
                if (!erase) restored = ref;
                external = erase
                  ? deps.storage.eraseVersions({ ...ref, signal: scope.signal })
                  : deps.storage.restoreVersions({ ...ref, signal: scope.signal });
                provider(await external, !erase, deletedAt);
                await scope.assertHeld();
              },
              settle: async (tx) => {
                const { file, staff } = await fileIn(deps, tx, actor, id, erase);
                const now = deps.clock.now();
                if (!erase) restoreGuard(file, now);
                else {
                  if (!["deleting", "deleted"].includes(file.status) || file.erasedAt)
                    throw new AppError("STATE_NOT_ALLOWED");
                  await assertErasable(deps, tx, id);
                  assertConfirm(body.confirm, { fileId: id, category: file.category });
                }
                const updated = await tx.fileObject.update({
                  where: { id },
                  data: erase
                    ? {
                        status: "deleted",
                        deletedAt: file.deletedAt ?? now,
                        erasedAt: now,
                        originalName: null,
                        updatedAt: now,
                      }
                    : { status: "stored", deletedAt: null, purgeAfter: null, updatedAt: now },
                });
                await audit(
                  tx,
                  actor,
                  erase ? "files.file.erase" : "files.file.restore",
                  id,
                  body.reason,
                );
                return retentionFileView(tx, { ...actor, staff }, updated, now);
              },
            },
            input,
          ),
      );
    } catch (error) {
      await external?.catch(() => undefined);
      if (restored)
        await replaceMarker(deps, id, restored).catch(async () => {
          await deps.retention!.alerts.raise({
            rule: "purge.restore_compensation",
            dimension: id,
            severity: "P1",
            detail: { fileId: id },
          });
        });
      if (error instanceof SessionMutexError && ["occupied", "capacity"].includes(error.reason))
        return phases.run(
          {
            // 正式C49先判同键处理中/完成/改体；新键claim拒绝整TX回滚，无外呼和残留占位。
            claim: async () => {
              throw new AppError("STATE_NOT_ALLOWED", { cause: error });
            },
            external: async () => {
              throw new TypeError("互斥拒绝后不能外呼");
            },
            settle: async () => {
              throw new TypeError("互斥拒绝后不能落结果");
            },
          },
          input,
        );
      if (error instanceof StorageActionUnknown)
        throw new AppError("PROVIDER_UNAVAILABLE", { cause: error });
      throw error;
    }
  }
  return {
    restore: (
      actor: RetentionActor,
      id: string,
      body: { reason: string },
      input: { idem?: IdempotencyContext } = {},
    ) => run(actor, id, body, input, false),
    erase: async (
      actor: RetentionActor,
      id: string,
      body: { reason: string; confirm: { fileId: string; category: string } },
      input: { idem?: IdempotencyContext } = {},
    ) => {
      const result = await run(actor, id, body, input, true);
      await afterPurged(deps, id);
      return result;
    },
  };
}
