import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  BatchUploadCredentialsSchema,
  UploadBatchDetailSchema,
  UploadBatchItemSchema,
  DeliveryTicketDetailSchema,
  InspectEpisodesResultSchema,
} from "@liyoxi/contract";
import { liveContext, noHorizontalScroll, recordErrors } from "./live-context";
import { liveChildEnv, liveChildFailure } from "./live-child-env";
import {
  apiData,
  attachKnownMedia,
  deliveryFixture,
  deliveryVideo,
  knownFile,
  managerLogin,
} from "./live-delivery-fixture";
import { ensureLiveStepUp } from "./live-step-up";
import {
  createMultipartUploadAdapter,
  type MultipartUploadGrant,
} from "../../src/lib/upload-multipart";
import { planInput } from "../../src/features/delivery/ticket-detail/model";
interface Actor {
  staffId: string;
  name: string;
  roleKey: string;
  phone: string;
  password: string;
  recoveryCodes: string[];
}
interface Fixture {
  editor: Actor;
  publisher: Actor;
  paused: { ticketId: string; ticketNo: string; scope: { orderId: string; itemId: string } };
}
function fixture() {
  return (
    liveContext().fixtures as {
      fixtures: {
        w513: Fixture;
        staff: { staff: { id: string; roleKey: string; status: string }[] };
      };
    }
  ).fixtures;
}
const adminHeaders = () => ({
  "X-LYX-Admin": "1",
  Origin: liveContext().origin,
  "X-Client-Version": "1.0.0",
});
async function write(page: Page, path: string, body: unknown, method: "post" | "put" = "post") {
  const response = await page.request[method](path, {
    data: body,
    headers: { ...adminHeaders(), "Idempotency-Key": crypto.randomUUID() },
  });
  expect(response.status(), path).toBe(200);
  return (await response.json()).data;
}
const ticket = async (page: Page, id: string) =>
  DeliveryTicketDetailSchema.parse(
    await apiData(page.request, `/api/v1/admin/delivery-tickets/${id}`),
  );
async function select(page: Page, modal: Locator, label: string, value: string) {
  await modal.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByTitle(value, { exact: true }).click();
}
async function confirm(page: Page, name: string, fill?: (modal: Locator) => Promise<void>) {
  await page.getByRole("button", { name, exact: true }).click();
  const modal = page.getByRole("dialog", { name, exact: true });
  await expect(modal).toBeVisible();
  if (fill) await fill(modal);
  await modal.getByRole("checkbox", { name: "我已核对当前对象、内容与影响", exact: true }).check();
  await modal.getByRole("button", { name: "确认操作", exact: true }).click();
  await expect(modal).toHaveCount(0);
}
async function login(
  page: Page,
  actor: { name: string; phone: string; password: string; recoveryCode: string },
  redirect: string,
) {
  await page.goto(`/login?redirect=${encodeURIComponent(redirect)}`);
  await page.getByLabel("手机号", { exact: true }).fill(actor.phone);
  await page.getByLabel("密码", { exact: true }).fill(actor.password);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("radio", { name: "恢复码", exact: true }).check();
  await page.getByRole("textbox", { name: "恢复码", exact: true }).fill(actor.recoveryCode);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "用户菜单" })).toContainText(actor.name);
}
function bridge(
  action: "render" | "pause" | "withdraw" | "cleanup-docs",
  requestId?: string,
): Promise<Record<string, unknown>> {
  const context = process.env.LYX_ADMIN_LIVE_CONTEXT;
  if (!context) throw new Error("W513缺少本轮context");
  return new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      [
        "--silent",
        "--filter",
        "@liyoxi/services",
        "exec",
        "tsx",
        "scripts/admin-live-w513.ts",
        "--context",
        context,
        "--action",
        action,
        ...(requestId ? ["--request-id", requestId] : []),
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
      output = `${output}${bytes}`.slice(-16384);
    });
    child.stderr.on("data", (bytes) => {
      error = `${error}${bytes}`.slice(-4096);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const failure = liveChildFailure("W513本轮owner桥失败", error);
        for (const line of error.split("\n")) {
          try {
            const record = JSON.parse(line);
            if (
              record.evt === "w513.bridge.failed" &&
              /^[a-z_]+$/.test(record.phase) &&
              /^[A-Z_]+$/.test(record.symbol)
            )
              failure.message += `（${record.phase}:${record.symbol}）`;
          } catch {
            /* Only fixed safe diagnostics are accepted. */
          }
        }
        return reject(failure);
      }
      try {
        resolve(JSON.parse(output));
      } catch {
        reject(new Error("W513本轮owner桥无明确回执"));
      }
    });
  });
}
async function checklist(page: Page, code: string) {
  const templates = await apiData(
    page.request,
    `/api/v1/admin/checklist-templates?code=${code}&status=active`,
  );
  const current = templates.items.find((row: { code: string }) => row.code === code);
  expect(current).toBeTruthy();
  return {
    checklistVersionNo: current.versionNo,
    results: current.items.map((row: { key: string }) => ({ key: row.key, result: "pass" })),
  };
}

