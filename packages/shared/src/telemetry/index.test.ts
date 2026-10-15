import { SourceMap } from "node:module";
import { Script } from "node:vm";
import { expect, it } from "vitest";

import { cleanClientStacktrace, clientErrorFrames } from "./index.js";

it("W227帧：V8/JSC/Taro完整路径、安全边界与真实微型SourceMap位置一致", () => {
  const origin = "https://admin.example.invalid";
  const asset = "assets/index-Ab12_cd3.js";
  const admin = clientErrorFrames(
    `Error: fixture\n    at fail (${origin}/${asset}:2:9)\nboot@${origin}/${asset}:1:3`,
    "admin",
    origin,
  );
  expect(admin).toEqual([
    { filename: asset, abs_path: `app:///admin/${asset}`, lineno: 1, colno: 3, in_app: true },
    { filename: asset, abs_path: `app:///admin/${asset}`, lineno: 2, colno: 9, in_app: true },
  ]);
  const weapp = clientErrorFrames(
    "Error: fixture\n at fail (app.js:3:4)\npage@/appservice/__APP__/pages/mall/index.js:2:7\n at sub/profile/review/index.js:1:1",
    "weapp",
  );
  expect(weapp.map((one) => one.filename)).toEqual([
    "sub/profile/review/index.js",
    "pages/mall/index.js",
    "app.js",
  ]);
  expect(new Set(weapp.map((one) => one.abs_path)).size).toBe(3);
  for (const path of [
    `https://elsewhere.invalid/${asset}`,
    `${origin}/user/../${asset}`,
    `https://user:pass@admin.example.invalid/${asset}`,
    `${origin}/${asset}?token=secret`,
    `${origin}/${asset}#fragment`,
    `${origin}/assets/%69ndex-Ab12_cd3.js`,
    `${origin}/assets\\index-Ab12_cd3.js`,
    "/srv/api/server.js",
    "app.js",
    "node:internal/a",
  ])
    expect(clientErrorFrames(`at fail (${path}:1:1)`, "admin", origin)).toEqual([]);
  for (const path of [
    "https://evil.invalid/app.js",
    "../app.js",
    "appservice/user/app.js",
    "/srv/app.js",
    "app.js?token=secret",
    "app.js#fragment",
    "other.js",
    "app:///admin/app.js",
  ])
    expect(clientErrorFrames(`at ${path}:1:1`, "weapp")).toEqual([]);
  for (const suffix of ["0:1", "1:0", "-1:2", "1:2147483648", "1", "native"])
    expect(clientErrorFrames(`at app.js:${suffix}`, "weapp")).toEqual([]);
  expect(clientErrorFrames("at native", "weapp")).toEqual([]);
  expect(clientErrorFrames("x".repeat(32_769), "weapp")).toEqual([]);
  expect(
    clientErrorFrames(Array.from({ length: 60 }, () => "at app.js:1:1").join("\n"), "weapp"),
  ).toHaveLength(50);
  const first = weapp[0]!;
  expect(
    cleanClientStacktrace(
      { frames: [{ ...first, vars: { token: "secret" }, function: "private" }] },
      "weapp",
    ),
  ).toEqual({ frames: [first] });
  for (const changed of [
    { colno: 0 },
    { abs_path: "https://evil.invalid/app.js" },
    { filename: "../app.js" },
  ])
    expect(cleanClientStacktrace({ frames: [{ ...first, ...changed }] }, "weapp")).toBeUndefined();
  expect(cleanClientStacktrace({ frames: [first] }, "admin")).toBeUndefined();
  expect(cleanClientStacktrace({ frames: [first] }, "unknown")).toBeUndefined();
  expect(
    cleanClientStacktrace(
      { frames: [{ filename: "app.js", lineno: 1, in_app: true, vars: { x: 1 } }] },
      undefined,
    ),
  ).toEqual({ frames: [{ filename: "app.js" }] });

  // 真实运行微型编译JS并以生成坐标查v3 map；只证明本地路径/位置口径，不代表SaaS已符号化。
  let stack: unknown;
  try {
    new Script("throw new Error('fixture');", {
      filename: "app:///weapp/pages/mall/index.js",
    }).runInNewContext();
  } catch (error) {
    // Node24的真实Error.stack为惰性own accessor；此处只读取本测试刚创建的Error。
    const descriptor = Object.getOwnPropertyDescriptor(error, "stack");
    stack = descriptor?.get ? descriptor.get.call(error) : descriptor?.value;
  }
  const runtime = clientErrorFrames(stack, "weapp");
  expect(runtime).toHaveLength(1);
  expect(runtime[0]?.abs_path).toBe("app:///weapp/pages/mall/index.js");
  const map = new SourceMap({
    version: 3,
    file: "pages/mall/index.js",
    sourceRoot: "",
    sources: ["src/pages/mall/index.tsx"],
    sourcesContent: ["throw new Error('fixture');"],
    names: [],
    mappings: "AAAA",
  });
  expect(map.findEntry(runtime[0]!.lineno - 1, runtime[0]!.colno - 1)).toMatchObject({
    originalSource: "src/pages/mall/index.tsx",
    originalLine: 0,
    originalColumn: 0,
  });
});
