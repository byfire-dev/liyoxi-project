import { expect, test } from "@playwright/test";
import { recordErrors } from "./live-context";
import { confirm, fixture, read, shot } from "./live-finance-invoices.helpers";
import { ensureLiveStepUp } from "./live-step-up";

test("红票弹层：实际失败邮件重发为queued，真实蓝票与异人退款批准后回填XML红票", async ({
  page,
}) => {
  const f = fixture(),
    errors = recordErrors(page),
    detail = page.getByRole("complementary", { name: "开票申请详情" });
  expect(f.requesterStaffId).not.toBe(f.reviewerStaffId);
  const before = await read(page, f.red.id);
  expect(before.status).toBe("red_pending");
  expect(before.docs[0]?.emailState).toBe("failed");
  await ensureLiveStepUp(page);
  await page.goto(`/finance/invoices?tab=red_pending&id=${f.red.id}`);
  await expect(detail.getByText(f.red.requestNo, { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "重发邮件", exact: true }).click();
  await confirm(page, "重发邮件", `/api/v1/admin/invoice-requests/${f.red.id}/resend`);
  const queued = await read(page, f.red.id);
  expect(queued.docs[0]?.emailState).toBe("queued");
  await expect(detail.getByText("邮件待发送", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "回填红字发票", exact: true }).click();
  const red = page.getByRole("dialog", { name: "回填红字发票", exact: true });
  await expect(red.getByText(before.docs[0]!.invoiceNo, { exact: true })).toBeVisible();
  await red.getByRole("textbox", { name: "发票号码", exact: true }).fill("20400000000000004182");
  await red.locator('input[type="file"]').setInputFiles({
    name: "fictional-red.xml",
    mimeType: "application/xml",
    buffer: Buffer.from('<?xml version="1.0"?><invoice>W418-FICTIONAL-RED</invoice>'),
  });
  await expect(red.getByRole("button", { name: "重新上传（替换）", exact: true })).toBeVisible();
  await red
    .getByRole("textbox", { name: "处理说明", exact: true })
    .fill("本轮虚构已开红字票据回填");
  await shot(page, "w418-red-invoice-confirm");
  await confirm(page, "回填红字发票", `/api/v1/admin/invoice-requests/${f.red.id}/issue-red`);
  const current = await read(page, f.red.id),
    doc = current.docs.find((value) => value.docKind === "red");
  expect(current.status).toBe("red_issued");
  expect(current.docs).toHaveLength(2);
  expect(doc).toMatchObject({
    invoiceNo: "20400000000000004182",
    amountFen: -before.amountFen,
    hasFile: true,
    fileFormat: "xml",
  });
  await expect(detail.getByText("20400000000000004182", { exact: true })).toBeVisible();
  await shot(page, "w418-red-invoice-recorded");
  expect(errors).toEqual([]);
});
