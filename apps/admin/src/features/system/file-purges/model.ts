import {
  AdminFileListQuerySchema,
  FileEraseBodySchema,
  FileRestoreBodySchema,
  PurgeApproveBodySchema,
  PurgeRejectBodySchema,
  PurgeRunListQuerySchema,
} from "@liyoxi/contract";
import { readContractQuery } from "../../../lib/contract-query";
import { canAction, hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import { readTableSearch } from "../../../lib/table-search";
import type { FileQuery, FileView, RunQuery, RunView } from "./api";
export const PURGE_KEY = ["system", "file-purges"] as const;
export const PURGE_TABS = [
  { key: "runs", label: "清除运行" },
  { key: "files", label: "已清除文件" },
] as const;
export type PurgeSearch = Record<string, string>;
export const FILE_KEYS = [
  "status",
  "category",
  "scopeType",
  "entityId",
  "storeId",
  "uploadActorType",
  "uploadActorId",
  "purgeRunId",
  "fileIds",
  "q",
  "deletedFrom",
  "deletedTo",
  "sort",
  "page",
  "pageSize",
] as const;
export function purgeSearch(raw: Readonly<Record<string, unknown>>): PurgeSearch {
  const tab = raw.tab === "files" ? "files" : "runs",
    candidate = { ...raw };
  if (![10, 20, 50].includes(Number(candidate.pageSize))) delete candidate.pageSize;
  if (![10, 20, 50].includes(Number(candidate.filePageSize))) delete candidate.filePageSize;
  if (
    typeof candidate.deletedFrom === "string" &&
    typeof candidate.deletedTo === "string" &&
    candidate.deletedFrom > candidate.deletedTo
  ) {
    delete candidate.deletedFrom;
    delete candidate.deletedTo;
  }
  const files = readContractQuery(
    AdminFileListQuerySchema,
    tab === "runs"
      ? { ...candidate, page: candidate.filePage, pageSize: candidate.filePageSize }
      : candidate,
    {
      keys: FILE_KEYS,
      defaults: {
        page: "1",
        pageSize: "20",
        sort: "-deletedAt",
        ...(tab === "files" ? { status: "deleted" } : {}),
      },
      keywordLimit: 200,
    },
  ).wire;
  if (tab === "files") return { tab, ...files };
  const runs = readContractQuery(PurgeRunListQuerySchema, candidate, {
    keys: ["state", "page", "pageSize"],
    defaults: { state: "proposed,held", page: "1", pageSize: "20" },
  }).wire;
  const { page, pageSize, ...filters } = files;
  return { tab, ...filters, ...runs, filePage: page!, filePageSize: pageSize! };
}
export function runQuery(search: PurgeSearch): RunQuery {
  const wire = purgeSearch({ ...search, tab: "runs" });
  return { state: wire.state, page: Number(wire.page), pageSize: Number(wire.pageSize) };
}
export function fileQuery(search: PurgeSearch): FileQuery {
  const wire = purgeSearch(search),
    { tab: _tab, state: _state, filePage, filePageSize, page, pageSize, ...filters } = wire;
  void _tab;
  void _state;
  return {
    ...filters,
    page: Number(wire.tab === "runs" ? filePage : page),
    pageSize: Number(wire.tab === "runs" ? filePageSize : pageSize),
  };
}
export function fileTableSearch(search: PurgeSearch) {
  return readTableSearch(fileQuery(search));
}
export function purgeActorKey(access: AccessSnapshot | null): string {
  return access
    ? JSON.stringify([
        access.staff.id,
        access.moduleLevels.system,
        access.actions,
        access.dataScope,
      ])
    : "anonymous";
}
export type PurgeAction =
  { kind: "approve" | "reject"; row: RunView } | { kind: "restore" | "erase"; row: FileView };
export function purgeActionAllowed(access: AccessSnapshot | null, action: PurgeAction): boolean {
  if (!hasModuleLevel(access, "system")) return false;
  if (action.kind === "approve" || action.kind === "reject")
    return canAction(access, "files.purge.approve") && action.row.actions.includes(action.kind);
  if (!canAction(access, `files.${action.kind}`) || !action.row.actions.includes(action.kind))
    return false;
  return action.kind === "restore"
    ? action.row.status === "deleted" && !action.row.erasedAt && Boolean(action.row.restorableUntil)
    : !action.row.erasedAt;
}
export function purgeBody(action: PurgeAction, text: string) {
  const reason = text.trim();
  if (action.kind === "approve")
    return PurgeApproveBodySchema.parse({
      confirm: {
        candidateCount: action.row.candidateCount,
        candidateBytes: action.row.candidateBytes,
      },
      ...(reason ? { note: reason } : {}),
    });
  if (action.kind === "reject") return PurgeRejectBodySchema.parse({ reason });
  if (action.kind === "restore") return FileRestoreBodySchema.parse({ reason });
  return FileEraseBodySchema.parse({
    reason,
    confirm: { fileId: action.row.fileId, category: action.row.category },
  });
}
export function byteCount(value: string | null): string {
  return value !== null && /^\d+$/.test(value)
    ? `${BigInt(value).toLocaleString("zh-CN")} 字节`
    : "—";
}
export const runLabels: Readonly<Record<string, string>> = {
  proposed: "待放行",
  held: "已熔断",
  approved: "已放行 · 待执行",
  running: "执行中",
  done: "执行完成",
  aborted: "已中止",
  rejected: "已驳回",
};
export const fileLabels: Readonly<Record<string, string>> = {
  pending: "待上传",
  promoting: "入库中",
  stored: "已入库",
  rejected: "已拒收",
  expired: "已过期",
  deleting: "删除处理中",
  deleted: "已清除",
};
export function textLabel(labels: Readonly<Record<string, string>>, value: string) {
  return Object.hasOwn(labels, value) ? labels[value]! : "未识别状态";
}
export function safePurgeText(value: string | null | undefined, max = 160) {
  return value
    ? Array.from(value)
        .map((one) => (one.charCodeAt(0) < 32 || one.charCodeAt(0) === 127 ? " " : one))
        .slice(0, max)
        .join("")
    : "—";
}
export function referenceSummaries(details: unknown): { refType: string; refId: string }[] {
  if (
    !details ||
    typeof details !== "object" ||
    !("refs" in details) ||
    !Array.isArray(details.refs)
  )
    return [];
  return details.refs
    .slice(0, 20)
    .flatMap((ref: unknown) =>
      ref &&
      typeof ref === "object" &&
      "refType" in ref &&
      "refId" in ref &&
      typeof ref.refType === "string" &&
      /^[a-z_]{1,64}$/.test(ref.refType) &&
      typeof ref.refId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref.refId)
        ? [{ refType: ref.refType, refId: ref.refId }]
        : [],
    );
}