async function m5Shot(page: Page, name: string, focus?: Locator) {
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
    if (focus) await focus.scrollIntoViewIfNeeded();
    mkdirSync("dist/e2e-shots", { recursive: true });
    // Same fixed 10s exact-byte proof as actual W514; no masks or comparison tolerance.
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
          if (second.equals(first)) {
            stable = second;
            return true;
          }
          return false;
        },
        { timeout: 10_000, intervals: [100], message: `${name}两帧稳定` },
      )
      .toBe(true);
    if (!stable) throw new Error("W513未取得两帧一致截图");
    writeFileSync(`dist/e2e-shots/${name}.png`, stable);
  } finally {
    await page.setViewportSize({ width: 1366, height: 768 });
  }
}

/** Same real batch transport as the app; only the existing local COS test host is remapped. */
async function prepareMasters(page: Page) {
  const f = deliveryFixture("w513"),
    facts = await ticket(page, f.scope.ticketId);
  const materials = await apiData(
    page.request,
    `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/materials`,
  );
  if (materials.masters.length === 2) return;
  expect(materials.masters).toEqual([]);
  const bytes = deliveryVideo().bytes;
  let batch = UploadBatchDetailSchema.parse(
    await write(page, "/api/v1/admin/upload-batches", {
      purpose: "drama_master",
      targetId: facts.orderItem.dramaId,
      scope: "partial",
      replaceReason: "quality_fix",
      isContentChanged: false,
      files: [1, 2].map((n) => ({
        clientToken: crypto.randomUUID(),
        originalName: `第${n}集.mp4`,
        sizeBytes: String(bytes.length),
      })),
    }),
  );
  expect(batch.targetId).toBe(facts.orderItem.dramaId);
  batch = UploadBatchDetailSchema.parse(
    await write(page, `/api/v1/admin/upload-batches/${batch.uploadBatchId}/start`, {
      acceptSequenceSuggestion: false,
    }),
  );
  const bridgeOrigin = (liveContext().fixtures as { w302BridgeOrigin: string }).w302BridgeOrigin;
  const uploadFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (
      ["test-media-1250000000.cos.ap-test-1.myqcloud.com", "fake-storage.invalid"].includes(
        url.hostname,
      )
    ) {
      const target = new URL(bridgeOrigin);
      target.pathname =
        url.hostname === "fake-storage.invalid" ? `/fake-read${url.pathname}` : url.pathname;
      target.search = url.search;
      return fetch(target, init);
    }
    if (url.origin !== "http://127.0.0.1:9100") throw new Error("W513原片只接受本轮本地存储");
    return fetch(input, init);
  };
  for (const item of batch.items) {
    const grant = async (): Promise<MultipartUploadGrant> => {
      const issued = BatchUploadCredentialsSchema.parse(
        await write(
          page,
          `/api/v1/admin/upload-batches/${batch.uploadBatchId}/refresh-credentials`,
          {},
        ),
      );
      expect(issued.prefix).toBe(batch.prefix);
      expect(item.uploadKey?.startsWith(batch.prefix)).toBe(true);
      const base = {
        fileId: item.fileId,
        bucket: issued.bucket,
        region: issued.region,
        key: item.uploadKey!,
        prefix: issued.prefix,
        expiresAt: issued.expiresAt,
      };
      if (issued.mode === "post") {
        const post = issued.posts.find((row) => row.fileId === item.fileId);
        expect(post?.key).toBe(item.uploadKey);
        if (!post) throw new Error("W513原片表单缺失");
        return {
          ...base,
          mode: "post",
          post: post.post,
          sts: null,
          chunkSize: null,
          chunkParallel: null,
        };
      }
      return {
        ...base,
        mode: "multipart",
        post: null,
        sts: issued.sts,
        chunkSize: issued.chunkSize,
        chunkParallel: issued.chunkParallel,
      };
    };
    const adapter = createMultipartUploadAdapter({
      fetchImpl: uploadFetch,
      ports: {
        register: grant,
        refresh: grant,
        complete: async () => {
          const value = UploadBatchItemSchema.parse(
            await write(
              page,
              `/api/v1/admin/upload-batch-items/${item.uploadBatchItemId}/complete`,
              {},
            ),
          );
          return { fileId: value.fileId, status: value.fileStatus };
        },
        get: async () => {
          const value = await apiData(page.request, `/api/v1/admin/files/${item.fileId}`);
          expect(value.fileId).toBe(item.fileId);
          return { fileId: value.fileId, status: value.status };
        },
        cancel: async () =>
          write(page, `/api/v1/admin/upload-batches/${batch.uploadBatchId}/cancel`, {}),
      },
    });
    try {
      await adapter.upload(
        new File([Uint8Array.from(bytes)], item.originalName, { type: "video/mp4" }),
        { onProgress: () => {} },
      );
    } finally {
      adapter.close();
    }
  }
  await expect
    .poll(
      async () =>
        (await apiData(page.request, `/api/v1/admin/upload-batches/${batch.uploadBatchId}`)).state,
      { timeout: 60_000 },
    )
    .toBe("ready");
  const committed = await write(
    page,
    `/api/v1/admin/upload-batches/${batch.uploadBatchId}/commit`,
    {},
  );
  expect(committed.masters).toHaveLength(2);
  const ready = await apiData(
    page.request,
    `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/materials`,
  );
  expect(ready.masters.map((row: { episodeNo: number }) => row.episodeNo)).toEqual([1, 2]);
}

