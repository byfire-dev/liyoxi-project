import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  AdminOrderDetailSchema,
  CancelQuoteSchema,
  CancelApproveBodySchema,
  CancelRequestDetailSchema,
  LicenseLetterListSchema,
  SignedUrlSchema,
  StaffMeSchema,
} from "@liyoxi/contract";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { liveChildEnv, liveChildFailure } from "./live-child-env";
import { apiData } from "./live-delivery-fixture";
import { ensureLiveStepUp } from "./live-step-up";

interface Actor {
  staffId: string;
  name: string;
  roleKey: string;
  phone: string;
  password: string;
  recoveryCodes: string[];
}
interface OrderRef {
  orderId: string;
  itemId: string;
  orderNo: string;
  dramaId: string;
  pointHoldId: string;
  chargePoints: number;
  ticketId: string;
}
interface Proof {
  ledger: {
    account: { planAvailableQty: number; addonAvailableQty: number; heldTotalQty: number };
    entries: unknown[];
    [key: string]: unknown;
  };
  operations: {
    id: string;
    opKey: string;
    opType: string;
    pointHoldId: string | null;
    refType: string | null;
    refId: string | null;
    planDeltaQty: number;
    addonDeltaQty: number;
  }[];
  requests: {
    id: string;
    status: string;
    executedByStaffId: string | null;
    approvalRequest: { requesterStaffId: string | null; decidedByStaffId: string | null };
    cancelRequestLines: {
      id: string;
      returnedPoints: number;
      convertedPoints: number;
      forfeitedPoints: number;
      resultSnapshot: unknown;
    }[];
  }[];
  letters: {
    id: string;
    status: string;
    currentRevisionId: string | null;
    revisions: {
      id: string;
      revNo: number;
      renderStatus: string;
      renderAttemptNo: number;
      fileId: string | null;
      pdfSha256: string | null;
      signMode: string | null;
    }[];
  }[];
}
interface Prepared {
  cancel: OrderRef;
  license: OrderRef;
  channelAccountId: string;
  subscriptionTermId: string;
  alreadyPrepared: boolean;
  proof: Proof;
}
interface Rendered {
  processedRevisionIds: string[];
  failed: boolean;
  technicalTestCertificate: boolean;
  proof: Proof;
}
function fixture() {
  return (
    liveContext().fixtures as {
      fixtures: {
        w513: {
          aftersales: {
            finance: Actor;
            scope: {
              runId: string;
              entityId: string;
              storeId: string;
              requesterId: string;
              financeId: string;
            };
          };
        };
      };
    }
  ).fixtures.w513.aftersales;
}
const headers = () => ({
  "X-LYX-Admin": "1",
  Origin: liveContext().origin,
  "X-Client-Version": "1.0.0",
});
type BridgeAction =
  "prepare" | "render" | "fail-render" | "change-license-input" | "inspect" | "cleanup";
