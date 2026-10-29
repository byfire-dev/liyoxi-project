import { expect, test } from "@playwright/test";
import { recordErrors } from "./live-context";
import { confirm, fixture, read, shot } from "./live-finance-invoices.helpers";
import { ensureLiveStepUp } from "./live-step-up";

test("发票队列：真实筛选URL、驳回及原上传公口开具，实际GET读回票据", async ({ page }) => {
  const f = fixture(),
    errors = recordErrors(page),
    detail = page.getByRole("complementary", { name: "开票申请详情" });
  await ensureLiveStepUp(page);
  await page.goto(
    `/finance/invoices?tab=pending&q=${encodeURIComponent(f.reject.requestNo)}&id=${f.reject.id}`,
  );
  await expect(detail.getByText(f.reject.requestNo, { exact: true })).toBeVisible();
  await page.reload();
  await expect(detail.getByText(f.reject.requestNo, { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "驳回申请", exact: true }).click();
  const rejection = page.getByRole("dialog", { name: "驳回申请", exact: true });
  await rejection.getByRole("combobox", { name: "驳回原因", exact: true }).click();
  await page.getByText(f.rejectReason, { exact: true }).click();
  await rejection
    .getByRole("textbox", { name: "处理说明", exact: true })
    .fill("本轮虚构资料需补正");
  await confirm(page, "驳回申请", `/api/v1/admin/invoice-requests/${f.reject.id}/reject`);
  expect((await read(page, f.reject.id)).status).toBe("rejected");
  await page.goto(`/finance/invoices?tab=pending&id=${f.pending.id}`);
  await expect(detail.getByText(f.pending.requestNo, { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "开具发票", exact: true }).click();
  const issue = page.getByRole("dialog", { name: "开具发票", exact: true });
  await issue.getByRole("textbox", { name: "发票号码", exact: true }).fill("20400000000000004181");
  await issue.locator('input[type="file"]').setInputFiles({
    name: "fictional-blue.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from(f.pdf, "base64"),
  });
  await expect(issue.getByRole("button", { name: "重新上传（替换）", exact: true })).toBeVisible();
  await confirm(page, "开具发票", `/api/v1/admin/invoice-requests/${f.pending.id}/issue`);
  const issued = await read(page, f.pending.id);
  expect(issued.status).toBe("issued");
  expect(issued.docs).toHaveLength(1);
  expect(issued.docs[0]).toMatchObject({
    docKind: "blue",
    invoiceNo: "20400000000000004181",
    hasFile: true,
    fileFormat: "pdf",
  });
  await expect(detail.getByText("20400000000000004181", { exact: true })).toBeVisible();
  await shot(page, "w418-invoice-issued");
  expect(errors).toEqual([]);
});
