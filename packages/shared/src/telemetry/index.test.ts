import { SourceMap } from "node:module";
import { Script } from "node:vm";
import { expect, it } from "vitest";

import { cleanClientStacktrace, clientErrorFrames } from "./index.js";

it("M6 portal帧复用同源hash assets，只认本组件完整路径、正坐标与既有限额", () => {
  const origin = "https://portal.example.invalid";
  const asset = "assets/index-Ab12_cd3.js";
  const canonical = {
    filename: asset,
    abs_path: `app:///portal/${asset}`,
    lineno: 2,
    colno: 9,
    in_app: true,
  };
  expect(
    clientErrorFrames(
      `Error: fixture\n    at fail (${origin}/${asset}:2:9)\nboot@app:///portal/${asset}:1:3`,
      "portal",
      origin,
    ),
  ).toEqual([{ ...canonical, lineno: 1, colno: 3 }, canonical]);
  expect(clientErrorFrames(`at app:///portal/${asset}:2:9`, "portal")).toEqual([canonical]);
  expect(clientErrorFrames(`at ${origin}/${asset}:2:9`, "portal")).toEqual([]);
  for (const path of [
    `https://other.example.invalid/${asset}`,
    `https://admin.example.invalid/${asset}`,
    `${origin}:8443/${asset}`,
    `https://user:pass@portal.example.invalid/${asset}`,
    `${origin}/user/../${asset}`,
    `${origin}/${asset}?token=secret`,
    `${origin}/${asset}#fragment`,
    `${origin}/assets/%69ndex-Ab12_cd3.js`,
    `${origin}/assets\\index-Ab12_cd3.js`,
    `${origin}/assets/index.js`,
    `${origin}/app.js`,
    `app:///admin/${asset}`,
    `app:///weapp/${asset}`,
    "app:///portal/../assets/index-Ab12_cd3.js",
    "app:///portal/pages/mall/index.js",
    "assets/index-Ab12_cd3.js",
    "/srv/api/server.js",
    "node:internal/a",
  ])
    expect(clientErrorFrames(`at fail (${path}:2:9)`, "portal", origin)).toEqual([]);
  for (const suffix of ["0:1", "1:0", "-1:2", "1:2147483648", "1", "native"])
    expect(clientErrorFrames(`at app:///portal/${asset}:${suffix}`, "portal")).toEqual([]);
  expect(clientErrorFrames("x".repeat(32_769), "portal", origin)).toEqual([]);
  expect(
    clientErrorFrames(
      Array.from({ length: 60 }, () => `at app:///portal/${asset}:2:9`).join("\n"),
      "portal",
    ),
  ).toHaveLength(50);
  expect(
    cleanClientStacktrace(
      {
        frames: [
          {
            ...canonical,
            function: "private function",
            vars: { phone: "13800138000" },
            pre_context: ["private source"],
            context_line: "private source",
            post_context: ["private source"],
          },
        ],
      },
      "portal",
    ),
  ).toEqual({ frames: [canonical] });
  for (const changed of [
    { abs_path: `app:///admin/${asset}` },
    { abs_path: `app:///weapp/${asset}` },
    { abs_path: `${origin}/${asset}` },
    { abs_path: `https://other.example.invalid/${asset}` },
    { filename: "../assets/index-Ab12_cd3.js" },
    { filename: "assets/index.js", abs_path: "app:///portal/assets/index.js" },
    { lineno: 0 },
    { colno: 2_147_483_648 },
    { colno: 1.5 },
    { lineno: "2" },
  ])
    expect(
      cleanClientStacktrace({ frames: [{ ...canonical, ...changed }] }, "portal"),
    ).toBeUndefined();
  for (const kind of ["admin", "weapp", "api", "worker", "unknown", undefined])
    expect(cleanClientStacktrace({ frames: [canonical] }, kind)).toBeUndefined();
  for (const kind of ["api", "worker", "unknown"])
    expect(
      cleanClientStacktrace(
        { frames: [{ ...canonical, abs_path: `app:///${kind}/${asset}` }] },
        kind,
      ),
    ).toBeUndefined();
  expect(
    cleanClientStacktrace({ frames: Array.from({ length: 60 }, () => canonical) }, "portal")
      ?.frames,
  ).toHaveLength(50);
});

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