function bridge<T>(action: BridgeAction): Promise<T> {
  const context = process.env.LYX_ADMIN_LIVE_CONTEXT;
  if (!context) throw new Error("W513P2缺少本轮context");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "--silent",
        "--filter",
        "@liyoxi/services",
        "exec",
        "tsx",
        "scripts/admin-live-w513-aftersales.ts",
        "--context",
        context,
        "--action",
        action,
      ],
      {
        cwd: fileURLToPath(new URL("../../../..", import.meta.url)),
        env: {
          ...liveChildEnv([
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "SHELL",
            "TMPDIR",
            "TMP",
            "TEMP",
            "LANG",
            "LC_ALL",
            "CI",
            "PNPM_HOME",
          ]),
          APP_ENV: "test",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      error = "";
    child.stdout.on("data", (bytes) => {
      output = `${output}${bytes}`.slice(-131072);
    });
    child.stderr.on("data", (bytes) => {
      error = `${error}${bytes}`.slice(-4096);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const failure = liveChildFailure("W513P2本轮owner桥失败", error);
        for (const line of error.split("\n")) {
          try {
            const record = JSON.parse(line);
            if (
              record.evt === "w513.aftersales.failed" &&
              [
                "context",
                "runtime",
                "prepare",
                "render",
                "fail-render",
                "change-license-input",
                "inspect",
                "cleanup",
              ].includes(record.phase) &&
              /^(?:[A-Z_]+|non_application)$/.test(record.symbol)
            ) {
              const reason = /^[A-Z0-9_]+$/.test(record.reason ?? "") ? `:${record.reason}` : "";
              failure.message += `（${record.phase}:${record.symbol}${reason}）`;
            }
          } catch {
            /* Only the fixed safe phase/symbol protocol is retained. */
          }
        }
        reject(failure);
        return;
      }
      try {
        resolve(JSON.parse(output) as T);
      } catch {
        reject(new Error("W513P2 owner桥缺少明确JSON回执"));
      }
    });
  });
}
async function shot(page: Page, name: string, loaded: Locator) {
  await expect(loaded).toBeVisible();
  await noHorizontalScroll(page, name);
  await page.setViewportSize({ width: 1440, height: 900 });
  try {
    await page.evaluate(async () => {
      window.scrollTo({ top: 0, left: 0 });
      document.querySelector("main")?.scrollTo({ top: 0, left: 0 });
      await document.fonts.ready;
      await new Promise<void>((done) =>
        requestAnimationFrame(() => requestAnimationFrame(() => done())),
      );
    });
    await loaded.scrollIntoViewIfNeeded();
    await expect(loaded).toBeVisible();
    mkdirSync("dist/e2e-shots", { recursive: true });
    const deadline = Date.now() + 10_000;
    let pair = 0,
      stable: Buffer | undefined;
    await expect
      .poll(
        async () => {
          const first = await page.screenshot({
            path: `dist/e2e-shots/${name}-pair-first.png`,
            animations: "disabled",
            timeout: Math.max(1, deadline - Date.now()),
          });
          await page.evaluate(
            () => new Promise<void>((done) => requestAnimationFrame(() => done())),
          );
          const second = await page.screenshot({
            path: `dist/e2e-shots/${name}-pair-second.png`,
            animations: "disabled",
            timeout: Math.max(1, deadline - Date.now()),
          });
          if (++pair === 1) {
            writeFileSync(`dist/e2e-shots/${name}-initial-first.png`, first);
            writeFileSync(`dist/e2e-shots/${name}-initial-second.png`, second);
          }
          if (first.equals(second)) {
            stable = second;
            return true;
          }
          return false;
        },
        { timeout: 10_000, intervals: [100], message: `${name}固定10秒精确双帧` },
      )
      .toBe(true);
    if (!stable) throw new Error("W513P2未取得精确一致双帧");
    writeFileSync(`dist/e2e-shots/${name}.png`, stable);
    writeFileSync(
      `dist/e2e-shots/${name}.proof.json`,
      `${JSON.stringify({ loaded: true, pairs: pair, canonicalSha256: createHash("sha256").update(stable).digest("hex") })}\n`,
    );
  } finally {
    await page.setViewportSize({ width: 1366, height: 768 });
  }
}
const responseFor = (page: Page, path: string) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === path,
  );
const readCancel = async (page: Page, id: string) =>
  CancelRequestDetailSchema.parse(
    await apiData(page.request, `/api/v1/admin/cancel-requests/${id}`),
  );
const readLicenses = async (page: Page, itemId: string) =>
  LicenseLetterListSchema.parse(
    await apiData(
      page.request,
      `/api/v1/admin/order-items/${itemId}/license-letters?includeVoided=true`,
    ),
  );
