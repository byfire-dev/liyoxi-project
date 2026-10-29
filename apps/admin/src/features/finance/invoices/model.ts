import {
  InvoiceIssueBodySchema,
  InvoiceIssueRedBodySchema,
  InvoiceRejectBodySchema,
} from "@liyoxi/contract";
import type { QueryClient } from "@tanstack/react-query";
import { newIdempotencyKey } from "../../../lib/idempotency";
import { canAction, hasModuleLevel, type AccessSnapshot } from "../../../lib/permissions";
import { readTableSearch } from "../../../lib/table-search";
import { choice, idValue, keyword } from "../payments/model";
import type { InvoiceAction, InvoiceCommand, InvoiceDetail, InvoiceDraft } from "./types";

export const invoiceTabs = {
  pending: "待开票",
  red_pending: "待红冲",
  processed: "已处理",
} as const;
export const invoiceTypes = { normal: "普通发票", special: "增值税专用发票" } as const;
export const invoiceMedia = { electronic: "电子", paper: "纸质" } as const;
export const invoiceActions = {
  issue: "开具发票",
  "issue-red": "回填红字发票",
  reject: "驳回申请",
  resend: "重发邮件",
} as const;
export const invoiceStatuses: Readonly<Record<string, string>> = {
  pending: "待开票",
  issued: "已开具",
  rejected: "已驳回",
  red_pending: "待红冲",
  red_issued: "已红冲",
};
export const emailStates: Readonly<Record<string, string>> = {
  none: "无需邮件",
  queued: "邮件待发送",
  sent: "邮件已受理",
  failed: "邮件发送失败",
  skipped: "邮件未配置，已跳过",
};
export function invoiceSearch(raw: Record<string, unknown>) {
  const paging = readTableSearch(raw);
  return {
    page: paging.page,
    pageSize: paging.pageSize,
    q: keyword(raw.q),
    tab: choice(raw.tab, ["pending", "red_pending", "processed"] as const) ?? "pending",
    invoiceType: choice(raw.invoiceType, ["normal", "special"] as const),
    medium: choice(raw.medium, ["electronic", "paper"] as const),
    id: idValue(raw.id),
  };
}
export const invoiceFilters = (search: ReturnType<typeof invoiceSearch>) => ({
  q: search.q,
  invoiceType: search.invoiceType,
  medium: search.medium,
});
export const invoiceTable = (search: ReturnType<typeof invoiceSearch>) =>
  readTableSearch(search, ["invoiceType", "medium"]);
export const invoiceStamp = (row: InvoiceDetail) => JSON.stringify(row);
export const emptyInvoiceDraft = (): InvoiceDraft => ({
  invoiceNo: "",
  invoiceCode: "",
  fileId: null,
  expressCompanyCode: "",
  trackingNo: "",
  reasonCode: "",
  note: "",
});
export function allowedInvoiceActions(
  row: InvoiceDetail,
  access: AccessSnapshot | null,
): InvoiceAction[] {
  if (!hasModuleLevel(access, "finance")) return [];
  return (["issue", "issue-red", "reject", "resend"] as const).filter(
    (action) =>
      row.actions.includes(action) &&
      canAction(access, action === "issue-red" ? "finance.invoice.red" : "finance.invoice.issue"),
  );
}
export function invoiceCommand(
  row: InvoiceDetail,
  action: InvoiceAction,
  draft: InvoiceDraft,
): InvoiceCommand {
  if (action === "resend") return { action };
  if (action === "reject")
    return {
      action,
      body: InvoiceRejectBodySchema.parse({ reasonCode: draft.reasonCode, note: draft.note }),
    };
  const numbers = {
    invoiceNo: draft.invoiceNo.trim(),
    ...(draft.invoiceCode.trim() ? { invoiceCode: draft.invoiceCode.trim() } : {}),
  };
  if (
    (row.medium === "electronic" && !/^\d{20}$/.test(numbers.invoiceNo)) ||
    (numbers.invoiceNo.length === 8 && !draft.invoiceCode.trim())
  )
    throw new Error("票号或代码不完整");
  if (action === "issue-red") {
    const blue = row.docs.find((doc) => doc.docKind === "blue");
    if (!blue || !draft.fileId) throw new Error("请核对蓝票并上传红字发票文件");
    return {
      action,
      body: InvoiceIssueRedBodySchema.parse({
        ...numbers,
        fileId: draft.fileId,
        redReason: draft.note,
        confirm: {
          requestNo: row.requestNo,
          blueInvoiceNo: blue.invoiceNo,
          amountFen: row.amountFen,
        },
      }),
    };
  }
  if (!row.prechecks.every((check) => check.passed) || row.isHeldByRefund)
    throw new Error("开具条件未满足");
  if (row.medium === "electronic" && !draft.fileId) throw new Error("请上传电子发票文件");
  if (row.medium === "paper" && (!draft.expressCompanyCode || !draft.trackingNo.trim()))
    throw new Error("请填写寄送信息");
  return {
    action,
    body: InvoiceIssueBodySchema.parse({
      ...numbers,
      ...(row.medium === "electronic"
        ? { fileId: draft.fileId }
        : { expressCompanyCode: draft.expressCompanyCode, trackingNo: draft.trackingNo }),
      confirm: { requestNo: row.requestNo, amountFen: row.amountFen },
    }),
  };
}
/** 取消精确旧GET后发布；切主体、记录或权限scope会取消并丢弃迟到结果。 */
export async function refreshInvoiceDetail(
  cache: QueryClient,
  key: readonly unknown[],
  signal: AbortSignal,
  read: (signal: AbortSignal) => Promise<InvoiceDetail>,
) {
  signal.throwIfAborted();
  await cache.cancelQueries({ queryKey: key, exact: true });
  signal.throwIfAborted();
  const row = await read(signal);
  signal.throwIfAborted();
  cache.setQueryData(key, row);
  return row;
}
/** 仅本域四个意图；网络未知同正文保留key，同步闩及generation隔离迟到结果。 */
export function createInvoiceIntent(makeKey = () => newIdempotencyKey("invoice")) {
  const keys = new Map<InvoiceAction, { signature: string; key: string }>();
  let busy = false,
    active = true,
    generation = 0,
    controller = new AbortController();
  return {
    get pending() {
      return busy;
    },
    activate() {
      if (!active) {
        active = true;
        controller = new AbortController();
      }
    },
    close() {
      active = false;
      generation++;
      busy = false;
      controller.abort();
    },
    async submit<T>(
      action: InvoiceAction,
      fingerprint: unknown,
      send: (key: string, signal: AbortSignal) => Promise<T>,
    ) {
      if (!active || busy) return undefined;
      const signature = JSON.stringify(fingerprint),
        old = keys.get(action),
        intent = old?.signature === signature ? old : { signature, key: makeKey() };
      keys.set(action, intent);
      busy = true;
      const own = generation,
        signal = controller.signal;
      try {
        const result = await send(intent.key, signal);
        if (!active || signal.aborted || own !== generation) return undefined;
        keys.delete(action);
        return result;
      } catch (error) {
        if (active && !signal.aborted && own === generation) throw error;
        return undefined;
      } finally {
        if (own === generation) busy = false;
      }
    },
  };
}
