import { readQueueSearch } from "../../../lib/queue";
import type { ApproveBody, RejectBody, Template, VerifyDetail } from "./api";
export const VERIFY_KEY = ["publish", "link-review"] as const;
export function verifySearch(raw: Readonly<Record<string, unknown>>) {
  const search = readQueueSearch(raw);
  return {
    ...search,
    tab: search.tab === "done_today" ? "done_today" : "todo",
    q: search.q?.slice(0, 30),
  };
}
export function approveBody(
  detail: {
    roundNo: VerifyDetail["roundNo"];
    approval: Pick<VerifyDetail["approval"], "lockVersion" | "confirmChecks">;
    link: Pick<VerifyDetail["link"], "reportedEpisodeCount">;
  },
  count: number | null,
  template: Template | undefined,
  checked: readonly string[],
): ApproveBody | null {
  if (
    !template?.items.length ||
    count === null ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > detail.link.reportedEpisodeCount ||
    template.items.some((item) => !checked.includes(item.key)) ||
    detail.approval.confirmChecks.some((code) => !checked.includes(`confirm:${code}`))
  )
    return null;
  return {
    lockVersion: detail.approval.lockVersion,
    confirm: { roundNo: detail.roundNo, reportedEpisodeCount: detail.link.reportedEpisodeCount },
    confirmChecks: [...detail.approval.confirmChecks],
    verifiedEpisodeCount: count,
    checklistVersionNo: template.versionNo,
    results: template.items.map((item) => ({ key: item.key, result: "pass" })),
  };
}
export function rejectBody(reason: string, note: string): RejectBody | null {
  const text = note.trim();
  return reason && text && text.length <= 200 ? { reasonCodes: [reason], note: text } : null;
}
export function submittedLinks(detail: {
  link: Pick<VerifyDetail["link"], "linkKind" | "collectionUrl" | "episodeUrls">;
}) {
  const safe = (url: string) => {
    try {
      return new URL(url).protocol === "https:";
    } catch {
      return false;
    }
  };
  return detail.link.linkKind === "collection" && detail.link.collectionUrl
    ? [{ label: "合集链接", url: detail.link.collectionUrl, safe: safe(detail.link.collectionUrl) }]
    : detail.link.episodeUrls.map((item) => ({
        label: `第 ${item.episodeNo} 集`,
        url: item.url,
        safe: safe(item.url),
      }));
}