async function openOrder(page: Page, ref: OrderRef, tab: "售后与取消" | "授权与下载") {
  await page.goto(`/orders/${encodeURIComponent(ref.orderNo)}`);
  await expect(
    page.getByRole("heading", { name: `订购单 ${ref.orderNo}`, exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: tab, exact: true }).click();
}
async function loginFinance(page: Page, actor: Actor, redirect: string) {
  const first = actor.recoveryCodes[0],
    next = actor.recoveryCodes[1];
  if (!first || !next) throw new Error("W513P2独立财务缺少本轮未用恢复码");
  await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`);
  await page.getByLabel("手机号", { exact: true }).fill(actor.phone);
  await page.getByLabel("密码", { exact: true }).fill(actor.password);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("radio", { name: "恢复码", exact: true }).check();
  await page.getByRole("textbox", { name: "恢复码", exact: true }).fill(first);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "用户菜单" })).toContainText(actor.name);
  const before = StaffMeSchema.parse(await apiData(page.request, "/api/v1/admin/auth/me"));
  expect(before.staff.staffId).toBe(actor.staffId);
  // Native transport keeps even fictional recovery codes out of Playwright's request trace.
  const cookie = (await page.context().cookies(liveContext().origin))
    .map((row) => `${row.name}=${row.value}`)
    .join("; ");
  const result = await fetch(`${liveContext().origin}/api/v1/admin/auth/step-up`, {
    method: "POST",
    headers: { ...headers(), Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ method: "recovery", code: next }),
  });
  expect(result.status).toBe(200);
  const after = StaffMeSchema.parse(await apiData(page.request, "/api/v1/admin/auth/me"));
  expect(after.session.staffSessionId).toBe(before.session.staffSessionId);
  expect(Date.parse(after.session.stepUpValidUntil)).toBeGreaterThan(Date.parse(after.serverTime));
}
async function decide(
  page: Page,
  action: "approve" | "execute",
  current: ReturnType<typeof CancelRequestDetailSchema.parse>,
) {
  const name = action === "approve" ? "批准取消" : "执行积分退回";
  await page
    .getByRole("region", { name: "取消与积分退回详情", exact: true })
    .getByRole("button", { name, exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name, exact: true })).toBeDisabled();
  await dialog
    .getByLabel("请输入拟退积分", { exact: true })
    .fill(String(current.totalRefundPoints));
  await dialog
    .getByRole("checkbox", {
      name: action === "approve" ? "已核对阶段规则及积分金额" : "已核对订单及退回积分",
      exact: true,
    })
    .check();
  if (action === "approve")
    await shot(
      page,
      "w513-p2-02-cancel-approval",
      dialog.getByRole("button", { name, exact: true }),
    );
  const written = responseFor(
    page,
    `/api/v1/admin/cancel-requests/${current.cancelRequestId}/${action}`,
  );
  await dialog.getByRole("button", { name, exact: true }).click();
  const response = await written;
  expect(response.status()).toBe(200);
  const receipt = CancelRequestDetailSchema.parse((await response.json()).data);
  await expect(dialog).toHaveCount(0);
  return receipt;
}

test.afterAll(async () => {
  // Fallback for a failure before the second case's normal cleanup; never swallow a cleanup error.
  const result = await bridge<{ cleanedFiles: number }>("cleanup");
  expect(result.cleanedFiles).toBeGreaterThanOrEqual(0);
});

test("W513取消：真实试算申请、独立财务批准、原申请人执行并核真实积分账", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const f = fixture(),
    prepared = await bridge<Prepared>("prepare"),
    errors = recordErrors(page);
  const me = StaffMeSchema.parse(await apiData(page.request, "/api/v1/admin/auth/me"));
  expect(me.staff.staffId).toBe(f.scope.requesterId);
  expect(me.staff.staffId).not.toBe(f.finance.staffId);
  expect(f.finance.staffId).toBe(f.scope.financeId);
  const initial = AdminOrderDetailSchema.parse(
    await apiData(page.request, `/api/v1/admin/orders/${prepared.cancel.orderId}`),
  );
  expect(initial.store.storeId).toBe(f.scope.storeId);
  expect(initial.cancelRequests).toHaveLength(0);
  await openOrder(page, prepared.cancel, "售后与取消");
  const quoted = responseFor(page, `/api/v1/admin/orders/${prepared.cancel.orderId}/cancel-quote`);
  await page.getByRole("button", { name: "发起取消申请", exact: true }).click();
  const dialog = page.getByRole("dialog", {
    name: `取消申请 · ${prepared.cancel.orderNo}`,
    exact: true,
  });
  const quoteResponse = await quoted;
  expect(quoteResponse.status()).toBe(200);
  const quote = CancelQuoteSchema.parse((await quoteResponse.json()).data);
  expect(quote.lines.map((row) => row.targetId)).toEqual([prepared.cancel.itemId]);
  expect(quote.lines[0]?.mode).toBe("refund");
  expect(quote.blockers).toEqual([]);
  expect(quote.needsManualDeduct).toBe(false);
  expect(quote.totalRefundPoints).toBeGreaterThan(0);
  await expect(dialog.getByLabel("取消逐行试算")).toContainText("已扣退回");
  await dialog
    .getByLabel("申请说明", { exact: true })
    .fill("本轮独立角色真实取消演练，已逐项核对阶段及积分");
  await dialog
    .getByRole("checkbox", {
      name: "我已核对逐项阶段、扣除及退回积分，申请受理不代表已经退回",
      exact: true,
    })
    .check();
  await shot(page, "w513-p2-01-cancel-quote", dialog.getByLabel("取消逐行试算"));
  const submitted = responseFor(
    page,
    `/api/v1/admin/orders/${prepared.cancel.orderId}/cancel-requests`,
  );
  await dialog.getByRole("button", { name: "提交取消申请", exact: true }).click();
  const submittedResponse = await submitted;
  expect(submittedResponse.status()).toBe(200);
  const cancel = CancelRequestDetailSchema.parse((await submittedResponse.json()).data);
  expect(cancel.status).toBe("pending_approval");
  expect(cancel.requester?.staffId).toBe(me.staff.staffId);
  expect(cancel.totalRefundPoints).toBe(quote.totalRefundPoints);
  await expect(dialog).toHaveCount(0);
  const afterSubmit = await bridge<Proof>("inspect");
  expect(afterSubmit.ledger).toEqual(prepared.proof.ledger);
  await ensureLiveStepUp(page);
  const approveBody = CancelApproveBodySchema.parse({
    lockVersion: cancel.approval.lockVersion,
    confirm: { requestNo: cancel.requestNo, totalRefundPoints: cancel.totalRefundPoints },
    confirmChecks: ["stage_rule_amount_checked"],
  });
  const selfApproval = await page.request.post(
    `/api/v1/admin/cancel-requests/${cancel.cancelRequestId}/approve`,
    {
      headers: { ...headers(), "Idempotency-Key": crypto.randomUUID() },
      data: approveBody,
    },
  );
  expect(selfApproval.status()).toBe(403);
  expect((await selfApproval.json()).error).toBe("APPROVAL_SELF_FORBIDDEN");
  const afterSelf = await bridge<Proof>("inspect");
  expect(afterSelf.ledger).toEqual(afterSubmit.ledger);
  expect(afterSelf.requests).toEqual(afterSubmit.requests);
  const financeContext = await browser.newContext({
    baseURL: liveContext().origin,
    viewport: { width: 1366, height: 768 },
  });
  try {
    const finance = await financeContext.newPage(),
      financeErrors = recordErrors(finance);
    await loginFinance(finance, f.finance, `/approvals?id=${cancel.approval.approvalId}`);
    const denied = await finance.request.post(
      `/api/v1/admin/orders/${prepared.cancel.orderId}/cancel-quote`,
      {
        headers: headers(),
        data: { reasonCode: "merchant_request", orderItemIds: [prepared.cancel.itemId] },
      },
    );
    expect(denied.status()).toBe(403);
    expect((await denied.json()).error).toBe("PERMISSION_DENIED");
    expect((await bridge<Proof>("inspect")).ledger).toEqual(afterSubmit.ledger);
    // Same actual owner conflict case as the API target: a noncurrent approval version, never the order version.
    const wrongVersion = await finance.request.post(
      `/api/v1/admin/cancel-requests/${cancel.cancelRequestId}/approve`,
      {
        headers: { ...headers(), "Idempotency-Key": crypto.randomUUID() },
        data: CancelApproveBodySchema.parse({
          ...approveBody,
          lockVersion: cancel.approval.lockVersion + 1,
        }),
      },
    );
    expect(wrongVersion.status()).toBe(409);
    expect((await wrongVersion.json()).error).toBe("VERSION_CONFLICT");
    const afterConflict = await bridge<Proof>("inspect");
    expect(afterConflict.ledger).toEqual(afterSubmit.ledger);
    expect(afterConflict.requests).toEqual(afterSubmit.requests);
    const panel = finance.getByRole("region", { name: "取消与积分退回详情", exact: true });
    await expect(panel.getByText(cancel.requestNo, { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "批准取消", exact: true })).toBeEnabled();
    const approved = await decide(finance, "approve", cancel);
    expect(approved.status).toBe("pending_execution");
    expect(approved.approval.decidedBy?.staffId).toBe(f.finance.staffId);
    expect(approved.execution).toBeNull();
    const afterApprove = await bridge<Proof>("inspect");
    expect(afterApprove.ledger).toEqual(afterSubmit.ledger);
    expect(financeErrors).toEqual([]);
  } finally {
    await financeContext.close();
  }
  await ensureLiveStepUp(page);
  await page.goto(
    `/approvals?cancel_tab=pending_execution&cancel_storeId=${f.scope.storeId}&cancelId=${cancel.cancelRequestId}`,
  );
  const current = await readCancel(page, cancel.cancelRequestId);
  expect(current.status).toBe("pending_execution");
  expect(current.approval.decidedBy?.staffId).toBe(f.finance.staffId);
  const currentPanel = page.getByRole("region", { name: "取消与积分退回详情", exact: true });
  await expect(
    currentPanel.getByRole("button", { name: "执行积分退回", exact: true }),
  ).toBeEnabled();
  const done = await decide(page, "execute", current);
  expect(done.status).toBe("done");
  expect(done.execution?.executedBy?.staffId).toBe(me.staff.staffId);
  expect(done.executedAt).not.toBeNull();
  const actual = await readCancel(page, cancel.cancelRequestId);
  expect(actual.status).toBe("done");
  expect(actual.lines).toHaveLength(1);
  expect(actual.lines[0]?.result).not.toBeNull();
  expect(actual.resultTotals).not.toBeNull();
  expect(actual.actions).not.toContain("execute");
  const proof = await bridge<Proof>("inspect"),
    request = proof.requests.find((row) => row.id === actual.cancelRequestId);
  expect(request).toMatchObject({
    status: "done",
    executedByStaffId: me.staff.staffId,
    approvalRequest: { requesterStaffId: me.staff.staffId, decidedByStaffId: f.finance.staffId },
  });
  const line = actual.lines[0]!,
    actualLine = request!.cancelRequestLines.find((row) => row.id === line.cancelRequestLineId);
  expect(actualLine?.resultSnapshot).not.toBeNull();
  expect(actualLine).toMatchObject({
    returnedPoints: line.result!.returnedPoints,
    convertedPoints: line.result!.convertedPoints,
    forfeitedPoints: line.result!.forfeitedPoints,
  });
  const added = proof.operations.filter(
    (row) => !prepared.proof.operations.some((old) => old.id === row.id),
  );
  expect(added).toHaveLength(1);
  expect(added[0]).toMatchObject({
    opType: "refund",
    pointHoldId: prepared.cancel.pointHoldId,
    refType: "cancel_request_line",
    refId: line.cancelRequestLineId,
  });
  expect(proof.ledger.entries.length).toBeGreaterThan(prepared.proof.ledger.entries.length);
  expect(
    proof.ledger.account.planAvailableQty +
      proof.ledger.account.addonAvailableQty -
      prepared.proof.ledger.account.planAvailableQty -
      prepared.proof.ledger.account.addonAvailableQty,
  ).toBe(actual.resultTotals!.returnedPoints + actual.resultTotals!.convertedPoints);
  for (const [action, symbol] of [
    ["withdraw", "APPROVAL_NOT_PENDING"],
    ["void", "STATE_NOT_ALLOWED"],
  ] as const) {
    const terminal = await page.request.post(
      `/api/v1/admin/cancel-requests/${actual.cancelRequestId}/${action}`,
      {
        headers: { ...headers(), "Idempotency-Key": crypto.randomUUID() },
        data: { note: "已执行终态不能再次撤回或作废" },
      },
    );
    expect(terminal.status()).toBe(409);
    expect((await terminal.json()).error).toBe(symbol);
  }
  const afterTerminal = await bridge<Proof>("inspect");
  expect(afterTerminal.ledger).toEqual(proof.ledger);
  expect(afterTerminal.requests).toEqual(proof.requests);
  expect((await readCancel(page, actual.cancelRequestId)).status).toBe("done");
  await expect(currentPanel).toContainText("执行结果：");
  await expect(currentPanel.getByRole("button", { name: "执行积分退回", exact: true })).toHaveCount(
    0,
  );
  await shot(
    page,
    "w513-p2-03-cancel-executed",
    currentPanel.getByText("执行结果：", { exact: false }),
  );
  await openOrder(page, prepared.cancel, "售后与取消");
  await expect(page.getByText(`${cancel.requestNo} · 已执行`, { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "订单活动", exact: true }).click();
  await expect(page.getByRole("heading", { name: "订单活动", exact: true })).toBeVisible();
  mkdirSync("dist/e2e-shots", { recursive: true });
  writeFileSync("dist/e2e-shots/w513-p2-cancel-ledger-proof.json", `${JSON.stringify(proof)}\n`);
  expect(errors).toEqual([]);
});

async function licenseMutation(
  page: Page,
  article: Locator,
  kind: "correct" | "rerender" | "void",
  target: { letterId: string; revisionId: string },
) {
  const names = {
    correct: "更正授权书",
    rerender: "重新生成失败版次",
    void: "作废并按当前事实重出",
  };
  const name = names[kind];
  await article.getByRole("button", { name, exact: true }).click();
  const modal = page.getByRole("dialog", { name, exact: true });
  await expect(modal).toBeVisible();
  if (kind === "correct") {
    await modal.getByRole("combobox", { name: "更正类型", exact: true }).click();
    await page.getByTitle("主体名称", { exact: true }).click();
    // 多选保持展开；沿用户正常点标题收起，再填写其下方确认，不强制穿透浮层。
    await modal.locator(".ant-modal-title").click();
    await expect(page.locator(".ant-select-dropdown:visible")).toHaveCount(0);
  }
  if (kind !== "rerender")
    await modal
      .getByLabel("处理原因", { exact: true })
      .fill(
        kind === "correct"
          ? "本轮虚构上游主体名称已更新，请按当前事实更正"
          : "本轮授权演练需按当前业务事实重出，保留历史版次",
      );
  await modal
    .getByRole("checkbox", {
      name: "我已核对授权编号、账号和操作版次；受理不代表PDF已生成",
      exact: true,
    })
    .check();
  const path =
    kind === "rerender"
      ? `/api/v1/admin/license-letter-revisions/${target.revisionId}/rerender`
      : `/api/v1/admin/license-letters/${target.letterId}/${kind}`;
  const written = responseFor(page, path);
  await modal.getByRole("button", { name, exact: true }).click();
  const response = await written;
  expect(response.status()).toBe(200);
  await expect(modal).toHaveCount(0);
}
async function pdfProof(
  page: Page,
  article: Locator,
  letter: ReturnType<typeof LicenseLetterListSchema.parse>["items"][number],
  proof: Proof,
) {
  const revision = letter.currentRevision;
  expect(revision?.renderStatus).toBe("ready");
  expect(revision?.fileId).not.toBeNull();
  const signed = responseFor(page, `/api/v1/admin/files/${revision!.fileId}/download-urls`);
  await article.getByRole("button", { name: "下载当前授权PDF", exact: true }).click();
  const response = await signed;
  expect(response.status()).toBe(200);
  const grant = SignedUrlSchema.parse((await response.json()).data);
  expect(Date.parse(grant.expiresAt)).toBeGreaterThan(Date.now());
  const file = await page.request.get(grant.url);
  expect(file.status()).toBe(200);
  const bytes = await file.body();
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const sha256 = createHash("sha256").update(bytes).digest("hex"),
    row = proof.letters
      .find((value) => value.id === letter.licenseLetterId)
      ?.revisions.find((value) => value.id === revision!.licenseLetterRevisionId);
  expect(row?.pdfSha256).toBe(sha256);
  expect(row?.fileId).toBe(revision!.fileId);
  return {
    letterId: letter.licenseLetterId,
    revisionId: revision!.licenseLetterRevisionId,
    fileId: revision!.fileId,
    sha256,
    bytes: bytes.length,
  };
}
function latestRevision(letter: ReturnType<typeof LicenseLetterListSchema.parse>["items"][number]) {
  return [...letter.revisions].sort((left, right) => right.revNo - left.revNo)[0];
}
test("W513授权：真实PDF、更正缺字体失败、原版次重新生成及作废重出保留历史", async ({ page }) => {
  test.setTimeout(180_000);
  const prepared = await bridge<Prepared>("prepare"),
    errors = recordErrors(page);
  expect(typeof prepared.alreadyPrepared).toBe("boolean");
  const rendered = await bridge<Rendered>("render");
  expect(rendered.failed).toBe(false);
  expect(rendered.technicalTestCertificate).toBe(true);
  await ensureLiveStepUp(page);
  await openOrder(page, prepared.license, "授权与下载");
  const letters = await readLicenses(page, prepared.license.itemId);
  expect(letters.items).toHaveLength(1);
  const initial = letters.items[0]!;
  expect(initial.currentRevision?.renderStatus).toBe("ready");
  const order = AdminOrderDetailSchema.parse(
    await apiData(page.request, `/api/v1/admin/orders/${prepared.license.orderId}`),
  );
  const title = order.items.find((row) => row.orderItemId === prepared.license.itemId)!.dramaTitle;
  const region = page.getByRole("region", { name: `${title}授权书`, exact: true });
  const article = region.locator("article").filter({
    has: page.getByText(`${initial.letterNo} · ${initial.accountName}`, { exact: true }),
  });
  await expect(article).toHaveCount(1);
  await expect(article.getByRole("button", { name: "下载当前授权PDF", exact: true })).toBeEnabled();
  const initialPdf = await pdfProof(page, article, initial, rendered.proof);
  await shot(page, "w513-p2-04-license-initial", article.getByText(/当前可用PDF：/));
  await bridge("change-license-input");
  await licenseMutation(page, article, "correct", {
    letterId: initial.licenseLetterId,
    revisionId: initial.currentRevision!.licenseLetterRevisionId,
  });
  const correctedList = await readLicenses(page, prepared.license.itemId),
    corrected = correctedList.items.find((row) => row.licenseLetterId === initial.licenseLetterId)!;
  const correctedLatest = latestRevision(corrected)!;
  expect(correctedLatest.reason).toBe("correction");
  expect(correctedLatest.renderStatus).toBe("queued");
  expect(correctedLatest.licenseLetterRevisionId).not.toBe(
    initial.currentRevision!.licenseLetterRevisionId,
  );
  expect(corrected.currentRevision?.licenseLetterRevisionId).toBe(
    initial.currentRevision!.licenseLetterRevisionId,
  );
  expect(corrected.currentRevision?.renderStatus).toBe("ready");
  await expect(article.getByText(/最新生成版次：/)).toContainText(
    `第${correctedLatest.revNo}版 · 等待生成`,
  );
  await expect(article.getByText(/当前可用PDF：/)).toContainText(
    `第${initial.currentRevision!.revNo}版`,
  );
  await expect(article.getByRole("button", { name: "下载当前授权PDF", exact: true })).toBeEnabled();
  const failed = await bridge<Rendered>("fail-render");
  expect(failed.failed).toBe(true);
  expect(failed.processedRevisionIds).toEqual([correctedLatest.licenseLetterRevisionId]);
  await region.getByRole("button", { name: "刷新授权状态", exact: true }).click();
  await expect(article).toContainText("生成失败");
  await expect(article).toContainText("已尝试4次");
  await expect(article.getByText(/最新生成版次：/)).toContainText(
    `第${correctedLatest.revNo}版 · 生成失败 · 已尝试4次`,
  );
  await expect(article).toContainText(
    `最新生成失败，当前可用PDF仍为第${initial.currentRevision!.revNo}版`,
  );
  await expect(article.getByRole("button", { name: "下载当前授权PDF", exact: true })).toBeEnabled();
  const failedLetter = (await readLicenses(page, prepared.license.itemId)).items.find(
    (row) => row.licenseLetterId === initial.licenseLetterId,
  )!;
  const failedLatest = latestRevision(failedLetter)!;
  expect(failedLatest).toMatchObject({
    licenseLetterRevisionId: correctedLatest.licenseLetterRevisionId,
    renderStatus: "failed",
    renderAttemptNo: 4,
    fileId: null,
  });
  expect(failedLatest.actions).toContain("rerender");
  expect(failedLetter.currentRevision?.licenseLetterRevisionId).toBe(
    initial.currentRevision!.licenseLetterRevisionId,
  );
  expect(failedLetter.currentRevision?.renderStatus).toBe("ready");
  const fallbackPdf = await pdfProof(page, article, failedLetter, failed.proof);
  expect(fallbackPdf).toEqual(initialPdf);
  await shot(page, "w513-p2-05-license-failed", article.getByText(/最新生成版次：/));
  await licenseMutation(page, article, "rerender", {
    letterId: initial.licenseLetterId,
    revisionId: failedLatest.licenseLetterRevisionId,
  });
  const queued = (await readLicenses(page, prepared.license.itemId)).items.find(
    (row) => row.licenseLetterId === initial.licenseLetterId,
  )!;
  expect(latestRevision(queued)?.licenseLetterRevisionId).toBe(
    failedLatest.licenseLetterRevisionId,
  );
  expect(latestRevision(queued)?.renderStatus).toBe("queued");
  expect(queued.currentRevision?.licenseLetterRevisionId).toBe(
    initial.currentRevision!.licenseLetterRevisionId,
  );
  expect(queued.currentRevision?.renderStatus).toBe("ready");
  const recovered = await bridge<Rendered>("render");
  expect(recovered.failed).toBe(false);
  await region.getByRole("button", { name: "刷新授权状态", exact: true }).click();
  await expect(article.getByRole("button", { name: "下载当前授权PDF", exact: true })).toBeEnabled();
  const ready = (await readLicenses(page, prepared.license.itemId)).items.find(
    (row) => row.licenseLetterId === initial.licenseLetterId,
  )!;
  expect(ready.currentRevision?.licenseLetterRevisionId).toBe(failedLatest.licenseLetterRevisionId);
  expect(ready.currentRevision?.renderStatus).toBe("ready");
  await expect(article.getByText(/当前可用PDF：/)).toContainText(
    `第${ready.currentRevision!.revNo}版 · PDF已就绪`,
  );
  await expect(article.getByText(/最新生成版次：/)).toContainText(
    `第${failedLatest.revNo}版 · PDF已就绪`,
  );
  const correctedPdf = await pdfProof(page, article, ready, recovered.proof);
  await article.locator("summary").click();
  await expect(article).toContainText("资料更正");
  await shot(page, "w513-p2-06-license-recovered-history", article.locator("summary"));
  await licenseMutation(page, article, "void", {
    letterId: initial.licenseLetterId,
    revisionId: ready.currentRevision!.licenseLetterRevisionId,
  });
  const afterVoid = await readLicenses(page, prepared.license.itemId),
    old = afterVoid.items.find((row) => row.licenseLetterId === initial.licenseLetterId)!;
  expect(old.status).toBe("voided");
  expect(old.currentRevision?.fileId).toBe(ready.currentRevision!.fileId);
  const replacement = afterVoid.items.find(
    (row) => row.licenseLetterId !== initial.licenseLetterId && row.status !== "voided",
  );
  expect(replacement).toBeTruthy();
  expect(replacement!.currentRevision).toBeNull();
  const replacementLatest = latestRevision(replacement!)!;
  expect(replacementLatest.renderStatus).toBe("queued");
  const finalRender = await bridge<Rendered>("render");
  expect(finalRender.failed).toBe(false);
  await region.getByRole("button", { name: "刷新授权状态", exact: true }).click();
  await expect(
    article.getByRole("button", { name: "下载当前授权PDF", exact: true }),
  ).toBeDisabled();
  await expect(article).toContainText("已作废");
  const finalList = await readLicenses(page, prepared.license.itemId),
    current = finalList.items.find((row) => row.licenseLetterId === replacement!.licenseLetterId)!;
  expect(current.currentRevision?.renderStatus).toBe("ready");
  expect(current.currentRevision?.licenseLetterRevisionId).toBe(
    replacementLatest.licenseLetterRevisionId,
  );
  const nextArticle = region.locator("article").filter({
    has: page.getByText(`${current.letterNo} · ${current.accountName}`, { exact: true }),
  });
  await expect(nextArticle).toHaveCount(1);
  await expect(nextArticle.getByText(/当前可用PDF：/)).toContainText(
    `第${current.currentRevision!.revNo}版 · PDF已就绪`,
  );
  await expect(
    nextArticle.getByRole("button", { name: "下载当前授权PDF", exact: true }),
  ).toBeEnabled();
  const replacementPdf = await pdfProof(page, nextArticle, current, finalRender.proof);
  if (
    !(await article.locator("details").evaluate((element) => (element as HTMLDetailsElement).open))
  )
    await article.locator("summary").click();
  await shot(page, "w513-p2-07-license-void-history", article.locator("summary"));
  await shot(page, "w513-p2-08-license-current", nextArticle.getByText(/当前可用PDF：/));
  writeFileSync(
    "dist/e2e-shots/w513-p2-license-pdf-proof.json",
    `${JSON.stringify({ technicalTestCertificate: true, initialPdf, fallbackPdf, correctedPdf, replacementPdf, letters: finalRender.proof.letters })}\n`,
  );
  expect(errors).toEqual([]);
  const cleanup = await bridge<{ cleanedFiles: number }>("cleanup");
  expect(cleanup.cleanedFiles).toBeGreaterThanOrEqual(0);
});
