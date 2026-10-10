// P2-1 定点组件回归：真实 React/AntD + AppServices 403 刷新链；HTTP 仅本地协议替身。
// 不代表真实后台 403 验收（该事实复用修复前 R6），不访问 PG/Redis/COS 或外网。
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { ServerResponse } from "node:http";
import { expect, test, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

type Level = "e" | "v" | "n";
type Write = { body: Record<string, unknown>; key: string | undefined };
type Probe = {
  capture(): void;
  refresh(level: Level): Promise<void>;
  staleSubmit(): void;
  staleConfirm(): Promise<{ outcome: string }>;
  staleUpload(): Promise<string>;
  sameCallbacks(): boolean;
  writeCalls(): number;
  close(): void;
};
declare global {
  interface Window {
    bannerPermission: Probe;
  }
}
const root = resolve(import.meta.dirname, "../..");
const id = "01910000-0000-7000-8000-000000000001";
const fileId = "01910000-0000-7000-8000-000000000002";
const stamp = "2026-10-01T00:00:00.000Z";
const actor = {
  staffId: id,
  staffNo: 1001,
  name: "虚构员工",
  roleKey: "super_admin",
  isLead: false,
  status: "active",
};
const original = {
  homeBannerId: id,
  title: "权限生命周期 Banner",
  imageFileId: fileId,
  imageUrl: null,
  jumpKind: "none",
  jumpTarget: null,
  jumpTargetLabel: null,
  startAt: stamp,
  endAt: null,
  isEnabled: true,
  position: 0,
  displayState: "live",
  clickCount: null,
  lockVersion: 4,
  createdBy: actor,
  updatedBy: null,
  createdAt: stamp,
  updatedAt: stamp,
  actions: ["edit", "disable"],
};
let server: ViteDevServer,
  origin: string,
  level: Level,
  banner = { ...original };
let writes: Write[], registrations: Write[], aborted: number, completes: number, unknown: string[];
let held: ServerResponse[];
const virtual = (name: string) => `/__w312_${name}.tsx`;
const modules: Record<string, string> = {
  [virtual("entry")]: `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {QueryClientProvider} from '@tanstack/react-query';
import {HomeBannerItemSchema} from '@liyoxi/contract';
import {AccessContext} from '/src/lib/permissions.ts';
import {createAppServices} from '/src/app/services.ts';
import {createSiteApi} from '/src/features/ops/home/api.ts';
import {homeSearch} from '/src/features/ops/home/model.ts';
import {Banners} from '/src/features/ops/home/banners.tsx';
import '/src/theme/global.css';
import {installCssVariables} from '/src/theme/css-vars.ts';
installCssVariables(document);
window.__bannerCapture={current:{},old:{}};
const services=createAppServices();
services.setAccessSource({load:()=>fetch('/__access').then(r=>r.json())});
const transport=createSiteApi(services),calls=[];
const api={...transport,
 updateBanner(...args){calls.push('update');return transport.updateBanner(...args)},
 createBanner(...args){calls.push('create');return transport.createBanner(...args)},
};
const initial=await services.loadAccess();
const pageRoot=createRoot(document.getElementById('root'));
function App(){
 const [access,setAccess]=useState(initial);
 services.onAccessRefreshed(()=>void services.loadAccess().then(setAccess));
 window.bannerPermission={
  capture(){window.__bannerCapture.old={...window.__bannerCapture.current}},
  async refresh(level){
   await fetch('/__permission',{method:'POST',body:level});
   await services.api.client.GET('/api/v1/admin/auth/me');
  },
  staleSubmit(){window.__bannerCapture.old.submit()},
  staleConfirm(){return window.__bannerCapture.old.confirm({idempotencyKey:'w312-stale-confirm',seenValue:null})},
  async staleUpload(){try{await window.__bannerCapture.old.upload(new File(['old'],'old.png',{type:'image/png'}),{onProgress(){}});return 'resolved'}catch(e){return e.name}},
  sameCallbacks(){return window.__bannerCapture.old.submit ? window.__bannerCapture.old.submit===window.__bannerCapture.current.submit : window.__bannerCapture.old.confirm===window.__bannerCapture.current.confirm},
  writeCalls(){return calls.length},
  close(){pageRoot.unmount();services.queryClient.clear()},
 };
 return React.createElement(QueryClientProvider,{client:services.queryClient},
  React.createElement(AccessContext.Provider,{value:access},
   React.createElement('output',{'data-testid':'level'},access?.moduleLevels.ops),
   React.createElement(Banners,{api,search:homeSearch({}),change(){}})));
}
HomeBannerItemSchema.parse(${JSON.stringify(original)});
pageRoot.render(React.createElement(App));
`,
  [virtual("confirm")]: `
import React from 'react';
import {ConfirmAction as Actual} from '/src/components/ConfirmAction.tsx';
export function ConfirmAction(props){window.__bannerCapture.current.confirm=props.onConfirm;return React.createElement(Actual,props)}
`,
  [virtual("antd")]: `
import React from 'react';
import {Button as Actual} from 'antd';
export * from 'antd';
export function Button(props){if(props.children==='保存 Banner'||props.children==='新增 Banner')window.__bannerCapture.current.submit=props.onClick;return React.createElement(Actual,props)}
`,
  [virtual("upload")]: `
import React from 'react';
import {UploadField as Actual} from '/src/components/UploadField.tsx';
export function UploadField(props){window.__bannerCapture.current.upload=props.upload;return React.createElement(Actual,props)}
`,
};

test.beforeAll(async () => {
  server = await createServer({
    root,
    configFile: resolve(root, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, hmr: false, watch: { ignored: ["**/dist/**"] } },
    plugins: [
      {
        name: "w312-banner-permission-probe",
        enforce: "pre",
        resolveId(source, importer) {
          if (source in modules) return "\0" + source;
          if (
            importer?.endsWith("/features/ops/home/banners.tsx") &&
            source.endsWith("/ConfirmAction")
          )
            return "\0" + virtual("confirm");
          if (importer?.endsWith("/features/ops/home/banner-editor.tsx")) {
            if (source === "antd") return "\0" + virtual("antd");
            if (source.endsWith("/UploadField")) return "\0" + virtual("upload");
          }
        },
        load(id) {
          return modules[id.replace(/^\0/, "")];
        },
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            const path = new URL(request.url ?? "/", "http://localhost").pathname;
            if (path === "/__banner_probe") {
              response.setHeader("Content-Type", "text/html");
              response.end(
                await vite.transformIndexHtml(
                  path,
                  `<!doctype html><div id="root"></div><script type="module" src="${virtual("entry")}"></script>`,
                ),
              );
              return;
            }
            if (!path.startsWith("/api/") && !["/__access", "/__permission"].includes(path))
              return next();
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const text = Buffer.concat(chunks).toString("utf8");
            const json = (value: unknown, status = 200) => {
              response.statusCode = status;
              response.setHeader("Content-Type", "application/json");
              response.end(JSON.stringify(value));
            };
            if (path === "/__permission") {
              level = text as Level;
              json({ ok: true });
              return;
            }
            if (path === "/__access") {
              json({
                staff: { id, name: "虚构员工", roleKey: "super_admin", roleName: "超级管理员" },
                isLead: false,
                moduleLevels: { ops: level },
                actions: [],
                dataScope: "all",
                releases: {},
              });
              return;
            }
            if (path === "/api/v1/admin/auth/me") {
              json(
                { error: "PERMISSION_DENIED", message: "本地协议：权限已变化", retryable: false },
                403,
              );
              return;
            }
            if (path === "/api/v1/admin/home-banners/summary") {
              json({ data: { live: 1, scheduled: 0, ended: 0, disabled: 0, maxActive: 10 } });
              return;
            }
            if (path === "/api/v1/admin/home-banners" && request.method === "GET") {
              json({ data: { items: [banner], page: 1, pageSize: 20, total: 1 } });
              return;
            }
            if (path === "/api/v1/admin/dramas") {
              json({ data: { items: [], page: 1, pageSize: 100, total: 0 } });
              return;
            }
            if (path === "/api/v1/admin/site-configs/mall") {
              json({
                data: {
                  configKey: "mall",
                  published: {
                    siteConfigRevisionId: id,
                    revNo: 1,
                    status: "published",
                    content: {
                      categories: [
                        { key: "all", name: "全部", genreCodes: [], visible: true, fixed: true },
                      ],
                      hotWords: [],
                      filters: {
                        genre: false,
                        industry: false,
                        episodes: false,
                        price: false,
                        episodeBands: [],
                        priceBands: [],
                      },
                      sorts: ["composite"],
                      defaultSort: "composite",
                      weights: { heat: 100, sales30d: 0, freshness: 0, manual: 0 },
                    },
                    note: null,
                    publishedAt: stamp,
                    publishedBy: null,
                  },
                  draft: null,
                  refs: { categoryStats: [], pins: [], invalidRefs: [], affectedBanners: [] },
                },
              });
              return;
            }
            if (path === "/api/v1/admin/files" && request.method === "POST") {
              registrations.push({
                body: JSON.parse(text),
                key: String(request.headers["idempotency-key"]),
              });
              held.push(response);
              response.on("close", () => {
                if (!response.writableEnded) aborted++;
              });
              return;
            }
            if (path.endsWith("/complete")) {
              completes++;
              json({});
              return;
            }
            if (path === `/api/v1/admin/home-banners/${id}` && request.method === "PATCH") {
              const body: Record<string, unknown> = JSON.parse(text);
              writes.push({ body, key: String(request.headers["idempotency-key"]) });
              if (level !== "e") {
                json(
                  { error: "PERMISSION_DENIED", message: "本地协议拒绝", retryable: false },
                  403,
                );
                return;
              }
              banner = { ...banner, ...body, lockVersion: banner.lockVersion + 1 };
              json({ data: { ...banner, replayed: false } });
              return;
            }
            unknown.push(`${request.method} ${path}`);
            json({ error: { code: "TEST_UNKNOWN_ROUTE" } }, 500);
          });
        },
      },
    ],
  });
  await server.listen();
  origin = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
});
test.beforeEach(() => {
  level = "e";
  banner = { ...original };
  writes = [];
  registrations = [];
  aborted = 0;
  completes = 0;
  unknown = [];
  held = [];
});
test.afterEach(async ({ page }) => {
  await page.evaluate(() => window.bannerPermission?.close()).catch(() => {});
  for (const response of held) response.destroy();
});
test.afterAll(async () => {
  await server?.close();
});

