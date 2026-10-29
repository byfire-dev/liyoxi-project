import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { writeTableSearch } from "../../../lib/table-search";
import { moneyText } from "../payments/model";
import { access, fileId, invoiceFixture, invoiceId } from "./fixtures.test-support";
import {
  allowedInvoiceActions,
  createInvoiceIntent,
  emptyInvoiceDraft,
  invoiceCommand,
  invoiceFilters,
  invoiceSearch,
  invoiceStamp,
  invoiceTable,
  refreshInvoiceDetail,
} from "./model";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
};
it("URL保留真实筛选/页码，切筛选清选中；真实actions交权限，零款和大整数汇总不误算", () => {
  const search = invoiceSearch({
    q: "  虚构主体  ",
    tab: "red_pending",
    invoiceType: "special",
    medium: "paper",
    id: invoiceId,
    page: "2",
    pageSize: "10",
  });
  expect(invoiceFilters(search)).toEqual({
    q: "虚构主体",
    invoiceType: "special",
    medium: "paper",
  });
  expect(invoiceSearch(writeTableSearch(invoiceTable(search)))).toEqual({
    ...search,
    id: undefined,
  });
  expect(invoiceSearch({ page: -1, medium: "script", tab: "invalid", id: "../" })).toMatchObject({
    page: 1,
    medium: undefined,
    tab: "pending",
    id: undefined,
  });
  const row = invoiceFixture();
  expect(allowedInvoiceActions(row, access)).toEqual(["issue", "reject"]);
  expect(allowedInvoiceActions(row, { ...access, actions: ["finance.invoice.red"] })).toEqual([]);
  expect(allowedInvoiceActions(row, { ...access, moduleLevels: {} })).toEqual([]);
  expect(moneyText("0")).toBe("¥0.00");
  expect(moneyText("900719925474099300")).toBe("¥9,007,199,254,740,993.00");
  expect(moneyText(null)).toBe("—");
});
it("四动作严格使用现有body，票号/纸票/文件/蓝票确认受守卫，版本变化会改变确认快照", () => {
  const row = invoiceFixture(),
    draft = { ...emptyInvoiceDraft(), invoiceNo: "20400000000000004181", fileId };
  expect(invoiceCommand(row, "issue", draft)).toEqual({
    action: "issue",
    body: {
      invoiceNo: draft.invoiceNo,
      fileId,
      confirm: { requestNo: row.requestNo, amountFen: 100 },
    },
  });
  expect(() => invoiceCommand(row, "issue", { ...draft, fileId: null })).toThrow();
  expect(() => invoiceCommand(row, "issue", { ...draft, invoiceNo: "12345678" })).toThrow();
  expect(
    invoiceCommand(row, "reject", { ...draft, reasonCode: "INVOICE", note: "核对有误" }),
  ).toEqual({ action: "reject", body: { reasonCode: "INVOICE", note: "核对有误" } });
  expect(invoiceCommand(row, "resend", draft)).toEqual({ action: "resend" });
  expect(() => invoiceCommand(row, "issue-red", draft)).toThrow();
  row.docs = [
    {
      invoiceDocId: fileId,
      docKind: "blue",
      invoiceNo: "20400000000000004180",
      invoiceCode: null,
      amountFen: 100,
      issuedAt: row.appliedAt,
      hasFile: true,
      fileFormat: "pdf",
      expressCompany: null,
      trackingNo: null,
      shippedAt: null,
      emailState: "failed",
      fileId,
      issuedBy: null,
      emailSentAt: null,
      redReason: null,
    },
  ];
  expect(invoiceCommand(row, "issue-red", draft)).toMatchObject({
    action: "issue-red",
    body: {
      fileId,
      confirm: { requestNo: row.requestNo, blueInvoiceNo: row.docs[0]!.invoiceNo, amountFen: 100 },
    },
  });
  const old = invoiceStamp(row);
  row.lockVersion++;
  expect(invoiceStamp(row)).not.toBe(old);
  row.medium = "paper";
  row.prechecks = [];
  expect(() => invoiceCommand(row, "issue", draft)).toThrow();
  expect(
    invoiceCommand(row, "issue", {
      ...draft,
      invoiceNo: "12345678",
      invoiceCode: "1234567890",
      expressCompanyCode: "SF",
      trackingNo: "FIXTURE",
    }),
  ).toMatchObject({
    body: { invoiceCode: "1234567890", expressCompanyCode: "SF", trackingNo: "FIXTURE" },
  });
});
it("同意图同步闩/未知同key与正文变化换key；scope关闭取消且迟到结果不发布", async () => {
  let serial = 0;
  const intent = createInvoiceIntent(() => `invoice:${++serial}`),
    waiting = deferred<string>();
  let signal: AbortSignal | undefined;
  const first = intent.submit("issue", [7, "body"], async (_key, own) => {
    signal = own;
    return waiting.promise;
  });
  expect(await intent.submit("issue", [7, "body"], async () => "duplicate")).toBeUndefined();
  intent.close();
  expect(signal?.aborted).toBe(true);
  waiting.resolve("late");
  expect(await first).toBeUndefined();
  intent.activate();
  const failed = vi.fn(async (_key: string) => {
    throw new Error("未知结果");
  });
  await expect(intent.submit("resend", [7], failed)).rejects.toThrow();
  await expect(intent.submit("resend", [7], failed)).rejects.toThrow();
  expect(failed.mock.calls[1]?.[0]).toBe(failed.mock.calls[0]?.[0]);
  await expect(intent.submit("resend", [8], failed)).rejects.toThrow();
  expect(failed.mock.calls[2]?.[0]).not.toBe(failed.mock.calls[0]?.[0]);
});
it("真实QueryClient取消旧GET；已卸载的新GET迟到也不能覆盖当前详情", async () => {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    key = ["invoice", invoiceId],
    old = deferred<ReturnType<typeof invoiceFixture>>();
  const previous = cache
    .fetchQuery({ queryKey: key, queryFn: () => old.promise })
    .catch(() => undefined);
  const row = invoiceFixture();
  row.lockVersion++;
  await refreshInvoiceDetail(cache, key, new AbortController().signal, async () => row);
  old.resolve(invoiceFixture());
  await previous;
  expect(cache.getQueryData(key)).toEqual(row);
  const late = deferred<typeof row>(),
    controller = new AbortController(),
    pending = refreshInvoiceDetail(cache, key, controller.signal, () => late.promise);
  await Promise.resolve();
  controller.abort();
  late.resolve(invoiceFixture());
  await expect(pending).rejects.toThrow();
  expect(cache.getQueryData(key)).toEqual(row);
  cache.clear();
});
