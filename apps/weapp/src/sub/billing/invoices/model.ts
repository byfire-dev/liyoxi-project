import { ApiError } from "@/lib/request";
import type {
  InvoiceApi,
  InvoiceBody,
  Invoice,
  Payment,
  InvoiceContext,
  SignedInvoice,
} from "./api";
export interface InvoiceDraft {
  invoiceType: "normal" | "special";
  medium: "electronic" | "paper";
  addrTel: string;
  bankAccount: string;
  recvEmail: string;
  recipientName: string;
  phoneSource: "login" | "store_contact" | "input";
  phone: string;
  address: string;
}
export const emptyDraft = (): InvoiceDraft => ({
  invoiceType: "normal",
  medium: "electronic",
  addrTel: "",
  bankAccount: "",
  recvEmail: "",
  recipientName: "",
  phoneSource: "login",
  phone: "",
  address: "",
});
export function invoiceBody(payment: Payment, draft: InvoiceDraft): InvoiceBody {
  if (!payment.actions.includes("submit-invoice")) throw new Error("FORM_PAYMENT");
  if (draft.invoiceType === "normal" && draft.medium !== "electronic")
    throw new Error("FORM_MEDIUM");
  const special = draft.invoiceType === "special";
  if (special && (!draft.addrTel.trim() || !draft.bankAccount.trim()))
    throw new Error("FORM_SPECIAL");
  if (draft.medium === "electronic" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.recvEmail.trim()))
    throw new Error("FORM_EMAIL");
  if (
    draft.medium === "paper" &&
    (!draft.recipientName.trim() ||
      draft.address.trim().length < 5 ||
      (draft.phoneSource === "input" && !/^(?:1\d{10}|0\d{2,3}-?\d{7,8})$/.test(draft.phone)))
  )
    throw new Error("FORM_ADDRESS");
  return {
    paymentOrderId: payment.paymentOrderId,
    invoiceType: draft.invoiceType,
    medium: draft.medium,
    ...(special ? { addrTel: draft.addrTel.trim(), bankAccount: draft.bankAccount.trim() } : {}),
    ...(draft.medium === "electronic"
      ? { recvEmail: draft.recvEmail.trim() }
      : {
          mailTo: {
            recipientName: draft.recipientName.trim(),
            phoneSource: draft.phoneSource,
            ...(draft.phoneSource === "input" ? { phone: draft.phone } : {}),
            address: draft.address.trim(),
          },
        }),
  };
}
const errors: Readonly<Record<string, string>> = {
  FORM_PAYMENT: "该付款单当前不可申请，请刷新后重试",
  FORM_MEDIUM: "普通发票仅支持电子发票",
  FORM_SPECIAL: "请填写地址电话与开户行账号",
  FORM_EMAIL: "请填写正确的接收邮箱",
  FORM_ADDRESS: "请补全收件人、电话与邮寄地址",
  INVOICE_REQUEST_EXISTS: "该付款单已申请开票，请刷新记录",
  INVOICE_APPLY_EXPIRED: "已超过开票申请期限",
  ENTITY_NOT_VERIFIED: "请先完成主体认证",
  INVOICE_FILE_UNAVAILABLE: "发票文件暂不可用，请稍后重试",
  ROLE_FORBIDDEN: "仅老板可管理发票",
  PERMISSION_DENIED: "当前账号无权执行此操作",
  FILE_NOT_USABLE: "文件暂不可用，请稍后重试",
  PRECONDITION_CHANGED: "开票条件已变化，请刷新后重试",
  DOCUMENT_UNSUPPORTED: "此设备暂不支持该文件格式，请使用支持该格式的软件查看",
};
export function invoiceError(failure: unknown) {
  const key =
    failure instanceof ApiError ? failure.error : failure instanceof Error ? failure.message : "";
  return Object.hasOwn(errors, key) ? errors[key] : "操作未完成，请重试";
}
export function invoiceStateLabel(status: string) {
  const labels: Readonly<Record<string, string>> = {
    pending: "开票中",
    issued: "已开具",
    rejected: "已驳回",
    red_pending: "红冲中",
    red_issued: "已红冲",
  };
  return Object.hasOwn(labels, status) ? labels[status] : "状态待更新";
}
export function mailLabel(state: string) {
  const labels: Readonly<Record<string, string>> = {
    none: "",
    queued: "邮件待处理",
    sent: "邮件已受理",
    failed: "邮件发送失败，可在此下载",
    skipped: "邮件未发送，可在此下载",
  };
  return Object.hasOwn(labels, state) ? labels[state] : "邮件状态待更新";
}
export interface InvoiceFiles {
  download(url: string, signal: AbortSignal): Promise<{ statusCode: number; tempFilePath: string }>;
  open(path: string, format: SignedInvoice["fileFormat"], name: string): Promise<void>;
  remove(path: string): Promise<void>;
}
export function createInvoiceModel(deps: {
  api: InvoiceApi;
  prepare(): Promise<void>;
  context(): string;
  role(): string | null;
  key(): string;
  files: InvoiceFiles;
}) {
  const initial = () => ({
    loading: false,
    restricted: false,
    error: null as string | null,
    payments: [] as Payment[],
    records: [] as Invoice[],
    eligibleCount: 0,
    recordCount: 0,
    context: null as InvoiceContext | null,
    paymentCursor: null as string | null,
    recordCursor: null as string | null,
    paymentsMore: false,
    recordsMore: false,
    moreBusy: false,
    form: null as Payment | null,
    draft: emptyDraft(),
    busy: false,
    fileBusy: null as string | null,
    receipt: null as { id: string; no: string } | null,
  });
  let state = initial(),
    active = true,
    live = true,
    epoch = 0,
    read = 0,
    at = "",
    owner: object | null = null;
  let intent: { body: string; key: string } | null = null;
  let download: AbortController | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  const current = (context: string, generation: number) =>
    live && active && generation === epoch && context === deps.context();
  const invalidate = () => {
    epoch++;
    read++;
    owner = null;
    intent = null;
    download?.abort();
    download = null;
    publish(initial());
  };
  async function load() {
    const sequence = ++read,
      generation = epoch;
    publish({ loading: true, error: null });
    try {
      await deps.prepare();
      if (!live || !active || sequence !== read || generation !== epoch) return;
      const context = deps.context();
      if (context !== at) {
        at = context;
        publish({ ...initial(), loading: true });
        intent = null;
        owner = null;
      }
      if (deps.role() !== "owner") {
        publish({ ...initial(), restricted: true });
        return;
      }
      const [payments, count, records, summary] = await Promise.all([
        deps.api.payments(),
        deps.api.paymentSummary(),
        deps.api.invoices(),
        deps.api.summary(),
      ]);
      if (!current(context, generation) || sequence !== read) return;
      publish({
        payments: payments.items,
        records: records.items,
        eligibleCount: count.total,
        recordCount: summary.total,
        context: summary.context,
        paymentCursor: payments.nextCursor,
        recordCursor: records.nextCursor,
        paymentsMore: payments.hasMore,
        recordsMore: records.hasMore,
        moreBusy: false,
      });
    } catch (failure) {
      if (
        live &&
        active &&
        sequence === read &&
        generation === epoch &&
        (!at || at === deps.context())
      )
        publish({ error: invoiceError(failure) });
    } finally {
      if (
        live &&
        active &&
        sequence === read &&
        generation === epoch &&
        (!at || at === deps.context())
      )
        publish({ loading: false });
    }
  }
  return {
    snapshot: () => state,
    isActive: () => live && active,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    activate() {
      live = true;
      active = true;
    },
    suspend() {
      active = false;
      invalidate();
    },
    dispose() {
      live = false;
      active = false;
      invalidate();
    },
    load,
    async more(tab: "todo" | "records") {
      if (!live || !active || state.moreBusy || deps.role() !== "owner") return;
      const context = deps.context(),
        generation = epoch,
        sequence = read;
      const cursor = tab === "todo" ? state.paymentCursor : state.recordCursor;
      if (!cursor) return;
      publish({ moreBusy: true });
      try {
        if (tab === "todo") {
          const page = await deps.api.payments(cursor);
          if (current(context, generation) && sequence === read)
            publish({
              payments: [
                ...state.payments,
                ...page.items.filter(
                  (p) => !state.payments.some((x) => x.paymentOrderId === p.paymentOrderId),
                ),
              ],
              paymentCursor: page.nextCursor,
              paymentsMore: page.hasMore,
            });
        } else {
          const page = await deps.api.invoices(cursor);
          if (current(context, generation) && sequence === read)
            publish({
              records: [
                ...state.records,
                ...page.items.filter(
                  (p) => !state.records.some((x) => x.invoiceRequestId === p.invoiceRequestId),
                ),
              ],
              recordCursor: page.nextCursor,
              recordsMore: page.hasMore,
            });
        }
      } catch (failure) {
        if (current(context, generation) && sequence === read)
          publish({ error: invoiceError(failure) });
      } finally {
        if (current(context, generation) && sequence === read) publish({ moreBusy: false });
      }
    },
    open(payment: Payment) {
      if (
        !active ||
        !live ||
        deps.role() !== "owner" ||
        !payment.actions.includes("submit-invoice") ||
        !state.context?.invoiceTitle.isVerified
      )
        return;
      intent = null;
      publish({
        form: payment,
        error: null,
        draft: {
          ...emptyDraft(),
          addrTel: state.context.applyDefaults.addrTel ?? "",
          recipientName: state.context.applyDefaults.recipientName ?? "",
          address: state.context.applyDefaults.address ?? "",
        },
      });
    },
    edit(patch: Partial<InvoiceDraft>) {
      if (!state.busy) publish({ draft: { ...state.draft, ...patch } });
    },
    closeForm() {
      if (!state.busy) {
        intent = null;
        publish({ form: null, draft: emptyDraft(), error: null });
      }
    },
    async submit() {
      if (!active || !live || owner || !state.form || deps.role() !== "owner") return;
      const context = deps.context(),
        generation = epoch,
        ticket = {};
      let body: InvoiceBody;
      try {
        body = invoiceBody(state.form, state.draft);
      } catch (failure) {
        publish({ error: invoiceError(failure) });
        return;
      }
      const fingerprint = JSON.stringify(body);
      if (intent?.body !== fingerprint) intent = { body: fingerprint, key: deps.key() };
      owner = ticket;
      publish({ busy: true, error: null });
      try {
        const result = await deps.api.create(body, intent.key);
        if (!current(context, generation) || owner !== ticket) return;
        publish({
          receipt: { id: result.invoiceRequestId, no: result.requestNo },
          form: null,
          draft: emptyDraft(),
        });
        intent = null;
        await load();
        return result;
      } catch (failure) {
        if (current(context, generation) && owner === ticket)
          publish({ error: invoiceError(failure) });
      } finally {
        if (owner === ticket) {
          owner = null;
          if (current(context, generation)) publish({ busy: false });
        }
      }
    },
    async file(record: Invoice, kind: "blue" | "red") {
      const doc = record.docs.find((d) => d.docKind === kind);
      if (
        !active ||
        !live ||
        deps.role() !== "owner" ||
        state.fileBusy ||
        !doc?.hasFile ||
        !doc.fileFormat
      )
        return;
      const context = deps.context(),
        generation = epoch,
        controller = new AbortController();
      download = controller;
      publish({ fileBusy: `${record.invoiceRequestId}:${kind}`, error: null });
      let path = "";
      try {
        const signed = await deps.api.download(record.invoiceRequestId, kind);
        if (!current(context, generation)) return;
        const temp = await deps.files.download(signed.url, controller.signal);
        path = temp.tempFilePath;
        if (!current(context, generation)) return;
        if (temp.statusCode !== 200 || !path) throw new Error("FILE_NOT_USABLE");
        await deps.files.open(path, signed.fileFormat, signed.fileName);
      } catch (failure) {
        if (current(context, generation)) publish({ error: invoiceError(failure) });
      } finally {
        if (path) await deps.files.remove(path).catch(() => undefined);
        if (download === controller) {
          download = null;
          if (current(context, generation)) publish({ fileBusy: null });
        }
      }
    },
  };
}
