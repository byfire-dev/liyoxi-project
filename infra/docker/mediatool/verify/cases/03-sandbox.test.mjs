// @ts-check
// 任务书 第 7 节第 5 条：容器约束成立。这里是容器自己报的事实（GET /selfcheck）；
// 另一半是编排脚本在宿主机上用 docker inspect 核对的配置（verify/run.mjs）。
import assert from "node:assert/strict";
import { test } from "node:test";

import { call } from "../lib/client.mjs";

/** 密钥类的环境变量名 */
const SECRET_LIKE =
  /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE|DATABASE_URL|REDIS_URL|_DSN|^(COS|CI|WXPAY|WECOM|OCR|SMS|MAIL|AWS|TENCENTCLOUD)_/i;

const sandbox = async () => {
  const { status, json } = await call("GET", "/selfcheck");
  assert.equal(status, 200);
  return json.sandbox;
};

test("sandbox：除回环以外没有启用的网卡、没有地址、没有路由，访问外部地址失败", async (t) => {
  const facts = await sandbox();
  /** @type {{ name: string, up: boolean, addresses: number }[]} */
  const devices = facts.interfaces;
  assert.deepEqual(
    devices.filter((device) => device.up).map((device) => device.name),
    ["lo"],
  );
  assert.deepEqual(
    devices.filter((device) => device.addresses > 0).map((device) => device.name),
    ["lo"],
  );
  assert.equal(facts.ipv4Routes, 0, "路由表是空的");
  assert.equal(facts.outbound, "ENETUNREACH", "连路由都没有，不是超时");
  // 有的内核会给每个网络命名空间自动建隧道占位设备（tunl0、gre0、sit0 之类）：关着的，没有地址。照实列出来
  const down = devices.filter((device) => !device.up).map((device) => device.name);
  t.diagnostic(`关着的设备：${down.length > 0 ? down.join("、") : "无"}`);
});

test("sandbox：根文件系统只读；/tmp 是 64MB 内存盘；共享目录可写", async () => {
  const facts = await sandbox();
  assert.deepEqual(
    { root: facts.write.root, app: facts.write.app, etc: facts.write.etc },
    { root: "EROFS", app: "EROFS", etc: "EROFS" },
  );
  assert.equal(facts.write.tmp, "ok");
  assert.equal(facts.tmpBytes, 64 * 1024 * 1024);
  assert.equal(facts.write.work, "ok");
});

test("sandbox：运行用户非 root，没有任何能力，开了 no-new-privileges", async () => {
  const facts = await sandbox();
  assert.equal(facts.uid, 1000);
  assert.equal(facts.gid, 1000);
  for (const mask of [facts.capEff, facts.capPrm, facts.capBnd]) {
    assert.match(mask, /^0+$/, "能力位全为 0");
  }
  assert.equal(facts.noNewPrivs, "1");
});

test("sandbox：环境变量里没有密钥类的键", async () => {
  const facts = await sandbox();
  const suspicious = facts.envKeys.filter((/** @type {string} */ key) => SECRET_LIKE.test(key));
  assert.deepEqual(suspicious, [], `全部的键：${facts.envKeys.join("、")}`);
});

test("sandbox：进程数上限 128、内存上限 1GB、CPU 上限 1 核", async (t) => {
  const { cgroup } = await sandbox();
  if (cgroup.pidsMax === null) {
    // cgroup v1 的宿主机上容器里看不到这几个文件：只由 docker inspect 那一半核对
    t.skip("容器里读不到 cgroup v2 的上限文件");
    return;
  }
  assert.equal(cgroup.pidsMax, "128");
  assert.equal(cgroup.memoryMax, String(1024 * 1024 * 1024));
  assert.equal(cgroup.cpuMax, "100000 100000");
});
