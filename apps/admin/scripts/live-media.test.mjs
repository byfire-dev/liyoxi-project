import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { prepareLiveMedia } from "./live-media.mjs";

const image = `sha256:${"a".repeat(64)}`;
const fixtures = [
  "--video",
  "/tmp/lyx-w302-owned/standard-20s.mp4",
  "--resume-video",
  "/tmp/lyx-w302-owned/multipart-20s.mp4",
  "--probe-facts",
  "/tmp/lyx-w302-owned/manifest.json",
];

test("显式完整输入继续原完整集合，不执行 Docker 或改写参数", async () => {
  const args = [...fixtures, "--mediatool-image", image];
  const prepared = await prepareLiveMedia(args, {
    run: () => assert.fail("复用已验证输入不应造片或构建"),
  });
  assert.deepEqual(prepared.args, args);
  prepared.close(true);
});

test("不完整输入、非摘要镜像和任意用例路径在创建资源前拒绝", async () => {
  for (const args of [
    ["--video", fixtures[1]],
    ["--mediatool-image", "liyoxi/mediatool:latest"],
    ["--test-file", "test/e2e/live-staff.spec.ts"],
  ]) {
    await assert.rejects(prepareLiveMedia(args, { run: () => assert.fail("不应启动 Docker") }));
  }
});

test("缺省准备固定镜像与两份输入，终止确认后取回，成功才删除临时文件", async () => {
  const calls = [];
  let directory;
  const prepared = await prepareLiveMedia([], {
    async run(args, options) {
      calls.push({ args, options });
      if (args[0] === "build") writeFileSync(args[2], image);
      if (args[0] === "inspect") return "false";
      if (args[0] === "cp") directory = args[2].replace(/\/legal-media$/, "");
      return "";
    },
  });
  try {
    const create = calls.find((call) => call.args[0] === "create").args;
    for (const [option, value] of [
      ["--network", "none"],
      ["--cpus", "1"],
      ["--memory", "1g"],
      ["--pids-limit", "128"],
      ["--cap-drop", "ALL"],
      ["--security-opt", "no-new-privileges"],
    ])
      assert.equal(create[create.indexOf(option) + 1], value);
    assert.ok(create.includes("--read-only"));
    assert.ok(!create.includes("--privileged"));
    const stages = calls.map((call) => call.args[0]);
    assert.ok(stages.indexOf("inspect") < stages.indexOf("cp"));
    assert.ok(stages.indexOf("cp") < stages.indexOf("rm"));
    assert.equal(stages.at(-1), "volume");
    const values = Object.fromEntries(
      Array.from({ length: prepared.args.length / 2 }, (_, i) => [
        prepared.args[i * 2],
        prepared.args[i * 2 + 1],
      ]),
    );
    assert.equal(values["--mediatool-image"], image);
    assert.match(values["--video"], /standard-20s\.mp4$/);
    assert.match(values["--resume-video"], /multipart-20s\.mp4$/);
    assert.ok(!values["--test-file"], "默认仍收集所有新旧用例");
    assert.ok(existsSync(directory));
    prepared.close(true);
    assert.ok(!existsSync(directory));
  } finally {
    if (directory && existsSync(directory)) rmSync(directory, { recursive: true });
  }
});

test("生成失败仍确认终止、保留首次部分输入并回收自己的容器卷", async () => {
  const calls = [];
  let directory;
  try {
    await assert.rejects(
      prepareLiveMedia(["--mediatool-image", image], {
        async run(args) {
          calls.push(args);
          if (args[0] === "start") throw new Error("实际生成边界失败");
          if (args[0] === "inspect") return "false";
          if (args[0] === "cp") {
            directory = args[2].replace(/\/legal-media$/, "");
            writeFileSync(`${args[2]}/first-observation`, "partial");
          }
          return "";
        },
      }),
      /准备失败；保留/,
    );
    assert.ok(existsSync(`${directory}/legal-media/first-observation`));
    assert.ok(calls.some((args) => args[0] === "rm"));
    assert.ok(calls.some((args) => args[0] === "volume" && args[1] === "rm"));
  } finally {
    if (directory) rmSync(directory, { recursive: true });
  }
});

