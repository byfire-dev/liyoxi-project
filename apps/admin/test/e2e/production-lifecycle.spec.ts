// 样例项目的真实组件探针；所有业务 API 显式 stub，不访问 PG/Redis/MinIO 或外网。
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import type { LifecycleProbe } from "./production-lifecycle.probe";

const appRoot = resolve(import.meta.dirname, "../..");
let server: ViteDevServer, origin: string;
let posts = 0;
test.beforeAll(async () => {
  server = await createServer({
    root: appRoot,
    configFile: resolve(appRoot, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**/dist/**"] } },
    plugins: [
      {
        name: "production-lifecycle-probe",
        configureServer(vite) {
          vite.middlewares.use("/__production_probe", async (_request, response, next) => {
            try {
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  "/__production_probe",
                  `<!doctype html><div id="root"></div><script type="module" src="/test/e2e/production-lifecycle.probe.tsx"></script>`,
                ),
              );
            } catch (error) {
              next(error);
            }
          });
          vite.middlewares.use("/__production_post", (request, response) => {
            if (request.method !== "POST") {
              response.statusCode = 405;
              response.end();
              return;
            }
            posts++;
            request.resume();
            request.on("end", () => {
              response.statusCode = 204;
              response.end();
            });
          });
          vite.middlewares.use("/__production_cos", (request, response) => {
            const url = new URL(request.url ?? "/", origin);
            const method = request.method;
            if (method === "POST" && url.searchParams.has("uploadId")) posts++;
            request.resume();
            request.on("end", () => {
              response.setHeader("Content-Type", "application/xml");
              if (method === "POST" && url.searchParams.has("uploads"))
                response.end(
                  "<InitiateMultipartUploadResult><UploadId>probe-upload</UploadId></InitiateMultipartUploadResult>",
                );
              else if (method === "PUT" && url.searchParams.has("partNumber")) {
                response.setHeader("ETag", '"probe-part"');
                response.end();
              } else if (method === "POST" && url.searchParams.has("uploadId"))
                response.end(
                  "<CompleteMultipartUploadResult><ETag>probe-complete</ETag></CompleteMultipartUploadResult>",
                );
              else {
                response.statusCode = 405;
                response.end();
              }
            });
          });
        },
      },
    ],
  });
  await server.listen();
  origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  await server?.close();
});

async function openProbe(page: Page, scenario: string) {
  const errors: string[] = [],
    remote: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith("/api/")) {
      remote.push(url.href);
      await route.abort();
    } else await route.continue();
  });
  await page.goto(`${origin}/__production_probe?scenario=${scenario}`);
  await expect(page.getByRole("dialog")).toBeVisible();
  return async () => {
    await page.evaluate(() => window.productionLifecycle.close());
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(remote).toEqual([]);
  };
}
async function snapshot(page: Page): Promise<ReturnType<LifecycleProbe["snapshot"]>> {
  return page.evaluate(() => window.productionLifecycle.snapshot());
}
async function change(page: Page, value: Parameters<LifecycleProbe["change"]>[0]) {
  await page.evaluate((value) => window.productionLifecycle.change(value), value);
}
const media = {
  name: "episode-1.mp4",
  mimeType: "video/mp4",
  buffer: Buffer.from("component-probe"),
};
async function startUpload(page: Page, kind: "sample" | "episode") {
  const count = (await snapshot(page)).registrations.length;
  await page.locator('input[type="file"]').setInputFiles(media);
  if (kind === "episode") {
    await page.getByRole("radio", { name: "部分集", exact: true }).check();
    await page.getByRole("button", { name: "创建批次并核对", exact: true }).click();
    await page.getByRole("button", { name: "确认匹配并开始上传", exact: true }).click();
  }
  await expect.poll(async () => (await snapshot(page)).registrations.length).toBe(count + 1);
  return count;
}
async function completeUpload(page: Page, index: number, kind: "sample" | "episode") {
  const before = posts;
  await page.evaluate((index) => window.productionLifecycle.release(index), index);
  await expect.poll(() => posts).toBe(before + 1);
  await expect
    .poll(async () => (await snapshot(page)).completed)
    .toContain((await snapshot(page)).registrations[index]!.fileId);
  await expect(
    page.getByRole("button", {
      name: kind === "sample" ? "登记样片" : "登记成片文件",
      exact: true,
    }),
  ).toBeEnabled();
}

test("样片或同 key 清单版本更新清除旧结论，预览 URL 更新保留已核对项", async ({ page }) => {
  const clean = await openProbe(page, "sample-qc");
  const submit = page.getByRole("button", { name: "提交质检", exact: true });
  let check = page.getByRole("checkbox", { name: "逐项核对画面", exact: true });
  await check.check();
  await change(page, "preview");
  await expect(check).toBeChecked();
  for (const identity of ["sample", "sample-version"] as const) {
    await change(page, identity);
    await expect(check).not.toBeChecked();
    await expect(submit).toBeDisabled();
    expect((await snapshot(page)).sent).toEqual([]);
    await check.check();
  }
  await change(page, "template");
  check = page.getByRole("checkbox", { name: "新版画面规则须重新核对", exact: true });
  await expect(check).not.toBeChecked();
  await expect(submit).toBeDisabled();
  expect((await snapshot(page)).sent).toEqual([]);
  await check.check();
  await submit.click();
  await expect.poll(async () => (await snapshot(page)).sent.length).toBe(1);
  expect((await snapshot(page)).sent[0]).toMatchObject({
    method: "inspectSample",
    id: "00000000-0000-7000-8000-000000000913",
    body: { checklistVersionNo: 2, results: [{ key: "picture", result: "pass" }] },
  });
  await clean();
});

test("剧集新输出重新选择实际目标并清除旧默认结论与单集例外", async ({ page }) => {
  const clean = await openProbe(page, "episode-qc");
  await page.getByRole("checkbox", { name: "逐项核对画面", exact: true }).check();
  await page.getByRole("combobox", { name: "单集例外", exact: true }).click();
  await page.getByTitle("第 1 集", { exact: true }).click();
  await page.keyboard.press("Escape");
  const exception = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "第 1 集例外", exact: true }) });
  await exception.getByRole("checkbox", { name: "逐项核对画面", exact: true }).check();
  await change(page, "preview");
  await expect(exception).toHaveCount(1);
  await change(page, "episode");
  await expect(page.getByRole("heading", { name: /集例外$/ })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "逐项核对画面", exact: true })).not.toBeChecked();
  await expect(page.getByRole("button", { name: "提交质检", exact: true })).toBeDisabled();
  await expect(page.locator(".ant-select").first()).toContainText("第 2 版");
  await page.getByRole("checkbox", { name: "逐项核对画面", exact: true }).check();
  await page.getByRole("button", { name: "提交质检", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).sent.length).toBe(1);
  expect((await snapshot(page)).sent[0]).toMatchObject({
    method: "inspectEpisodes",
    id: "00000000-0000-7000-8000-000000000901",
    body: { episodeOutputIds: ["output-1-2", "output-2-2"], exceptions: [] },
  });
  await clean();
});

for (const kind of ["sample", "episode"] as const) {
  test(`${kind} 上传同身份预览刷新不取消，完成真实本地 POST 后能登记`, async ({ page }) => {
    const clean = await openProbe(page, `${kind}-upload`);
    const index = await startUpload(page, kind);
    await change(page, "preview");
    // 检查 React 已渲染更新后同一请求仍活着，而不是只读到更新前的 signal。
    if (kind === "sample")
      await expect(
        page.getByRole("checkbox", { name: "制作中使用了 AI 工具", exact: true }),
      ).toBeDisabled();
    else await expect(page.getByRole("button", { name: "修改集号", exact: true })).toBeDisabled();
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect((await snapshot(page)).registrations[index]!.aborted).toBe(false);
    await completeUpload(page, index, kind);
    await page
      .getByRole("button", { name: kind === "sample" ? "登记样片" : "登记成片文件", exact: true })
      .click();
    await expect.poll(async () => (await snapshot(page)).sent.length).toBe(1);
    expect((await snapshot(page)).sent[0]).toMatchObject({
      method: kind === "sample" ? "sample" : "registerEpisodes",
      id: "00000000-0000-7000-8000-000000000901",
    });
    await clean();
  });

  test(`${kind} 上传切换真实 item/ticket 或关闭会取消，新上下文可用且旧完成不回写`, async ({
    page,
  }) => {
    const clean = await openProbe(page, `${kind}-upload`);
    for (const identity of ["item", "ticket"] as const) {
      const index = await startUpload(page, kind);
      await change(page, identity);
      await expect
        .poll(async () => (await snapshot(page)).registrations[index]!.aborted)
        .toBe(true);
      await expect(
        page.getByRole("checkbox", { name: "制作中使用了 AI 工具", exact: true }),
      ).toBeEnabled();
      if (kind === "episode")
        await expect(
          page.getByRole("button", { name: "上传所选文件 / 重试", exact: true }),
        ).toHaveCount(0);
      const newIndex = await startUpload(page, kind);
      const before = posts;
      await page.evaluate((index) => window.productionLifecycle.release(index), index);
      await page.evaluate(() => new Promise(requestAnimationFrame));
      expect(posts).toBe(before);
      expect((await snapshot(page)).completed).not.toContain(
        (await snapshot(page)).registrations[index]!.fileId,
      );
      if (kind === "sample")
        await expect(
          page.getByRole("checkbox", { name: "制作中使用了 AI 工具", exact: true }),
        ).toBeDisabled();
      else await expect(page.getByRole("button", { name: "修改集号", exact: true })).toBeDisabled();
      await completeUpload(page, newIndex, kind);
      await page.evaluate(() => window.productionLifecycle.close());
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.evaluate(() => window.productionLifecycle.open());
      await expect(page.getByRole("dialog")).toBeVisible();
    }
    const index = await startUpload(page, kind);
    await page.evaluate(() => window.productionLifecycle.close());
    await expect.poll(async () => (await snapshot(page)).registrations[index]!.aborted).toBe(true);
    await page.evaluate(() => window.productionLifecycle.open());
    await expect(
      page.getByRole("checkbox", { name: "制作中使用了 AI 工具", exact: true }),
    ).toBeEnabled();
    const newIndex = await startUpload(page, kind);
    await page.evaluate((index) => window.productionLifecycle.release(index), index);
    await completeUpload(page, newIndex, kind);
    await clean();
  });
}
