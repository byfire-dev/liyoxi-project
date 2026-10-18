import { expect, it, vi } from "vitest";
import type { Data } from "@/lib/account-api";
import type { RequestLayer, RequestOptions } from "@/lib/request";
import { createSubscribe } from "@/lib/subscribe";
import {
  invoiceContext,
  invoicePayment,
  invoiceRecord,
  invoiceSummary,
  offlineInvoiceRequest,
} from "../../../../shots/invoice-fixtures";
import { createInvoiceApi } from "./api";
import type { InvoiceBody, SignedInvoice } from "./api";
import {
  createInvoiceModel,
  emptyDraft,
  invoiceBody,
  invoiceError,
  invoiceStateLabel,
  mailLabel,
} from "./model";
import type { InvoiceFiles } from "./model";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const files = (): InvoiceFiles => ({
  download: vi.fn(async () => ({ statusCode: 200, tempFilePath: "/temp/owned-invoice" })),
  open: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
});
const payments = {
  items: [invoicePayment],
  nextCursor: null,
  hasMore: false,
} satisfies Data<"m.paymentOrder.list">;
const records = {
  items: [invoiceRecord()],
  nextCursor: null,
  hasMore: false,
} satisfies Data<"m.invoiceRequest.list">;
/** 完整typed读夹具仅装配本页六口，业务写响应由各用例明确提供。 */
function readResponse(path: string) {
  if (path.startsWith("/m/payment-orders/summary"))
    return { total: 9 } satisfies Data<"m.paymentOrder.summary">;
  if (path.startsWith("/m/payment-orders?")) return payments;
  if (path === "/m/invoice-requests/summary") return { ...invoiceSummary(records.items), total: 8 };
  if (path.startsWith("/m/invoice-requests?")) return records;
  throw new Error("unexpected invoice read");
}

it("typed申请与真实request形状：分页去重、同体重试同key/改字段新key、拒订阅仍提交，回执后刷新失败不重POST", async () => {
  const calls: Array<{ path: string; options?: RequestOptions }> = [];
  let attempts = 0,
    keys = 0,
    failReads = false;
  const request: RequestLayer["request"] = async <T>(path: string, options?: RequestOptions) => {
    calls.push({ path, options });
    if (options?.method === "POST") {
      if (++attempts < 3) throw new Error("https://private.invalid/transport?secret=hidden");
      failReads = true;
      return invoiceRecord() as T;
    }
    if (failReads) throw new Error("private refresh failure");
    if (path.startsWith("/m/payment-orders?"))
      return {
        ...payments,
        hasMore: !path.includes("cursor="),
        nextCursor: path.includes("cursor=") ? null : "cursor+/?",
      } satisfies Data<"m.paymentOrder.list"> as T;
    return readResponse(path) as T;
  };
  const api = createInvoiceApi(request);
  const model = createInvoiceModel({
    api,
    files: files(),
    prepare: async () => {},
    context: () => "owner:store:token:1",
    role: () => "owner",
    key: () => `invoice_apply:key-${++keys}`,
  });
  await model.load();
  expect(model.snapshot().eligibleCount).toBe(9);
  expect(model.snapshot().recordCount).toBe(8);
  expect(model.snapshot().context).toEqual(invoiceContext);
  await model.more("todo");
  expect(model.snapshot().payments).toHaveLength(1);
  expect(
    calls.some(
      (call) =>
        call.path ===
        "/m/payment-orders?invoiceState=eligible,applying&limit=20&cursor=cursor%2B%2F%3F",
    ),
  ).toBe(true);
  expect(calls.filter((call) => call.options?.method === "POST")).toHaveLength(0);
  model.open(invoicePayment);
  model.edit({ recvEmail: "first@example.invalid" });
  await model.submit();
  await model.submit();
  let writes = calls.filter((call) => call.options?.method === "POST");
  expect(writes).toHaveLength(2);
  expect(writes[0]!.options?.data).toEqual(writes[1]!.options?.data);
  expect(writes[0]!.options?.idempotencyKey).toBe(writes[1]!.options?.idempotencyKey);
  expect(model.snapshot().error).toBe("操作未完成，请重试");
  model.edit({ recvEmail: "changed@example.invalid" });
  const submitted = deferred<void>();
  const subscription = createSubscribe({
    requestSubscribe: vi.fn(async () => {
      throw new Error("user denied subscription");
    }),
    getPlan: () => ({
      enabled: true,
      plan: [
        {
          point: "invoice_apply",
          slots: [{ slotKey: "invoice-mail", tmplId: "public-test-template" }],
        },
      ],
      maxPerAsk: 1,
      cooldownDays: 7,
    }),
    storage: { get: () => null, set() {}, remove() {} },
    clock: { now: () => 0, sleep: async () => {} },
    uuid: () => "local-report",
  });
  subscription.withSubscribe("invoice_apply", async () => {
    await model.submit();
    submitted.resolve();
  })();
  await submitted.promise;
  writes = calls.filter((call) => call.options?.method === "POST");
  expect(writes).toHaveLength(3);
  expect(writes[2]).toEqual({
    path: "/m/invoice-requests",
    options: {
      method: "POST",
      idempotencyKey: "invoice_apply:key-2",
      data: {
        paymentOrderId: invoicePayment.paymentOrderId,
        invoiceType: "normal",
        medium: "electronic",
        recvEmail: "changed@example.invalid",
      } satisfies InvoiceBody,
    },
  });
  expect(model.snapshot().receipt).toEqual({
    id: invoiceRecord().invoiceRequestId,
    no: invoiceRecord().requestNo,
  });
  expect(model.snapshot().error).toBe("操作未完成，请重试");
  expect(model.snapshot().draft).toEqual(emptyDraft());
  expect(model.snapshot().form).toBeNull();
  await model.submit();
  expect(attempts).toBe(3);
  expect(JSON.stringify(model.snapshot())).not.toContain("secret=");
  const paper = invoiceBody(invoicePayment, {
    ...emptyDraft(),
    invoiceType: "special",
    medium: "paper",
    addrTel: "演示地址 电话",
    bankAccount: "演示开户行 123456",
    recipientName: "收件人",
    address: "演示市花园路一号",
    phoneSource: "login",
    phone: "13900000000",
  });
  expect(paper.mailTo).toEqual({
    recipientName: "收件人",
    address: "演示市花园路一号",
    phoneSource: "login",
  });
  expect(paper).not.toHaveProperty("recvEmail");
  expect(() => invoiceBody(invoicePayment, { ...emptyDraft(), medium: "paper" })).toThrow(
    "FORM_MEDIUM",
  );
});

