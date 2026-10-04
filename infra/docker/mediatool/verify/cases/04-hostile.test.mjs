// @ts-check
// 任务书 第 7 节第 6 条：恶意输入不出界。
import assert from "node:assert/strict";
import { existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { test } from "node:test";

import { arm, call, fx, healthz, manifest, probe, wasRead } from "../lib/client.mjs";
import { AIGC, FX, SLOW } from "../lib/spec.mjs";

const posterOf = (/** @type {string} */ input, /** @type {object} */ extra = {}) =>
  call("POST", "/poster", {
    path: `${FX}/${input}`,
    demuxer: "mov",
    atMs: 0,
    outPath: `${FX}/out-hostile.jpg`,
    ...extra,
  });

/**
 * “这个文件没有被读过”：看访问时间（先用 arm 拨回去，被读过内核就会更新它）。
 * 造片脚本试过这个卷记不记访问时间（controls.atimeTracked）；不记的话这一条判不了，照实说明，不当作通过的证据。
 * @param {import("node:test").TestContext} t
 * @param {string} file
 * @param {string} what
 */
function assertNotRead(t, file, what) {
  if (!manifest().controls.atimeTracked) {
    t.diagnostic(`这个卷不记访问时间，“${what}”这一条没有判；其余断言照常`);
    return;
  }
  assert.equal(wasRead(fx(file)), false, what);
}

/** 容器里除服务本身以外、名字是 ffmpeg / ffprobe 的进程 */
async function mediaProcesses() {
  const { json } = await healthz();
  return json.procs.filter((/** @type {{ comm: string }} */ proc) =>
    /^ff(mpeg|probe)/.test(proc.comm),
  );
}

test("hostile：内容是播放列表的 .mp4 按 mov 强制解复用后失败，不读它引用的文件与地址", async (t) => {
  const { controls } = manifest();
  // 对照（随 ffmpeg 版本不同，只记录不断言）：不强制解复用器时 ffprobe 把它认成什么、有没有去读它引用的文件
  t.diagnostic(`对照，不强制解复用器：${JSON.stringify(controls.playlist)}`);
  arm(fx("canary.ts"));

  const probed = await probe("playlist.mp4");
  assert.equal(probed.status, 422);
  assert.equal(probed.json.ok, false);
  assert.equal(probed.json.error.code, "demux_failed");
  assert.equal(probed.json.report, undefined, "没有任何流信息流出来");
  const drawn = await posterOf("playlist.mp4");
  assert.equal(drawn.status, 422);

  assertNotRead(t, "canary.ts", "播放列表引用的文件没有被读过");
  // 它引用的外部地址：容器没有网卡（sandbox 用例），ffmpeg 的协议白名单里也只有 file
  assert.ok(!existsSync(fx("out-hostile.jpg")));
});

test("hostile：带外部引用的 mov 不被跟随", async (t) => {
  const { controls } = manifest();
  // 对照：打开 enable_drefs 时 ffmpeg 会去读被引用的文件并抽出帧，说明这条引用是活的
  assert.equal(controls.dref.followedWhenEnabled, true);
  assert.equal(controls.dref.targetReadWhenEnabled, true);
  arm(fx("dref-target.mov"));

  const probed = await probe("dref.mov");
  // 流的参数写在 dref.mov 自己的 moov 里，读得到；媒体数据在被引用的文件里，读不到
  if (probed.status === 200) assert.equal(probed.json.report.streams.length, 1);
  else assert.equal(probed.json.error.code, "demux_failed");
  const drawn = await posterOf("dref.mov");
  assert.equal(drawn.status, 422, "不跟随引用就抽不出帧");
  assert.ok(["demux_failed", "no_frame"].includes(drawn.json.error.code), drawn.json.error.code);

  assertNotRead(t, "dref-target.mov", "被引用的文件没有被读过");
  assert.ok(!existsSync(fx("out-hostile.jpg")));
});

test("hostile：跑不完的输入在硬超时内被杀，没有残留进程，服务照常可用", async (t) => {
  // slow.mp4 只有第一帧是同步帧：抽末尾一帧要从头解码，远超过这里给的 1 秒。
  // 硬超时的上限是 30 / 90 秒；请求里的 timeoutMs 只能把它调短，这里调到 1 秒，免得每次验证都等满 30 秒
  const atMs = (SLOW.seconds - 1) * 1000;
  // 先不调短，量一下它本来要跑多久：至少是下面那 1 秒的两倍，否则“被杀”就是空话
  const full = await posterOf("slow.mp4", { atMs });
  t.diagnostic(`不调短硬超时：${full.status}，${full.ms}ms`);
  assert.ok(
    full.status === 504 || (full.status === 200 && full.ms > 2000),
    `${full.status} ${full.ms}ms`,
  );
  rmSync(fx("out-hostile.jpg"), { force: true });

  const killed = await posterOf("slow.mp4", { atMs, timeoutMs: 1000 });
  assert.equal(killed.status, 504, JSON.stringify(killed.json));
  assert.equal(killed.json.error.code, "timeout");
  assert.ok(killed.ms >= 1000 && killed.ms < 3000, `用了 ${killed.ms}ms`);

  assert.deepEqual(await mediaProcesses(), [], "没有残留的 ffmpeg / ffprobe");
  const leftovers = readdirSync(fx("")).filter(
    (name) => name.endsWith(".part") || name === "out-hostile.jpg",
  );
  assert.deepEqual(leftovers, [], "没有留下半成品");

  const { json } = await healthz();
  assert.equal(json.stats.running, 0, "并发名额已经还回去");
  assert.equal((await probe("portrait.mp4")).status, 200);
});

test("hostile：timeoutMs 不能把硬超时调长，也不能小于 1 秒", async () => {
  const { json } = await healthz();
  assert.deepEqual(
    [json.limits.probeTimeoutMs, json.limits.posterTimeoutMs, json.limits.stampTimeoutMs],
    [30_000, 30_000, 90_000],
  );
  for (const timeoutMs of [0, 999, 1.5, "1000", null]) {
    const { status, json: body } = await probe("portrait.mp4", { timeoutMs });
    assert.equal(status, 400, `timeoutMs=${String(timeoutMs)}`);
    assert.equal(body.error.code, "bad_request");
  }
  // 给一个比上限大得多的值：照常办成（按上限算，不报错）
  assert.equal((await probe("portrait.mp4", { timeoutMs: 3_600_000 })).status, 200);
});

test("hostile：带 .. 或绝对路径的请求被拒", async () => {
  const bad = [
    "../etc/passwd",
    "/etc/passwd",
    `${FX}/../../etc/passwd`,
    `${FX}/../${FX}/portrait.mp4`,
    `${FX}/./portrait.mp4`,
    `${FX}//portrait.mp4`,
    `/work/${FX}/portrait.mp4`,
    `file:${FX}/portrait.mp4`,
    `${FX}/%2e%2e/portrait.mp4`,
    `${FX}\\portrait.mp4`,
    `${FX}/.hidden.mp4`,
    ".sock/mediatool.sock",
    "portrait.mp4",
    FX,
    "",
    `${FX}/${"a".repeat(600)}.mp4`,
    42,
    null,
  ];
  for (const path of bad) {
    const probed = await call("POST", "/probe", { path, demuxers: ["mov"] });
    assert.equal(probed.status, 400, `probe ${String(path)}`);
    assert.equal(probed.json.error.code, "bad_path");
  }
  const good = `${FX}/portrait.mp4`;
  for (const outPath of [
    "../x.jpg",
    "/tmp/x.jpg",
    "/work/x.jpg",
    "other/x.jpg",
    `${FX}/../x.jpg`,
    `${FX}/no-such-dir/x.jpg`,
  ]) {
    const drawn = await call("POST", "/poster", { path: good, demuxer: "mov", atMs: 0, outPath });
    assert.equal(drawn.status, 400, `poster outPath ${outPath}`);
    assert.equal(drawn.json.error.code, "bad_path");
    const stamped = await call("POST", "/stampAigc", {
      path: good,
      outPath,
      aigcJson: JSON.stringify(AIGC),
    });
    assert.equal(stamped.status, 400, `stampAigc outPath ${outPath}`);
  }
  assert.equal(
    (await call("POST", "/probe", { path: `${FX}/no-such.mp4`, demuxers: ["mov"] })).status,
    404,
  );
  // 输出撞上输入：直接写会把输入盖掉
  const clash = await call("POST", "/poster", {
    path: good,
    demuxer: "mov",
    atMs: 0,
    outPath: good,
  });
  assert.equal(clash.status, 400);
  assert.equal(clash.json.error.code, "bad_path");
});

test("hostile：经符号链接指到共享目录之外的路径被拒；目录、套接字不当文件读", async () => {
  for (const name of ["link-out.mp4", "link-dir"]) rmSync(fx(name), { force: true });
  symlinkSync("/etc/passwd", fx("link-out.mp4"));
  symlinkSync("/etc", fx("link-dir"));
  try {
    for (const path of [`${FX}/link-out.mp4`, `${FX}/link-dir/passwd`]) {
      const probed = await call("POST", "/probe", { path, demuxers: ["mov"] });
      assert.equal(probed.status, 400, path);
      assert.equal(probed.json.error.code, "bad_path");
    }
    const drawn = await call("POST", "/poster", {
      path: `${FX}/portrait.mp4`,
      demuxer: "mov",
      atMs: 0,
      outPath: `${FX}/link-dir/x.jpg`,
    });
    assert.equal(drawn.status, 400);
  } finally {
    for (const name of ["link-out.mp4", "link-dir"]) rmSync(fx(name), { force: true });
  }
});

test("hostile：解复用器只认登记过的几种，按内容探测与播放列表类的都不给", async () => {
  for (const demuxers of [
    ["hls"],
    ["concat"],
    ["lavfi"],
    ["mov", "hls"],
    [],
    ["mov", "mov", "mov", "mov"],
    "mov",
  ]) {
    const probed = await call("POST", "/probe", { path: `${FX}/playlist.mp4`, demuxers });
    assert.equal(probed.status, 400, JSON.stringify(demuxers));
    assert.equal(probed.json.error.code, "bad_request");
  }
});

test("hostile：请求体超过 64KB、不是 JSON 对象、没有的操作，都被拒", async () => {
  const big = await call("POST", "/probe", {
    path: `${FX}/portrait.mp4`,
    demuxers: ["mov"],
    pad: "x".repeat(70_000),
  });
  assert.equal(big.status, 413);
  for (const body of ["not json", "[]", "null", '"text"']) {
    assert.equal((await call("POST", "/probe", body)).status, 400);
  }
  assert.equal((await call("POST", "/docText", {})).status, 404);
  assert.equal((await call("GET", "/probe")).status, 404);
});
