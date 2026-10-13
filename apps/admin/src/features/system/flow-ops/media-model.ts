import { MediaJobListQuerySchema } from "@liyoxi/contract/queries/admin";
import { statusToneByEnum } from "@liyoxi/shared/design/status-tone";
import { readContractQuery } from "../../../lib/contract-query";
import { canAction, hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import type { MediaQuery, MediaView } from "./api";
export const MEDIA_FILTER_KEYS = [
  "state",
  "kind",
  "subjectType",
  "subjectId",
  "parentType",
  "parentId",
  "createdFrom",
  "createdTo",
  "sort",
  "page",
  "pageSize",
] as const;
export function mediaSearch(raw: Readonly<Record<string, unknown>>): Record<string, string> {
  const candidate = { ...raw };
  if (![10, 20, 50].includes(Number(candidate.pageSize))) delete candidate.pageSize;
  if (
    typeof candidate.createdFrom === "string" &&
    typeof candidate.createdTo === "string" &&
    candidate.createdFrom > candidate.createdTo
  ) {
    delete candidate.createdFrom;
    delete candidate.createdTo;
  }
  return {
    tab: "media",
    ...readContractQuery(MediaJobListQuerySchema, candidate, {
      keys: MEDIA_FILTER_KEYS,
      defaults: { state: "failed", page: "1", pageSize: "20", sort: "-finishedAt" },
      recover: {
        subjectType: ["subjectType", "subjectId"],
        subjectId: ["subjectType", "subjectId"],
        parentType: ["parentType", "parentId"],
        parentId: ["parentType", "parentId"],
        createdFrom: ["createdFrom", "createdTo"],
        createdTo: ["createdFrom", "createdTo"],
      },
    }).wire,
  };
}
export function mediaQuery(raw: Readonly<Record<string, unknown>>): MediaQuery {
  const { tab: _tab, page, pageSize, ...wire } = mediaSearch(raw);
  void _tab;
  return { ...wire, page: Number(page), pageSize: Number(pageSize) };
}
export const canReadMedia = (access: AccessSnapshot | null) => hasModuleLevel(access, "system");
export const canRetryMedia = (access: AccessSnapshot | null, row: MediaView) =>
  canReadMedia(access) &&
  canAction(access, "media.job.retry") &&
  row.state === "failed" &&
  row.actions.includes("retry");
export const mediaStateLabel = (state: string) =>
  statusToneByEnum("media_job.state", state)?.admin?.label ?? "未识别状态";
