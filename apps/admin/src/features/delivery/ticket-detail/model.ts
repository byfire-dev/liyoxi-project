import type { DraftBody, Plan, QcBody, Template } from "./api";
import { createAssignmentIntent } from "../tickets/model";
export const DETAIL_KEY = ["delivery", "ticket-detail"] as const;
export const createWriteIntent = createAssignmentIntent;
export function historyTicketId(state: unknown, ticketNo: string): string | undefined {
  if (typeof state !== "object" || state === null || !("lyxTicket" in state)) return undefined;
  const entry = state.lyxTicket;
  if (
    typeof entry !== "object" ||
    entry === null ||
    !("ticketNo" in entry) ||
    entry.ticketNo !== ticketNo ||
    !("ticketId" in entry) ||
    typeof entry.ticketId !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(entry.ticketId)
  )
    return undefined;
  return entry.ticketId;
}
export function planInput(plan: Plan): DraftBody["content"] {
  return {
    focusCodes: plan.draft.focus.map((r) => r.code),
    referenceAssetIds: plan.draft.referenceAssets.map((r) => r.storeAssetId),
    note: plan.draft.note,
    launchMode: "merchant_self",
    items: plan.draft.items.map((r) => ({
      orderItemId: r.orderItemId,
      channelAccountIds: r.accounts.map((a) => a.channelAccountId),
      placements: r.placements.map(({ slot, adId }) => ({ slot, adId })),
      agreedLaunchDate: r.agreedLaunchDate,
      expectedDeliveryDate: r.expectedDeliveryDate,
    })),
  };
}
export const firstEpisode = (name: string): number | undefined => {
  const number = name.replace(/\.[^/.]+$/, "").match(/\d{1,3}/)?.[0];
  return number ? Number(number) : undefined;
};
export function episodeProblem(
  rows: readonly { episodeNo?: number; fileId: string | null }[],
  total: number,
): string | null {
  if (!rows.length || rows.some((r) => !r.fileId)) return "请等待所有文件上传完成";
  if (
    rows.some(
      (r) =>
        !r.episodeNo || r.episodeNo < 1 || r.episodeNo > total || !Number.isInteger(r.episodeNo),
    )
  )
    return "集号须为范围内的整数";
  if (new Set(rows.map((r) => r.episodeNo)).size !== rows.length) return "集号重复，请修改";
  return null;
}
export function qualityProblem(
  template: Template,
  results: QcBody["results"],
  reason: string,
): string | null {
  if (
    results.length !== template.items.length ||
    template.items.some((i) => !results.some((r) => r.key === i.key))
  )
    return "请逐项选择质检结论";
  if (
    results.some((r) => r.result === "na" && !template.items.find((i) => i.key === r.key)?.allowNa)
  )
    return "该清单项不允许不适用";
  if (results.some((r) => r.result === "fail" && !r.note?.trim())) return "每项不通过都须说明";
  if (results.some((r) => r.result === "fail") && !reason.trim()) return "请填写不通过原因";
  return null;
}
