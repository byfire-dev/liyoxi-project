import type { Client, MethodResponse } from "openapi-fetch";
import type { operations, paths } from "@liyoxi/contract/types/admin";
import type { ErrorBody } from "@liyoxi/contract/errors";

import type { QueueActionResult } from "../../../components/QueueWorkbench";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { readQueueSearch, type QueueSearch } from "../../../lib/queue";

type AdminClient = Client<paths>;
export type Approval = ReviewList["items"][number];
export type Detail = MethodResponse<
  AdminClient,
  "get",
  "/api/v1/admin/qualification-submissions/{qualificationSubmissionId}"
>["data"];
export type Doc = Detail["docs"][number];
export type Reason = MethodResponse<
  AdminClient,
  "get",
  "/api/v1/admin/dict-items"
>["data"]["items"][number];
export type ApproveBody =
  operations["admin.qualificationSubmission.approve"]["requestBody"]["content"]["application/json"];
export type RejectBody =
  operations["admin.qualificationSubmission.reject"]["requestBody"]["content"]["application/json"];
export const REVIEW_KEY = ["merchant", "qualification-review"] as const;

export function reviewSearch(raw: Readonly<Record<string, unknown>>): QueueSearch {
  const search = readQueueSearch(raw);
  return {
    ...search,
    tab: search.tab === "done_today" ? "done_today" : "todo",
    q: search.q?.slice(0, 30),
  };
}
export function decisionResult(error?: Pick<ErrorBody, "error" | "message">): QueueActionResult {
  if (!error) return { outcome: "done", message: "资质审核已完成" };
  if (["APPROVAL_NOT_PENDING", "VERSION_CONFLICT", "STATE_NOT_ALLOWED"].includes(error.error))
    return { outcome: "conflict" };
  return { outcome: "failed", message: error.message };
}
export function approveBody(
  detail: { roundNo: Detail["roundNo"]; approval: Pick<Detail["approval"], "lockVersion"> },
  checked: readonly string[],
): ApproveBody {
  return {
    lockVersion: detail.approval.lockVersion,
    mode: "normal",
    confirm: { roundNo: detail.roundNo ?? undefined },
    confirmChecks: [...checked],
  };
}
export function rejectBody(
  detail: { roundNo: Detail["roundNo"]; approval: Pick<Detail["approval"], "lockVersion"> },
  reason: string,
  note: string,
  docIds: readonly string[],
): RejectBody | null {
  const text = note.trim();
  if (!reason || !text || text.length > 200) return null;
  return {
    reasonCodes: [reason],
    note: text,
    rejectedDocIds: [...docIds],
    isFinal: false,
    confirm: { roundNo: detail.roundNo ?? undefined },
  };
}
/** 内容相同的失败重试沿用键；同步锁覆盖按钮禁用前的重复调用。 */
export function createDecisionIntent(newKey = () => newIdempotencyKey("qualification-review")) {
  let running = false,
    fingerprint = "",
    key = "";
  return async <T>(body: unknown, send: (key: string) => Promise<T>): Promise<T | null> => {
    if (running) return null;
    const next = JSON.stringify(body);
    if (next !== fingerprint) {
      fingerprint = next;
      key = newKey();
    }
    running = true;
    try {
      return await send(key);
    } finally {
      running = false;
    }
  };
}

export type ReviewList = MethodResponse<AdminClient, "get", "/api/v1/admin/approvals">["data"];
export type ReviewSummary = MethodResponse<
  AdminClient,
  "get",
  "/api/v1/admin/approvals/summary"
>["data"]["items"][number];
