import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { makeTempDir, repoRoot, writeFiles } from "./helpers.js";

const { FLAGS } = (await import(
  pathToFileURL(join(repoRoot, "packages/contract/src/config/flags.ts")).href
)) as { FLAGS: { key: string; exposedTo: string; defaultValue: unknown }[] };

interface ReviewCheck {
  reviewFlagErrors(flags: unknown, policy?: Record<string, unknown>): string[];
  privacyReport(root?: string): {
    calls: string[];
    requiredPrivateInfos: string[];
    errors: string[];
  };
  checkReviewFlags(url: string, fetcher: typeof fetch, version?: string): Promise<string[]>;
}
const helper = (await import(
  pathToFileURL(join(repoRoot, "infra/deploy/review-check.mjs")).href
)) as ReviewCheck;
const expected = Object.fromEntries(
  FLAGS.filter((v) => v.exposedTo === "client").map((v) => [v.key, v.defaultValue]),
);
Object.assign(expected, { "weapp.video.ad.enabled": false, "export.enabled": false });
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));
function fixture() {
  const temp = makeTempDir("lyx-review-privacy-");
  cleanups.push(temp.cleanup);
  const calls = `import Taro from '@tarojs/taro';
Taro.chooseMedia({sourceType:['album','camera']}); Taro.getRecorderManager();
Taro.saveVideoToPhotosAlbum({}); Taro.setClipboardData({}); Taro.chooseMessageFile({});
const phone = <Button openType="getPhoneNumber"/>;`;
  writeFiles(temp.dir, {
    "apps/weapp/src/page.tsx": calls,
    "apps/weapp/src/app.config.ts": "export default defineAppConfig({__usePrivacyCheck__:true});",
    "docs/plan/platform-config.md": readFileSync(
      join(repoRoot, "docs/plan/platform-config.md"),
      "utf8",
    ),
  });
  return { root: temp.dir, calls };
}
it("送审差异键来自契约，默认关闭项也必须保持，缺失/未知/重复默认拒绝", () => {
  expect(helper.reviewFlagErrors(expected)).toEqual([]);
  expect(helper.reviewFlagErrors({ ...expected, "weapp.trailer.autoplay": true })).toContain(
    "weapp.trailer.autoplay：下发值与送审清单不同或缺失",
  );
  expect(helper.reviewFlagErrors({})).not.toEqual([]);
  expect(helper.reviewFlagErrors(expected, { invented: false })).toContain(
    "invented：不是已登记客户端开关",
  );
  expect(helper.reviewFlagErrors(expected, { "weapp.trailer.autoplay": false })).toContain(
    "weapp.trailer.autoplay：与默认相同，不应重复登记",
  );
});
it("三种版本类型只读引导，沿真实sha客户端版本且不登录；降级/坏响应拒绝", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ data: { flags: expected, degraded: [] } }),
  );
  expect(
    await helper.checkReviewFlags("https://review.fixture.net", fetcher, "sha-0123456789ab"),
  ).toEqual([]);
  expect(fetcher.mock.calls).toHaveLength(3);
  expect(fetcher.mock.calls.map((v) => new Headers(v[1]?.headers).get("X-Env-Version"))).toEqual([
    "develop",
    "trial",
    "release",
  ]);
  for (const [url, init] of fetcher.mock.calls) {
    expect(url).toBe("https://review.fixture.net/api/v1/m/bootstrap");
    expect(init?.method).toBeUndefined();
    expect(new Headers(init?.headers).get("Authorization")).toBeNull();
    expect(new Headers(init?.headers).get("X-Client-Version")).toBe("sha-0123456789ab");
  }
  const degraded = vi.fn<typeof fetch>(async () =>
    Response.json({ data: { flags: expected, degraded: ["flags"] } }),
  );
  expect(await helper.checkReviewFlags("https://review.fixture.net", degraded)).toHaveLength(3);
  await expect(
    helper.checkReviewFlags("https://user:secret@review.fixture.net", fetcher),
  ).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it("隐私AST核对真实调用、手机号按钮和未配置数组，忽略注释/测试字符串", () => {
  const f = fixture();
  writeFiles(f.root, {
    "apps/weapp/src/comments.ts": "// Taro.chooseLocation({});\nconst text='Taro.scanCode()';",
    "apps/weapp/src/spec.test.ts": "Taro.chooseLocation({});",
  });
  expect(helper.privacyReport(f.root)).toEqual({
    calls: [
      "chooseMedia",
      "chooseMessageFile",
      "getPhoneNumber",
      "getRecorderManager",
      "saveVideoToPhotosAlbum",
      "setClipboardData",
    ],
    requiredPrivateInfos: [],
    errors: [],
  });
});
it("新增位置调用、删手机号按钮、requiredPrivateInfos增项或动态调用均不能静默通过", () => {
  const f = fixture();
  writeFiles(f.root, {
    "apps/weapp/src/page.tsx": `${f.calls}\nTaro.chooseLocation({}); Taro[method]();`,
  });
  const changed = helper.privacyReport(f.root);
  expect(changed.errors).toContain("隐私指引第8项与实际调用不一致");
  expect(changed.errors).toContain("隐私扫描：存在无法静态核对的Taro动态调用");
  writeFiles(f.root, {
    "apps/weapp/src/page.tsx": f.calls.replace('openType="getPhoneNumber"', 'openType="button"'),
    "apps/weapp/src/app.config.ts":
      "export default defineAppConfig({requiredPrivateInfos:['chooseLocation']});",
  });
  const missing = helper.privacyReport(f.root);
  expect(missing.errors).toContain("隐私指引第1项与实际调用不一致");
  expect(missing.errors).toContain("requiredPrivateInfos与指引不一致");
});