async function open(page: Page) {
  const errors: string[] = [],
    remote: string[] = [],
    permissionConsole: string[] = [],
    noticeConsole: string[] = [];
  let permissionResponses = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.url() === `${origin}/api/v1/admin/auth/me` && r.status() === 403) permissionResponses++;
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (m.location().url === `${origin}/api/v1/admin/auth/me` && m.text().includes("403"))
      permissionConsole.push(m.text());
    else if (m.text().trim() === "本地协议：权限已变化") noticeConsole.push(m.text());
    else errors.push(m.text());
  });
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== origin) {
      remote.push(route.request().url());
      await route.abort();
    } else await route.continue();
  });
  await page.goto(`${origin}/__banner_probe`);
  await expect(page.getByTestId("level")).toHaveText("e");
  await expect(page.getByText(original.title, { exact: true })).toBeVisible();
  return () => {
    expect(errors).toEqual([]);
    expect(remote).toEqual([]);
    expect(unknown).toEqual([]);
    expect(permissionResponses).toBeGreaterThan(0);
    expect(permissionConsole).toHaveLength(permissionResponses);
    expect(noticeConsole).toHaveLength(permissionResponses);
  };
}
async function refresh(page: Page, value: Level) {
  await page.evaluate((value) => window.bannerPermission.refresh(value), value);
  await expect(page.getByTestId("level")).toHaveText(value);
}
const dialog = (page: Page) => page.getByRole("dialog");
async function capture(page: Page) {
  await page.evaluate(() => window.bannerPermission.capture());
}