it("当前店owner守卫与生命周期：clerk零API、prepare/GET/提交迟到隔离，hide卸载清PII且旧finally不清新请求busy", async () => {
  const preparation = deferred<void>(),
    oldRead = deferred<Data<"m.invoiceRequest.summary">>();
  let role = "clerk",
    context = "clerk:store-1:token-1",
    key = 0,
    holdRead = false;
  const firstWrite = deferred<Data<"m.invoiceRequest.create">>(),
    nextWrite = deferred<Data<"m.invoiceRequest.create">>();
  const calls: string[] = [];
  let writes = 0;
  const request: RequestLayer["request"] = async <T>(path: string, options?: RequestOptions) => {
    calls.push(path);
    if (options?.method === "POST")
      return (++writes === 1 ? firstWrite.promise : nextWrite.promise) as Promise<T>;
    if (holdRead && path === "/m/invoice-requests/summary") return oldRead.promise as Promise<T>;
    return readResponse(path) as T;
  };
  const api = createInvoiceApi(request);
  const deps = {
    api,
    files: files(),
    prepare: async () => {},
    context: () => context,
    role: () => role,
    key: () => `intent-${++key}`,
  };
  const model = createInvoiceModel(deps);
  await model.load();
  model.open(invoicePayment);
  await model.submit();
  await model.more("todo");
  expect(model.snapshot().restricted).toBe(true);
  expect(calls).toHaveLength(0);
  const waiting = createInvoiceModel({ ...deps, prepare: () => preparation.promise });
  const prepared = waiting.load();
  waiting.dispose();
  preparation.resolve();
  await prepared;
  expect(calls).toHaveLength(0);
  role = "owner";
  context = "owner:store-1:token-1";
  holdRead = true;
  const read = model.load();
  await Promise.resolve();
  model.suspend();
  context = "owner:store-2:token-2";
  oldRead.resolve(invoiceSummary([invoiceRecord()]));
  await read;
  expect(model.snapshot().context).toBeNull();
  expect(model.snapshot().payments).toEqual([]);
  holdRead = false;
  model.activate();
  await model.load();
  model.open(invoicePayment);
  model.edit({
    recvEmail: "private@example.invalid",
    bankAccount: "private bank",
    phone: "13900000000",
  });
  const old = model.submit();
  expect(writes).toBe(1);
  model.suspend();
  context = "owner:store-3:token-3";
  expect(model.snapshot().draft).toEqual(emptyDraft());
  expect(model.snapshot().receipt).toBeNull();
  model.activate();
  await model.load();
  model.open(invoicePayment);
  model.edit({ recvEmail: "current@example.invalid" });
  const fresh = model.submit();
  await model.submit();
  expect(writes).toBe(2);
  firstWrite.resolve(invoiceRecord());
  await old;
  expect(model.snapshot().busy).toBe(true);
  expect(model.snapshot().receipt).toBeNull();
  const accepted = {
    ...invoiceRecord(),
    invoiceRequestId: "00000000-0000-7000-8000-000000000003",
    requestNo: "202610170000003",
  };
  nextWrite.resolve(accepted);
  await fresh;
  expect(model.snapshot().receipt).toEqual({
    id: accepted.invoiceRequestId,
    no: accepted.requestNo,
  });
  model.dispose();
  expect(model.isActive()).toBe(false);
  expect(model.snapshot().draft).toEqual(emptyDraft());
  expect(model.snapshot().receipt).toBeNull();
});

