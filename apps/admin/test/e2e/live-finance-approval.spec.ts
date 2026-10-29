import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  PointAdjustmentRequestDetailSchema,
  TermExtensionRequestDetailSchema,
} from "@liyoxi/contract";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { ensureLiveStepUp } from "./live-step-up";
interface Fixture {
  requesterStaffId: string;
  selfApprovalRejectedWithoutLedgerWrites: boolean;
  point: {
    approvalId: string;
    id: string;
    requestNo: string;
    adjustPoints: number;
    beforePoints: number;
  };
  extension: {
    approvalId: string;
    id: string;
    requestNo: string;
    days: number;
    prevEndDate: string | null;
    newEndDate: string | null;
  };
}
test("积分调整与延长审批：真实两类详情、发起人自审拒绝、异人通过并读回实际入账", async ({
  page,
}) => {
  const f = (liveContext().fixtures as { fixtures: { w418: { approvals: Fixture } } }).fixtures.w418
      .approvals,
    errors = recordErrors(page),
    detail = page.getByRole("complementary", { name: "申请详情与审批" });
  expect(f.selfApprovalRejectedWithoutLedgerWrites).toBe(true);
  const meResponse = await page.request.get("/api/v1/admin/auth/me");
  expect(meResponse.status()).toBe(200);
  const me = (await meResponse.json()).data as { staff: { staffId: string } };
  expect(me.staff.staffId).not.toBe(f.requesterStaffId);
  await ensureLiveStepUp(page);
  await page.goto(
    `/finance/credit-adjust?tab=all&kind=subscription_extend&id=${f.extension.approvalId}`,
  );
  await expect(detail.getByText(f.extension.requestNo, { exact: true })).toBeVisible();
  await expect(detail.getByText(`${f.extension.days} 天`, { exact: true })).toBeVisible();
  const extensionResponse = await page.request.get(
    `/api/v1/admin/term-extension-requests/${f.extension.id}`,
  );
  expect(extensionResponse.status()).toBe(200);
  const extension = TermExtensionRequestDetailSchema.parse((await extensionResponse.json()).data);
  expect(extension.approval.approvalId).toBe(f.extension.approvalId);
  expect(extension.preview).toMatchObject({
    prevEndDate: f.extension.prevEndDate,
    newEndDate: f.extension.newEndDate,
  });
  await expect(detail.getByRole("button", { name: "通过", exact: true })).toBeVisible();
  await page.goto(`/approvals?tab=all&kind=points_adjust&id=${f.point.approvalId}`);
  const approvalPanel = page.getByRole("dialog", { name: "审批详情", exact: true });
  await approvalPanel.getByRole("link", { name: "进入业务处理", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/finance/credit-adjust\\?id=${f.point.approvalId}$`));
  await expect(detail.getByText(f.point.requestNo, { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "通过", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "通过积分调整", exact: true });
  await expect(dialog.getByText(f.point.requestNo, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "确认通过", exact: true })).toBeDisabled();
  await dialog
    .getByRole("checkbox", { name: "我已核对调整依据、数量与当前积分", exact: true })
    .check();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/point-adjustment-requests/${f.point.id}/approve`),
  );
  await dialog.getByRole("button", { name: "确认通过", exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await expect(detail.getByText("已通过", { exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "通过", exact: true })).toHaveCount(0);
  const pointResponse = await page.request.get(
    `/api/v1/admin/point-adjustment-requests/${f.point.id}`,
  );
  expect(pointResponse.status()).toBe(200);
  const point = PointAdjustmentRequestDetailSchema.parse((await pointResponse.json()).data);
  expect(point.approval).toMatchObject({
    approvalId: f.point.approvalId,
    status: "approved",
    decidedBy: { staffId: me.staff.staffId },
  });
  expect(point.applied).toMatchObject({
    spendableAfterPoints: f.point.beforePoints + f.point.adjustPoints,
  });
  expect(point.currentSpendablePoints).toBe(f.point.beforePoints + f.point.adjustPoints);
  await noHorizontalScroll(page, "积分调整真实审批完成");
  mkdirSync("dist/e2e-shots", { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const geometry = () =>
    page.evaluate(() => {
      const shell = document.querySelector(".lyx-shell")?.getBoundingClientRect();
      return {
        width: innerWidth,
        height: innerHeight,
        shells: document.querySelectorAll(".lyx-shell").length,
        siders: document.querySelectorAll(".lyx-shell__sider").length,
        headers: document.querySelectorAll(".lyx-shell__header").length,
        top: shell?.top,
        shellHeight: shell?.height,
      };
    });
  const expected = {
    width: 1440,
    height: 900,
    shells: 1,
    siders: 1,
    headers: 1,
    top: 0,
    shellHeight: 900,
  };
  await expect.poll(geometry).toEqual(expected);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) =>
      requestAnimationFrame(() => requestAnimationFrame(() => done())),
    );
  });
  const observed = await geometry();
  expect(observed).toEqual(expected);
  writeFileSync(
    "dist/e2e-shots/w418-credit-adjust-approved.geometry.json",
    `${JSON.stringify(observed)}\n`,
  );
  await page.screenshot({
    path: "dist/e2e-shots/w418-credit-adjust-approved.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 1366, height: 768 });
  expect(errors).toEqual([]);
});