test("W513既有工单：真实暂停/首次指派/停用与own范围拒绝/重新求值，正式撤回收尾", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const f = fixture().w513,
    errors = recordErrors(page);
  let requestId: string | undefined;
  const cleanupFailures: unknown[] = [];
  const context = await browser.newContext({
    baseURL: liveContext().origin,
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1366, height: 768 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  try {
    await ensureLiveStepUp(page);
    await prepareMasters(page);
    const source = await bridge("pause");
    expect(source).toMatchObject({ ticketId: f.paused.ticketId, paused: true });
    requestId = String(source.requestId);
    await ensureLiveStepUp(page);
    await page.goto(`/delivery/tickets/${f.paused.ticketNo}?tab=actions`);
    await expect(page.getByText("工单暂停中", { exact: true })).toBeVisible();
    await expect(page.getByText(/取消审批中/).first()).toBeVisible();
    await confirm(page, "指派或改派剪辑师", async (modal) => {
      await select(page, modal, "剪辑师", f.editor.name);
      await expect(modal.getByRole("combobox", { name: "指派原因", exact: true })).toHaveCount(0);
      await m5Shot(page, "w513-01-assign-paused");
    });
    await confirm(page, "改派发布专员", async (modal) =>
      select(page, modal, "发布专员", f.publisher.name),
    );
    const actual = await ticket(page, f.paused.ticketId);
    expect(actual.editor?.staffId).toBe(f.editor.staffId);
    expect(actual.publisher?.staffId).toBe(f.publisher.staffId);
    expect(actual.isPaused).toBe(true);
    expect(actual.pauses).toEqual([
      expect.objectContaining({ reason: "cancel_review", refId: source.approvalId }),
    ]);
    const disabled = fixture().staff.staff.find(
      (row) => row.roleKey === "editor" && row.status === "disabled",
    )!;
    const invalid = await page.request.post(
      `/api/v1/admin/delivery-tickets/${actual.deliveryTicketId}/assign-editor`,
      {
        data: { staffId: disabled.id, reasonCode: "other", note: "停用候选负例" },
        headers: { ...adminHeaders(), "Idempotency-Key": crypto.randomUUID() },
      },
    );
    expect(invalid.status()).toBe(409);
    expect(await invalid.json()).toMatchObject({ error: "ASSIGNEE_INVALID" });
    expect((await ticket(page, actual.deliveryTicketId)).editor?.staffId).toBe(f.editor.staffId);
    const blocked = await page.request.post(
      `/api/v1/admin/delivery-tickets/${actual.deliveryTicketId}/materials/download-urls`,
      { data: { kind: "master", episodeNos: [1] }, headers: adminHeaders() },
    );
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: "MATERIAL_NOT_AVAILABLE",
      details: { reason: "master_not_ready" },
    });
    const heldWrite = await page.request.post(
      `/api/v1/admin/delivery-tickets/${actual.deliveryTicketId}/reissues`,
      {
        data: { episodeNos: [1], reasonCode: "other", note: "暂停真实写口拒绝" },
        headers: { ...adminHeaders(), "Idempotency-Key": crypto.randomUUID() },
      },
    );
    expect(heldWrite.status()).toBe(409);
    expect(await heldWrite.json()).toMatchObject({ error: "TICKET_ON_HOLD" });
    await confirm(page, "重新求值");
    await expect(page.getByText("工单仍在暂停，本次没有推进", { exact: true })).toBeVisible();
    expect((await ticket(page, actual.deliveryTicketId)).step).toBe(actual.step);
    await expect(page.getByRole("button", { name: "强制更正步骤", exact: true })).toHaveCount(0);
    await m5Shot(page, "w513-02-paused-sla-reevaluate");
    const editorPage = await context.newPage();
    await login(
      editorPage,
      { ...f.editor, recoveryCode: f.editor.recoveryCodes[0]! },
      `/delivery/tickets/${actual.ticketNo}?tab=actions`,
    );
    await expect(
      editorPage.getByRole("heading", { name: `工单 ${actual.ticketNo}`, exact: true }),
    ).toBeVisible();
    await expect(
      editorPage.getByRole("button", { name: "指派或改派剪辑师", exact: true }),
    ).toHaveCount(0);
    const other = await editorPage.request.get(
      `/api/v1/admin/delivery-tickets/${deliveryFixture("w513").scope.ticketId}`,
    );
    expect([403, 404]).toContain(other.status());
    const wrongMaterial = await editorPage.request.post(
      `/api/v1/admin/delivery-tickets/${deliveryFixture("w513").scope.ticketId}/materials/download-urls`,
      { data: { kind: "master", episodeNos: [1] }, headers: adminHeaders() },
    );
    expect(wrongMaterial.status()).toBe(404);
    expect(await wrongMaterial.json()).toMatchObject({ error: "NOT_FOUND" });
    const history = await apiData(
      page.request,
      `/api/v1/admin/delivery-tickets/${actual.deliveryTicketId}/activities?limit=50`,
    );
    expect(
      history.items.some((row: { summary: string }) => row.summary.includes("指派剪辑师")),
    ).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    try {
      await context.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (requestId)
      try {
        expect(await bridge("withdraw", requestId)).toMatchObject({
          ticketId: f.paused.ticketId,
          status: "not_executed",
          approvalStatus: "withdrawn",
          paused: false,
        });
      } catch (error) {
        cleanupFailures.push(error);
        console.info(error instanceof Error ? error.message : "W513清理失败");
      }
  }
  if (cleanupFailures.length) throw new AggregateError(cleanupFailures, "W513暂停用例未完整收尾");
  await page.reload();
  await expect(page.getByText("工单暂停中", { exact: true })).toHaveCount(0);
});

