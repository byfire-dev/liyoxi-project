import assert from "node:assert/strict";
import test from "node:test";
import { selectedLiveTests } from "./live-selection.mjs";
import { prepareLiveMedia } from "./live-media.mjs";

test("默认完整集合，显式选择仅精确匹配现有文件且保留顺序", () => {
  assert.deepEqual(selectedLiveTests(undefined), []);
  const files = ["test/e2e/live-flow-ops.spec.ts", "test/e2e/live-output-batch.spec.ts"];
  const selected = selectedLiveTests(files.join(",")).map((value) => new RegExp(value));
  assert.equal(selected.length, 2);
  for (const [i, file] of files.entries()) {
    assert.equal(selected[i].test(`/some/worktree/apps/admin/${file}`), true);
    assert.equal(
      selected[i].test(`C:\\worktree\\apps\\admin\\${file.replaceAll("/", "\\")}`),
      true,
    );
    assert.equal(selected[i].test(`${file}.bak`), false);
    assert.equal(selected[i].test(file.replace(".spec.ts", "XspecXts")), false);
    assert.equal(selected[i].test(files[1 - i]), false);
  }
});

test("坏路径、正则、空值、不存在、重复及超量选择在启动资源前拒绝", async () => {
  const file = "test/e2e/live-flow-ops.spec.ts";
  for (const value of [
    "",
    " ",
    "/" + file,
    "../" + file,
    "test/e2e/../live-flow-ops.spec.ts",
    "test/e2e/live-*.spec.ts",
    "test/e2e/live-auth.setup.ts",
    "test/e2e/live-missing-selected-file.spec.ts",
    `${file},${file}`,
    `${file},`,
    Array.from({ length: 9 }, (_, i) => `test/e2e/live-${i}.spec.ts`).join(","),
  ]) {
    assert.throws(() => selectedLiveTests(value));
    await assert.rejects(
      prepareLiveMedia(["--test-file", value], {
        run: () => assert.fail("非法选择不得启动 Docker"),
      }),
    );
  }
});

test("选定文件沿合法输入原样转交，保留完整媒体输入守卫", async () => {
  const args = [
    "--test-file",
    "test/e2e/live-flow-ops.spec.ts,test/e2e/live-output-batch.spec.ts",
    "--video",
    "/tmp/lyx-w302-owned/standard-20s.mp4",
    "--resume-video",
    "/tmp/lyx-w302-owned/multipart-20s.mp4",
    "--probe-facts",
    "/tmp/lyx-w302-owned/manifest.json",
    "--mediatool-image",
    `sha256:${"a".repeat(64)}`,
  ];
  const prepared = await prepareLiveMedia(args, { run: () => assert.fail("已有输入无需造片") });
  assert.deepEqual(prepared.args, args);
  prepared.close(true);
  await assert.rejects(
    prepareLiveMedia(args.slice(0, 4), { run: () => assert.fail("不完整输入不得启动") }),
  );
});