test("不能确认容器终止就失败并保留卷，不声称清理成功", async () => {
  const calls = [];
  let directory;
  try {
    await assert.rejects(
      prepareLiveMedia(["--mediatool-image", image], {
        async run(args) {
          calls.push(args);
          if (args[0] === "inspect") return "true";
          return "";
        },
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        directory = /保留 (\/tmp\/lyx-w302-live-media-\S+)$/.exec(error.message)?.[1];
        return true;
      },
    );
    assert.ok(directory && existsSync(directory));
    assert.ok(!calls.some((args) => args[0] === "cp" || args[0] === "rm"));
    assert.ok(!calls.some((args) => args[0] === "volume" && args[1] === "rm"));
  } finally {
    if (directory) rmSync(directory, { recursive: true });
  }
});

for (const phase of ["volume", "container"]) {
  test(`${phase} 已创建但回执失败时，核对精确名称和归属后回收自己的对象`, async () => {
    const objects = new Map();
    const calls = [];
    let directory;
    try {
      await assert.rejects(
        prepareLiveMedia(["--mediatool-image", image], {
          async run(args) {
            calls.push(args);
            if ((args[0] === "volume" && args[1] === "create") || args[0] === "create") {
              const kind = args[0] === "volume" ? "volume" : "container";
              const name = kind === "volume" ? args.at(-1) : args[args.indexOf("--name") + 1];
              const label = args[args.indexOf("--label") + 1].split("=")[1];
              objects.set(name, { kind, label });
              if (kind === phase) throw new Error("守护进程已创建对象，但客户端丢失回执");
            }
            if (args[1] === "ls") {
              const name = args[args.indexOf("--filter") + 1].replace(/^name=\^\/?|\$$/g, "");
              assert.equal(objects.get(name)?.kind, args[0]);
              return name;
            }
            if (args[1] === "inspect") return objects.get(args.at(-1)).label;
            if (args[0] === "inspect") return "false";
            if (args[0] === "rm" || (args[0] === "volume" && args[1] === "rm"))
              objects.delete(args.at(-1));
            return "";
          },
        }),
        (error) => {
          directory = /保留 (\/tmp\/lyx-w302-live-media-\S+)$/.exec(error.message)?.[1];
          assert.match(error.cause.message, /丢失回执/);
          return true;
        },
      );
      assert.equal(objects.size, 0);
      assert.ok(!calls.some((args) => args[0] === "start"));
      if (phase === "container") {
        const stages = calls.map((args) => args[0]);
        assert.ok(stages.indexOf("stop") < stages.indexOf("inspect"));
        assert.ok(stages.indexOf("inspect") < stages.indexOf("rm"));
      }
    } finally {
      if (directory) rmSync(directory, { recursive: true });
    }
  });
}

test("创建回执失败后归属不符时保留对象，并报告精确对象名", async () => {
  const calls = [];
  let volume;
  let directory;
  try {
    await assert.rejects(
      prepareLiveMedia(["--mediatool-image", image], {
        async run(args) {
          calls.push(args);
          if (args[0] === "volume" && args[1] === "create") {
            volume = args.at(-1);
            throw new Error("创建回执不确定");
          }
          if (args[1] === "ls") return volume;
          if (args[1] === "inspect") return "another-run";
          return "";
        },
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.message.includes(`卷 ${volume}`));
        assert.ok(error.message.includes(`容器 ${volume.replace(/-work$/, "")}`));
        directory = /保留 (\/tmp\/lyx-w302-live-media-\S+)$/.exec(error.message)?.[1];
        return true;
      },
    );
    assert.ok(!calls.some((args) => args[0] === "rm" || args[1] === "rm"));
    assert.ok(directory && existsSync(directory));
  } finally {
    if (directory) rmSync(directory, { recursive: true });
  }
});

test("实际 Playwright 配置按文件名区分 live 和 samples，目录名不改变范围", async () => {
  const original = process.env.LYX_ADMIN_LIVE;
  try {
    delete process.env.LYX_ADMIN_LIVE;
    const samples = (await import("../playwright.config.ts?media-samples")).default;
    process.env.LYX_ADMIN_LIVE = "1";
    const live = (await import("../playwright.config.ts?media-live")).default;
    for (const base of [
      "/tmp/admin-live-data-cli/liyoxi/apps/admin/test/e2e/",
      "C:\\tmp\\admin-live-data-cli\\liyoxi\\apps\\admin\\test\\e2e\\",
    ]) {
      assert.equal(samples.projects[0].testIgnore.test(`${base}smoke.spec.ts`), false);
      assert.equal(samples.projects[0].testIgnore.test(`${base}live-staff.spec.ts`), true);
      const main = live.projects.find((project) => project.name === "live");
      assert.equal(main.testMatch.test(`${base}smoke.spec.ts`), false);
      assert.equal(main.testMatch.test(`${base}live-delivery-flow.spec.ts`), true);
      assert.equal(main.testMatch.test(`${base}live-output-batch.spec.ts`), true);
      assert.deepEqual(main.dependencies, ["live-auth"]);
    }
  } finally {
    if (original === undefined) delete process.env.LYX_ADMIN_LIVE;
    else process.env.LYX_ADMIN_LIVE = original;
  }
});
