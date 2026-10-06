import { ChecklistItemsSchema } from "@liyoxi/contract";
import type { Prisma } from "@liyoxi/db";
import { AppError, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import type { DeliveryCoreDeps } from "./context.js";
import type { TicketRow } from "./repo.js";
export interface QualityInput {
  checklistVersionNo: number;
  results: Array<{ key: string; result: "pass" | "fail" | "na"; note?: string | null }>;
  rejectReason?: string;
}
export const invalid = (path: string, message: string) =>
  new AppError("VALIDATION_FAILED", { details: { fieldErrors: [{ path, message }] } });
export function unpaused(t: TicketRow) {
  if (t.pauseCount)
    throw new AppError("TICKET_ON_HOLD", {
      details: { reasons: t.deliveryTicketPauses.map((p) => p.reason) },
    });
}
export async function quality(
  tx: Tx,
  code: string,
  input: QualityInput,
  aigcState?: string,
  precheck = false,
) {
  const template = await tx.checklistTemplate.findFirst({ where: { code, status: "active" } });
  if (!template || template.versionNo !== input.checklistVersionNo)
    throw new AppError("CHECKLIST_VERSION_STALE", {
      details: { code, currentVersionNo: template?.versionNo ?? null },
    });
  const defs = ChecklistItemsSchema.parse(template.items);
  // 当前模板的 AI 标识条目按已验证的制作事实预判；缺失/待验证已由 productionReady 拒绝。
  if (aigcState && ["not_required", "verified"].includes(aigcState))
    input = {
      ...input,
      results: input.results.map((r) =>
        r.key === "ai_label"
          ? {
              ...r,
              result:
                aigcState === "not_required" && defs.find((d) => d.key === r.key)?.allowNa
                  ? "na"
                  : "pass",
              note: null,
            }
          : r,
      ),
    };
  const keys = new Set(input.results.map((r) => r.key));
  const missingKeys = defs.filter((i) => !keys.has(i.key)).map((i) => i.key),
    invalidNaKeys = input.results
      .filter((r) => r.result === "na" && !defs.find((i) => i.key === r.key)?.allowNa)
      .map((r) => r.key),
    failedKeys = input.results.filter((r) => r.result === "fail").map((r) => r.key);
  if (
    keys.size !== input.results.length ||
    input.results.some((r) => !defs.some((d) => d.key === r.key))
  )
    throw invalid("results", "清单键重复或不存在");
  if (precheck && (missingKeys.length || invalidNaKeys.length || failedKeys.length))
    throw new AppError("CHECKLIST_NOT_PASSED", {
      details: { missingKeys, invalidNaKeys, failedKeys },
    });
  if (
    missingKeys.length ||
    invalidNaKeys.length ||
    input.results.some((r) => r.result === "fail" && !r.note?.trim())
  )
    throw invalid("results", "清单结论必须完整，不通过须说明，不适用须模板允许");
  if (failedKeys.length && !input.rejectReason?.trim() && !precheck)
    throw invalid("rejectReason", "不通过须填写原因");
  return {
    code,
    versionNo: template.versionNo,
    results: input.results.map((r) => ({ ...r, note: r.note ?? null })),
    verdict: failedKeys.length ? "fail" : "pass",
    rejectReason: failedKeys.length ? (input.rejectReason?.trim() ?? null) : null,
  };
}
export async function insertQuality(
  tx: Tx,
  deps: DeliveryCoreDeps,
  t: TicketRow,
  staffId: string,
  targetType: "sample" | "episode_output" | "delivery_ticket",
  targetId: string,
  q: Awaited<ReturnType<typeof quality>>,
) {
  const now = deps.clock.now();
  return tx.qcRecord.create({
    data: {
      id: uuidv7(),
      entityId: t.entityId,
      storeId: t.storeId,
      deliveryTicketId: t.id,
      targetType,
      targetId,
      checklistCode: q.code,
      checklistVersionNo: q.versionNo,
      results: q.results as Prisma.InputJsonValue,
      verdict: q.verdict,
      rejectReason: q.rejectReason,
      inspectedByStaffId: staffId,
      inspectedAt: now,
      createdAt: now,
    },
  });
}
export async function productionReady(tx: Tx, fileId: string) {
  const p = await tx.productionRecord.findUnique({ where: { fileId } });
  if (!p || p.pipelineState !== "ready" || !["not_required", "verified"].includes(p.aigcState))
    throw new AppError("PRODUCTION_NOT_READY", {
      details: {
        fileId,
        pipelineState: p?.pipelineState ?? "missing",
        gate: p?.pipelineState === "rejected" ? "reject" : null,
      },
    });
  const check = await tx.mediaCheck.findFirst({
    where: { fileId },
    orderBy: { createdAt: "desc" },
  });
  if (check?.gate === "reject")
    throw new AppError("PRODUCTION_NOT_READY", {
      details: { fileId, pipelineState: p.pipelineState, gate: "reject" },
    });
  return p;
}

/** 仅由所属订单项的真实剧目行提供，客户端不能否认此事实。 */
export async function dramaUsesAi(tx: Tx, dramaId: string): Promise<boolean> {
  return (
    await tx.drama.findUniqueOrThrow({
      where: { id: dramaId },
      select: { isAiGenerated: true },
    })
  ).isAiGenerated;
}