async function batchRegister(
  page: Page,
  f: ReturnType<typeof deliveryFixture>,
  episodeNos: number[],
  reissueId?: string,
) {
  await page.goto(`/delivery/tickets/${f.ticketNo}?tab=episodes`);
  await page.getByRole("button", { name: "登记成片", exact: true }).click();
  const modal = page.getByRole("dialog", { name: "登记成片", exact: true });
  if (reissueId) await expect(modal).toContainText("正在登记补发");
  await modal
    .getByLabel("选择成片文件", { exact: true })
    .setInputFiles(episodeNos.map((n) => knownFile(n === 1 ? "final_1" : "final_2")));
  const creation = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/admin/upload-batches",
  );
  await modal.getByRole("button", { name: "创建批次并核对", exact: true }).click();
  const created = await creation,
    envelope = await created.json(),
    symbol = /^[A-Z_]+$/.test(envelope.error) ? envelope.error : "unknown";
  expect(created.status(), `批次创建响应：${symbol}`).toBe(200);
  const batch = UploadBatchDetailSchema.parse(envelope.data);
  for (const n of episodeNos) {
    const name = knownFile(n === 1 ? "final_1" : "final_2").name,
      input = modal.getByLabel(`文件 ${name} 集号`, { exact: true });
    if ((await input.inputValue()) !== String(n)) {
      await input.fill(String(n));
      await modal
        .locator("[data-batch-item]")
        .filter({ hasText: name })
        .getByRole("button", { name: "修改集号", exact: true })
        .click();
    }
  }
  if (batch.coverage.needsSequenceConfirm)
    await modal
      .getByRole("checkbox", { name: "我已逐集核对，确认采用服务器给出的顺序建议" })
      .check();
  await modal.getByRole("button", { name: "确认匹配并开始上传", exact: true }).click();
  await expect(modal.getByRole("heading", { name: "可登记", exact: true })).toBeVisible({
    timeout: 60_000,
  });
  const sent = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname ===
        `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/episode-outputs`,
  );
  await modal.getByRole("button", { name: "登记成片文件", exact: true }).click();
  const body = (await sent).postDataJSON();
  expect(body).toEqual({ uploadBatchId: batch.uploadBatchId, ...(reissueId ? { reissueId } : {}) });
  await expect(modal).toHaveCount(0);
}