test("新增弹层权限刷新销毁上传，旧上传与迟到结果不能写回，恢复 e 是新会话", async ({ page }) => {
  const clean = await open(page);
  await page.getByRole("button", { name: "新增 Banner", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await capture(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: "old.png",
    mimeType: "image/png",
    buffer: Buffer.from("fixture-image"),
  });
  await expect.poll(() => registrations.length).toBe(1);
  await refresh(page, "v");
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => aborted).toBe(1);
  expect(await page.evaluate(() => window.bannerPermission.staleUpload())).toBe("AbortError");
  held[0]!.end(
    JSON.stringify({
      data: { fileId, mode: "post", post: { url: `${origin}/__unused_cos`, fields: {} } },
    }),
  );
  await refresh(page, "e");
  await page.getByRole("button", { name: "新增 Banner", exact: true }).click();
  await expect(dialog(page).getByRole("textbox", { name: "标题", exact: true })).toHaveValue("");
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: "new.png", mimeType: "image/png", buffer: Buffer.from("new-fixture") });
  await expect.poll(() => registrations.length).toBe(2);
  expect(registrations[1]!.body.clientToken).not.toBe(registrations[0]!.body.clientToken);
  await refresh(page, "n");
  await expect(dialog(page)).toHaveCount(0);
  await expect.poll(() => aborted).toBe(2);
  expect(writes).toEqual([]);
  expect(completes).toBe(0);
  clean();
});
test("编辑草稿权限刷新失效，捕获的旧 submit 不发 PATCH，恢复 e 后独立提交", async ({ page }) => {
  const clean = await open(page);
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("textbox", { name: "标题", exact: true }).fill("旧会话草稿");
  await capture(page);
  await refresh(page, "v");
  await expect(dialog(page)).toHaveCount(0);
  await page.evaluate(() => window.bannerPermission.staleSubmit());
  expect(await page.evaluate(() => window.bannerPermission.writeCalls())).toBe(0);
  expect(writes).toEqual([]);
  await refresh(page, "e");
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  const title = dialog(page).getByRole("textbox", { name: "标题", exact: true });
  await expect(title).toHaveValue(original.title);
  expect(await page.evaluate(() => window.bannerPermission.sameCallbacks())).toBe(false);
  await title.fill("新会话独立提交");
  await dialog(page).getByRole("button", { name: "保存 Banner", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(dialog(page)).toHaveCount(0);
  expect(writes[0]!.body).toMatchObject({ title: "新会话独立提交", lockVersion: 4 });
  expect(writes[0]!.key).toBeTruthy();
  clean();
});
test("启停确认权限刷新失效，捕获的旧 confirm 不发 PATCH，恢复 e 重新核对", async ({ page }) => {
  const clean = await open(page);
  await page.getByRole("button", { name: "停用", exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await dialog(page).getByRole("checkbox").check();
  await capture(page);
  await refresh(page, "v");
  await expect(dialog(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.bannerPermission.staleConfirm())).toMatchObject({
    outcome: "failed",
  });
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => window.bannerPermission.writeCalls())).toBe(0);
  await refresh(page, "e");
  await page.getByRole("button", { name: "停用", exact: true }).click();
  await expect(dialog(page).getByRole("checkbox")).not.toBeChecked();
  await dialog(page).getByRole("checkbox").check();
  await dialog(page).getByRole("button", { name: "确 认", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  await expect(dialog(page)).toHaveCount(0);
  expect(writes[0]!.body).toEqual({ lockVersion: 4, isEnabled: false });
  expect(writes[0]!.key).not.toBe("w312-stale-confirm");
  clean();
});
