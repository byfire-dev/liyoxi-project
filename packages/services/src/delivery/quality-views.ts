import { ChecklistItemsSchema } from "@liyoxi/contract";
import type { QcRecord } from "@liyoxi/db";
import type { Tx } from "../kernel/index.js";
import { staffBriefs } from "../staff/index.js";
import { iso } from "./repo.js";
const brief = async (tx: Tx, id: string | null) =>
  id ? ((await staffBriefs(tx, [id]))[0] ?? null) : null;
export async function qcView(tx: Tx, r: QcRecord | null) {
  if (!r) return null;
  const template = await tx.checklistTemplate.findUnique({
    where: { code_versionNo: { code: r.checklistCode, versionNo: r.checklistVersionNo } },
  });
  const defs = template ? ChecklistItemsSchema.parse(template.items) : [],
    results = r.results as Array<{ key: string; result: string; note?: string }>;
  return {
    qcRecordId: r.id,
    targetType: r.targetType,
    targetId: r.targetId,
    checklistCode: r.checklistCode,
    checklistVersionNo: r.checklistVersionNo,
    verdict: r.verdict,
    rejectReason: r.rejectReason,
    items: results.map((i) => ({
      ...i,
      label: defs.find((d) => d.key === i.key)?.label ?? i.key,
      note: i.note ?? null,
      merchantVisible: defs.find((d) => d.key === i.key)?.merchantVisible ?? false,
    })),
    inspectedBy: (await brief(tx, r.inspectedByStaffId))!,
    inspectedAt: iso(r.inspectedAt),
  };
}