test("W513工单余下操作真实写读：强迁/求值、现签取料、发送与毫秒代录、返工、补发登记质检和发布", async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  const f = deliveryFixture("w513"),
    errors = recordErrors(page),
    consoleErrors: { text: string; url: string }[] = [],
    media = attachKnownMedia(page, "w513"),
    manager = managerLogin("w513");
  page.on("console", (message) => {
    if (message.type() === "error")
      consoleErrors.push({ text: message.text(), url: message.location().url });
  });
  const context = await browser.newContext({
    baseURL: liveContext().origin,
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1366, height: 768 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
  });
  const cleanupFailures: unknown[] = [];
  try {
    await ensureLiveStepUp(page);
    await prepareMasters(page);
    const managerPage = await context.newPage();
    await login(managerPage, manager, `/delivery/tickets/${f.ticketNo}?tab=sample`);
    await write(page, `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/assign-manager`, {
      staffId: f.scope.managerId,
    });
    await page.goto(`/delivery/tickets/${f.ticketNo}?tab=actions`);
    const changedDate = new Date(`${f.launchDate}T00:00:00Z`);
    changedDate.setUTCDate(changedDate.getUTCDate() + 1);
    await confirm(page, "调整约定上线日", async (modal) => {
      await modal
        .getByLabel("新的约定上线日", { exact: true })
        .fill(changedDate.toISOString().slice(0, 10));
      await modal
        .getByRole("textbox", { name: "处理说明", exact: true })
        .fill("根据本轮商家营业安排调整一天");
    });
    let current = await ticket(page, f.scope.ticketId);
    expect(current.orderItem.agreedLaunchDate).toBe(changedDate.toISOString().slice(0, 10));
    const plan = await apiData(page.request, `/api/v1/admin/delivery-plans/${f.planId}`),
      content = planInput(plan);
    content.items[0]!.agreedLaunchDate = changedDate.toISOString().slice(0, 10);
    content.items[0]!.expectedDeliveryDate = f.deliveryDate;
    await write(
      page,
      `/api/v1/admin/delivery-plans/${f.planId}/draft`,
      { draftLockVersion: plan.draftLockVersion, content },
      "put",
    );
    const saved = await apiData(page.request, `/api/v1/admin/delivery-plans/${f.planId}`);
    await write(page, `/api/v1/admin/delivery-plans/${f.planId}/push`, {
      draftLockVersion: saved.draftLockVersion,
    });
    await page.reload();
    await confirm(page, "催办商家");
    await expect(page.getByRole("button", { name: "催办商家", exact: true })).toHaveCount(0);
    await apiData(
      page.request,
      `/api/v1/m/delivery-plans/${f.planId}/confirm`,
      { versionNo: 1 },
      f.ownerHeaders,
    );
    await page.reload();
    current = await ticket(page, f.scope.ticketId);
    expect(current.step).toBe("sample_making");
    // A formal whitelist entry still has to satisfy the existing structural invariants.
    await page.getByRole("button", { name: "强制更正步骤", exact: true }).click();
    const correction = page.getByRole("dialog", { name: "强制更正步骤", exact: true });
    await select(page, correction, "更正至步骤", "广告准备");
    await correction
      .getByRole("textbox", { name: "更正原因（至少10字）", exact: true })
      .fill("本轮保留广告已就绪时不能停在广告准备的真实反例");
    await correction
      .getByRole("textbox", { name: "请输入完整工单号", exact: true })
      .fill(f.ticketNo);
    await correction
      .getByRole("checkbox", { name: "我已核对当前对象、内容与影响", exact: true })
      .check();
    const rejected = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/delivery-tickets/${f.scope.ticketId}/force-transition`),
    );
    await correction.getByRole("button", { name: "确认操作", exact: true }).click();
    const rejection = await rejected;
    expect(rejection.request().method()).toBe("POST");
    expect(rejection.status()).toBe(409);
    expect(await rejection.json()).toMatchObject({
      error: "CORRECTION_NOT_ALLOWED",
      details: { failedInvariants: ["delivery.I3.ads"] },
    });
    await expect(correction).toContainText("该更正不满足当前结构条件");
    await m5Shot(page, "w513-03-force-confirm");
    const expectedResourceError =
      "Failed to load resource: the server responded with a status of 409 (Conflict)";
    await expect
      .poll(() => consoleErrors)
      .toEqual([{ text: expectedResourceError, url: rejection.url() }]);
    expect(errors).toEqual([expectedResourceError]);
    // Consume only this verified I3 negative response; earlier or later extra errors still fail.
    consoleErrors.splice(0, 1);
    errors.splice(0, 1);
    const unchanged = await ticket(page, f.scope.ticketId);
    expect(unchanged.step).toBe(current.step);
    expect(unchanged.lockVersion).toBe(current.lockVersion);
    await correction.getByRole("button", { name: "重新读取并核对", exact: true }).click();
    await expect(correction).toHaveCount(0);
    const noMove = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/delivery-tickets/${f.scope.ticketId}/reevaluate`),
    );
    await confirm(page, "重新求值");
    expect((await (await noMove).json()).data).toMatchObject({
      skippedReason: null,
      transitions: [],
    });
    await m5Shot(page, "w513-04-reevaluated-materials");
    for (let round = 1; round <= 2; round++) {
      const signing = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith(`/delivery-tickets/${f.scope.ticketId}/materials/download-urls`),
      );
      await page.getByRole("button", { name: "取第 1 集原片", exact: true }).click();
      const signed = (await (await signing).json()).data.items[0];
      const original = new URL(signed.url);
      let readUrl = original;
      if (original.origin !== "http://127.0.0.1:9100") {
        expect(original.origin).toBe("https://fake-storage.invalid");
        readUrl = new URL(
          (liveContext().fixtures as { w302BridgeOrigin: string }).w302BridgeOrigin,
        );
        readUrl.pathname = `/fake-read${original.pathname}`;
        readUrl.search = original.search;
      }
      const bytes = await fetch(readUrl);
      expect(bytes.status).toBe(200);
      expect(
        createHash("sha256")
          .update(Buffer.from(await bytes.arrayBuffer()))
          .digest("hex"),
      ).toBe(deliveryVideo().manifest.sha256);
      const materials = await apiData(
        page.request,
        `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/materials`,
      );
      expect(
        materials.masters.find((row: { episodeNo: number }) => row.episodeNo === 1).myLastCheckout
          .checkoutCount,
      ).toBe(round);
    }
    await page.getByRole("tab", { name: "样片与质检", exact: true }).click();
    await page.getByRole("button", { name: "上传样片", exact: true }).click();
    const upload = page.getByRole("dialog", { name: "上传样片", exact: true });
    await upload.locator('input[type="file"]').setInputFiles(knownFile("sample"));
    await expect(upload.getByRole("button", { name: "登记样片", exact: true })).toBeEnabled({
      timeout: 30_000,
    });
    await media.settled();
    await upload.getByRole("button", { name: "登记样片", exact: true }).click();
    await expect(upload).toHaveCount(0);
    const production = await apiData(
      page.request,
      `/api/v1/admin/production-records?orderItemId=${f.scope.itemId}`,
    );
    const sampleFile = production.items.find((row: { kind: string }) => row.kind === "sample");
    expect(sampleFile).toBeTruthy();
    const readySample = async () => {
      const value = (await ticket(page, f.scope.ticketId)).currentSample!;
      await write(
        managerPage,
        `/api/v1/admin/samples/${value.sampleId}/inspect`,
        await checklist(managerPage, "qc.sample"),
      );
      await write(managerPage, `/api/v1/admin/samples/${value.sampleId}/push`, {});
      return (await ticket(page, f.scope.ticketId)).currentSample!;
    };
    let sample = await readySample();
    await page.goto(`/delivery/tickets/${f.ticketNo}?tab=actions`);
    await confirm(page, "强制更正步骤", async (modal) => {
      await select(page, modal, "更正至步骤", "样片制作");
      await modal
        .getByRole("textbox", { name: "更正原因（至少10字）", exact: true })
        .fill("本轮核对当前已推送样片后进行合法回退再重新求值");
      await modal.getByRole("textbox", { name: "请输入完整工单号", exact: true }).fill(f.ticketNo);
      await m5Shot(page, "w513-03b-force-valid");
    });
    expect((await ticket(page, f.scope.ticketId)).step).toBe("sample_making");
    const evaluated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/delivery-tickets/${f.scope.ticketId}/reevaluate`),
    );
    await confirm(page, "重新求值");
    expect((await (await evaluated).json()).data).toMatchObject({
      skippedReason: null,
      transitions: [],
    });
    expect((await ticket(page, f.scope.ticketId)).step).toBe("sample_making");
    // Reevaluation does not replay sample.pushed after a deliberate correction.
    // A new sample must pass the existing registration, QC and push writers.
    const correctedSample = sample;
    await write(page, `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/samples`, {
      fileId: sampleFile.productionRecordId,
      adSlots: [],
    });
    sample = await readySample();
    expect(sample.sampleId).not.toBe(correctedSample.sampleId);
    expect(sample.versionNo).toBe(correctedSample.versionNo + 1);
    expect((await ticket(page, f.scope.ticketId)).step).toBe("sample_confirm");
    await page.reload();
    await confirm(page, "登记企业微信发送");
    expect((await ticket(page, f.scope.ticketId)).currentSample?.offlineSentAt).not.toBeNull();
    let feedbackPosts = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith(`/samples/${sample.sampleId}/request-change`)
      )
        feedbackPosts++;
    });
    await page.getByRole("button", { name: "代录样片修改意见", exact: true }).click();
    const feedback = page.getByRole("dialog", { name: "代录样片修改意见", exact: true });
    await feedback
      .getByRole("textbox", { name: "修改意见", exact: true })
      .fill("请修正本轮字幕转场的定位内容");
    await feedback.getByLabel("时间点（毫秒，可选）", { exact: true }).fill("1250");
    await m5Shot(page, "w513-05-sample-feedback-time");
    await feedback
      .getByRole("checkbox", { name: "我已核对当前对象、内容与影响", exact: true })
      .check();
    await feedback.getByRole("button", { name: "确认操作", exact: true }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect(feedback).toHaveCount(0);
    expect(feedbackPosts).toBe(1);
    expect((await ticket(page, f.scope.ticketId)).step).toBe("sample_making");
    const registerExisting = async () => {
      await write(page, `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/samples`, {
        fileId: sampleFile.productionRecordId,
        adSlots: [],
      });
      sample = await readySample();
      await apiData(
        page.request,
        `/api/v1/m/samples/${sample.sampleId}/confirm`,
        { versionNo: sample.versionNo, viewedVia: "weapp", hasViewed: true },
        f.ownerHeaders,
      );
    };
    await registerExisting();
    await page.reload();
    await confirm(page, "返工", async (modal) =>
      modal
        .getByRole("textbox", { name: "处理说明", exact: true })
        .fill("本轮返工重新核对字幕排版"),
    );
    expect((await ticket(page, f.scope.ticketId)).step).toBe("sample_making");
    await registerExisting();
    const bridgeOrigin = (liveContext().fixtures as { w302BridgeOrigin: string }).w302BridgeOrigin;
    for (const hostname of [
      "test-media-1250000000.cos.ap-test-1.myqcloud.com",
      "fake-storage.invalid",
    ])
      await page.route(`https://${hostname}/**`, async (route) => {
        const original = new URL(route.request().url()),
          target = new URL(bridgeOrigin);
        target.pathname =
          hostname === "fake-storage.invalid"
            ? `/fake-read${original.pathname}`
            : original.pathname;
        target.search = original.search;
        await route.fulfill({ response: await route.fetch({ url: target.toString() }) });
      });
    await batchRegister(page, f, [1, 2]);
    const grid = await apiData(
        managerPage.request,
        `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/episode-outputs`,
      ),
      checks = await checklist(managerPage, "qc.episode");
    await write(
      managerPage,
      `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/inspect-episodes`,
      {
        episodeOutputIds: grid.episodes.map(
          (row: { latest: { episodeOutputId: string } }) => row.latest.episodeOutputId,
        ),
        checklistVersionNo: checks.checklistVersionNo,
        defaultResults: checks.results,
        exceptions: [],
      },
    );
    await write(
      managerPage,
      `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/inspect-package`,
      await checklist(managerPage, "qc.package"),
    );
    expect((await ticket(page, f.scope.ticketId)).step).toBe("delivering");
    expect(await bridge("render")).toMatchObject({
      ticketId: f.scope.ticketId,
      ready: true,
      signMode: "platform_cert",
      technicalTestCertificate: true,
    });
    await write(page, `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/push-package`, {
      precheck: await checklist(page, "delivery.precheck"),
    });
    current = await ticket(page, f.scope.ticketId);
    expect(current.step).toBe("awaiting_launch");
    expect(current.release?.kind).toBe("initial");
    const createReissue = async () => {
      await page.goto(`/delivery/tickets/${f.ticketNo}?tab=actions`);
      await confirm(page, "发起补发", async (modal) => {
        await modal.getByRole("combobox", { name: "补发原因", exact: true }).click();
        await page
          .locator(".ant-select-dropdown:visible .ant-select-item-option-content")
          .first()
          .click();
        await modal.getByRole("checkbox", { name: "第 1 集", exact: true }).check();
        await modal
          .getByRole("textbox", { name: "处理说明", exact: true })
          .fill("本轮更正第1集字幕后正式补发");
      });
      return (await ticket(page, f.scope.ticketId)).openReissue!;
    };
    await createReissue();
    await confirm(page, "取消补发", async (modal) =>
      modal.getByRole("textbox", { name: "处理说明", exact: true }).fill("本轮取消第一次演练补发"),
    );
    expect((await ticket(page, f.scope.ticketId)).openReissue).toBeNull();
    const reissue = await createReissue();
    await batchRegister(page, f, [1], reissue.reissueId);
    await managerPage.goto(`/delivery/tickets/${f.ticketNo}?tab=episodes`);
    await managerPage.getByRole("button", { name: "逐集质检", exact: true }).click();
    const qc = managerPage.getByRole("dialog", { name: "逐集质检", exact: true }),
      qcChecks = qc.locator(".lyx-checklist").getByRole("checkbox");
    await expect(qcChecks.first()).toBeVisible();
    await expect(qcChecks).toHaveCount(checks.results.length);
    for (const check of await qcChecks.all()) await check.check();
    await expect(qc.getByRole("combobox", { name: "单集例外", exact: true })).toBeVisible();
    const submitInspection = qc.getByRole("button", { name: "提交质检", exact: true });
    await expect(submitInspection).toBeEnabled();
    const inspected = managerPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/api/v1/admin/delivery-tickets/${f.scope.ticketId}/inspect-episodes`,
    );
    await submitInspection.click();
    const inspectedResponse = await inspected;
    expect(inspectedResponse.status()).toBe(200);
    const inspection = InspectEpisodesResultSchema.parse((await inspectedResponse.json()).data);
    await expect(qc).toHaveCount(0);
    const freshReissue = (await ticket(page, f.scope.ticketId)).openReissue!;
    expect(inspection.results.map((row) => row.episodeOutputId)).toEqual(
      freshReissue.replacements.map((row) => row.episodeOutputId),
    );
    expect(inspection.results.map((row) => row.verdict)).toEqual(["pass"]);
    expect(freshReissue.replacements.map((row) => row.status)).toEqual(["qc_passed"]);
    await page.goto(`/delivery/tickets/${f.ticketNo}?tab=actions`);
    const currentReissue = page.locator(".lyx-production-card").filter({
      has: page.getByRole("heading", { name: "当前补发", exact: true }),
    });
    await expect(currentReissue).toContainText("第 1 集 · 已质检通过");
    await expect(page.getByRole("button", { name: "发布补发", exact: true })).toBeVisible();
    const productionFacts = page.locator(".lyx-production-card").filter({
      has: page.getByRole("heading", { name: "制作事实与人工处理", exact: true }),
    });
    await expect(productionFacts.locator(".lyx-m5-record").first()).toBeVisible();
    await expect(productionFacts).toContainText("已就绪");
    await expect(
      productionFacts.getByRole("button", { name: "刷新制作事实", exact: true }),
    ).toBeEnabled();
    await m5Shot(page, "w513-06-reissue-production");
    const actualProductionRecord = productionFacts.locator(".lyx-m5-record").first();
    await actualProductionRecord.scrollIntoViewIfNeeded();
    await m5Shot(page, "w513-06b-production-facts", actualProductionRecord);
    const reissuePrecheck = await checklist(page, "delivery.precheck");
    expect(reissuePrecheck.results.length).toBeGreaterThan(0);
    await confirm(page, "发布补发", async (modal) => {
      const precheckBoxes = modal.locator("fieldset").getByRole("checkbox");
      await expect(precheckBoxes.first()).toBeVisible();
      await expect(precheckBoxes).toHaveCount(reissuePrecheck.results.length);
      for (const check of await precheckBoxes.all()) await check.check();
    });
    current = await ticket(page, f.scope.ticketId);
    expect(current.openReissue).toBeNull();
    expect(current.release?.kind).toBe("reissue");
    await expect(page.getByText("制作事实与人工处理", { exact: true })).toBeVisible();
    await m5Shot(page, "w513-07-reissue-published");
    await noHorizontalScroll(page, "补发完成及制作事实");
    expect(consoleErrors).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    for (const close of [
      () => context.close(),
      () => media.cleanup(),
      () => bridge("cleanup-docs"),
    ]) {
      try {
        await close();
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
  }
  if (cleanupFailures.length)
    throw new AggregateError(cleanupFailures, "W513本轮制作/文书资源未完整清理");
});