it("文件每次POST现签且蓝红独立：PDF/OFD/XML真实格式受控、URL不入状态/错误、迟到下载取消只清自有文件", async () => {
  const fixture = offlineInvoiceRequest("invoice-issued");
  const downloads: Array<{ path: string; options?: RequestOptions }> = [];
  let xml = false;
  const call: RequestLayer["request"] = async <T>(path: string, options?: RequestOptions) => {
    if (path.endsWith("/download-urls")) {
      downloads.push({ path, options });
      const signed = await fixture<SignedInvoice>(path, options);
      return (
        xml
          ? ({ ...signed, fileFormat: "xml", fileName: "invoice.xml" } satisfies SignedInvoice)
          : signed
      ) as T;
    }
    return fixture<T>(path, options);
  };
  let context = "owner:token:1",
    count = 0;
  const ports = {
    download: vi.fn<InvoiceFiles["download"]>(async () => ({
      statusCode: 200,
      tempFilePath: `/temp/owned-${++count}`,
    })),
    open: vi.fn<InvoiceFiles["open"]>(async (_path, format) => {
      if (format !== "pdf") throw new Error("DOCUMENT_UNSUPPORTED");
    }),
    remove: vi.fn<InvoiceFiles["remove"]>(async () => {}),
  };
  const model = createInvoiceModel({
    api: createInvoiceApi(call),
    files: ports,
    prepare: async () => {},
    context: () => context,
    role: () => "owner",
    key: () => "unused-file-key",
  });
  await model.load();
  const record = model.snapshot().records[0]!;
  await model.file(record, "blue");
  await model.file(record, "blue");
  await model.file(record, "red");
  expect(downloads.map((item) => item.options)).toEqual([
    { method: "POST", data: { docKind: "blue" } },
    { method: "POST", data: { docKind: "blue" } },
    { method: "POST", data: { docKind: "red" } },
  ]);
  expect(ports.download.mock.calls[0]![0]).not.toBe(ports.download.mock.calls[1]![0]);
  expect(ports.open.mock.calls.map((item) => item[1])).toEqual(["pdf", "pdf", "ofd"]);
  expect(model.snapshot().error).toBe("此设备暂不支持该文件格式，请使用支持该格式的软件查看");
  xml = true;
  await model.file(
    { ...record, docs: record.docs.map((doc) => ({ ...doc, fileFormat: "xml" })) },
    "blue",
  );
  expect(ports.open.mock.calls.at(-1)![1]).toBe("xml");
  expect(ports.remove).toHaveBeenCalledTimes(4);
  expect(mailLabel("sent")).toBe("邮件已受理");
  expect(mailLabel("unknown")).toBe("邮件状态待更新");
  expect(invoiceStateLabel("unknown")).toBe("状态待更新");
  expect(invoiceError(new Error("https://private.invalid/signed?secret=hidden"))).toBe(
    "操作未完成，请重试",
  );
  expect(JSON.stringify(model.snapshot())).not.toContain("https://");
  const unavailable = { ...record, docs: record.docs.map((doc) => ({ ...doc, hasFile: false })) };
  await model.file(unavailable, "blue");
  expect(downloads).toHaveLength(4);
  xml = false;
  const late = deferred<{ statusCode: number; tempFilePath: string }>(),
    fresh = deferred<{ statusCode: number; tempFilePath: string }>();
  ports.download.mockReturnValueOnce(late.promise).mockReturnValueOnce(fresh.promise);
  const oldFile = model.file(record, "blue");
  await Promise.resolve();
  await Promise.resolve();
  const oldSignal = ports.download.mock.calls.at(-1)![1];
  model.suspend();
  context = "owner:new-token:2";
  expect(oldSignal.aborted).toBe(true);
  model.activate();
  await model.load();
  const newFile = model.file(model.snapshot().records[0]!, "blue");
  await Promise.resolve();
  await Promise.resolve();
  late.resolve({ statusCode: 200, tempFilePath: "/temp/late-owned" });
  await oldFile;
  expect(model.snapshot().fileBusy).not.toBeNull();
  expect(ports.open).not.toHaveBeenCalledWith(
    "/temp/late-owned",
    expect.anything(),
    expect.anything(),
  );
  expect(ports.remove).toHaveBeenCalledWith("/temp/late-owned");
  fresh.resolve({ statusCode: 200, tempFilePath: "/temp/current-owned" });
  await newFile;
  expect(model.snapshot().fileBusy).toBeNull();
  expect(ports.open).toHaveBeenLastCalledWith("/temp/current-owned", "pdf", "invoice-blue.pdf");
});
