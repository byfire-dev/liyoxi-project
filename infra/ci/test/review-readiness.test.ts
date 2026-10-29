import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { makeTempDir, repoRoot, writeFiles } from "./helpers.js";

const { FLAGS } = (await import(
  pathToFileURL(join(repoRoot, "packages/contract/src/config/flags.ts")).href
)) as { FLAGS: { key: string; exposedTo: string; defaultValue: unknown }[] };

type Result = { name: string; ok: boolean; detail: string };
type Runner = (command: string, args: string[]) => { status: number; stdout: string };
interface Readiness {
  deletionPageImplemented(source: string): boolean;
  reviewReadiness(options: {
    root: string;
    commit: string;
    baseUrl?: string;
    freeze?: string;
    run: Runner;
    fetcher: typeof fetch;
  }): Promise<Result[]>;
}
const helper = (await import(
  pathToFileURL(join(repoRoot, "infra/ci/review-readiness.mjs")).href
)) as Readiness;
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
const commit = "a".repeat(40);
function fixture() {
  const temp = makeTempDir("lyx-review-readiness-");
  cleanups.push(temp.cleanup);
  const files: Record<string, string> = {
    "docs/plan/owner-checklist.md":
      "| E3 | 备案 | V2 | 完成 | 假核对记录 | 2026-10-18 |\n| E5 | 商户 | V2 | 完成 | 假核对记录 | 2026-10-18 |",
    "docs/plan/platform-config.md": readFileSync(
      join(repoRoot, "docs/plan/platform-config.md"),
      "utf8",
    ).replaceAll("| 待核 | |", "| 通过 | 虚构测试记录2026-10-18 |"),
    "apps/weapp/src/pages.ts":
      'page("sub/service/settings/index", "sub/service", {implemented:true});',
    "apps/weapp/src/app.config.ts": "export default defineAppConfig({});",
    "apps/weapp/src/actual.tsx": `import Taro from '@tarojs/taro'; Taro.chooseMedia({});Taro.chooseMessageFile({});Taro.getRecorderManager();Taro.saveVideoToPhotosAlbum({});Taro.setClipboardData({});const el=<Button openType="getPhoneNumber"/>;`,
  };
  for (const id of ["W4-01", "W4-02", "W3-03", "W3-05"])
    files[`docs/plan/status/${id}.md`] = "| 状态 | 完成 |";
  writeFiles(temp.dir, files);
  const flags = Object.fromEntries(
    FLAGS.filter((v) => v.exposedTo === "client").map((v) => [v.key, v.defaultValue]),
  );
  Object.assign(flags, { "weapp.video.ad.enabled": false, "export.enabled": false });
  const fetcher = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("/health")
      ? Response.json({
          status: "ok",
          version: `sha-${commit.slice(0, 12)}`,
          db: "ok",
          redis: "ok",
          worker: "ok",
        })
      : Response.json({ data: { flags, degraded: [] } }),
  );
  const run = vi.fn<Runner>((_command, args) => ({
    status: 0,
    stdout: args[0] === "rev-parse" ? commit : "",
  }));
  const options = {
    root: temp.dir,
    commit,
    baseUrl: "https://review.fixture.net",
    freeze: "true",
    run,
    fetcher,
  };
  return { options, files, root: temp.dir };
}
it("完整事实才允许出包，使用正式落地与兼容命令，健康版本绑定完整提交派生sha", async () => {
  const f = fixture();
  expect((await helper.reviewReadiness(f.options)).every((v) => v.ok)).toBe(true);
  expect(f.options.run.mock.calls).toContainEqual([
    process.execPath,
    ["infra/ci/landed.mjs", "--check", "--require", "M0,M1,M2"],
  ]);
  expect(f.options.run.mock.calls).toContainEqual(["pnpm", ["contract:compat"]]);
});
it("部分E3/E5、未完成内容审核包、待核平台、未冻结、旧健康版本逐项失败", async () => {
  const f = fixture();
  writeFiles(f.root, {
    "docs/plan/owner-checklist.md": f.files["docs/plan/owner-checklist.md"]!.replaceAll(
      "完成",
      "进行中",
    ),
    "docs/plan/status/W3-05.md": "| 状态 | 未开工 |",
    "docs/plan/platform-config.md": f.files["docs/plan/platform-config.md"]!.replace(
      /(## 6\. 提审核对表[\s\S]*?)\| 通过 \| 虚构测试记录2026-10-18 \|/,
      "$1| 待核 | |",
    ),
  });
  const results = await helper.reviewReadiness({
    ...f.options,
    freeze: "false",
    fetcher: vi.fn<typeof fetch>(async () =>
      Response.json({ status: "ok", version: "sha-bbbbbbbbbbbb" }),
    ),
  });
  for (const name of ["W3-05", "E3", "E5", "平台核对1", "冻结", "预发健康", "送审开关"])
    expect(results.find((v) => v.name === name)?.ok).toBe(false);
});
it("正式门禁失败、非main/脏检出、注释或别页implemented均拒绝", async () => {
  const f = fixture();
  const results = await helper.reviewReadiness({
    ...f.options,
    run: () => ({ status: 1, stdout: "" }),
    baseUrl: undefined,
  });
  for (const name of ["源码", "接口落地", "在役兼容", "预发健康"])
    expect(results.find((v) => v.name === name)?.ok).toBe(false);
  expect(
    helper.deletionPageImplemented(
      'page("other", {implemented:true}); // sub/service/settings/index implemented:true',
    ),
  ).toBe(false);
  expect(
    helper.deletionPageImplemented('page("sub/service/settings/index", {implemented:false});'),
  ).toBe(false);
  await expect(helper.reviewReadiness({ ...f.options, commit: "main" })).rejects.toThrow();
});
