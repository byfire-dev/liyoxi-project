// @ts-check
// 容器自查：把“我现在受到哪些约束”如实报出来，给验证用例与预发复测（V11）核对。
// 只报事实，不下结论；环境变量只报键名，不报值。调用端可以在启动时调一次，约束不齐就不用这个容器。
import { readdir, readFile, rm, statfs, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";

/** 往一个目录里写个文件试试：写得进去返回 "ok"，否则返回错误码（只读根上是 EROFS） @param {string} dir */
async function tryWrite(dir) {
  const path = `${dir}/.lyx-selfcheck-${process.pid}`;
  try {
    await writeFile(path, "x");
    await rm(path, { force: true });
    return "ok";
  } catch (err) {
    return String(/** @type {NodeJS.ErrnoException} */ (err).code ?? "error");
  }
}

/**
 * 向一个外部地址发起 TCP 连接：没有网卡时立刻得到 ENETUNREACH。
 * 地址用 RFC 5737 留给文档的 192.0.2.1，不指向任何真实服务。
 * @returns {Promise<string>}
 */
function tryConnect() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "192.0.2.1", port: 80, timeout: 1500 });
    const done = (/** @type {string} */ outcome) => {
      socket.destroy();
      resolve(outcome);
    };
    socket.once("connect", () => done("connected"));
    socket.once("timeout", () => done("timeout"));
    socket.once("error", (err) => done(String(/** @type {NodeJS.ErrnoException} */ (err).code)));
  });
}

/** @param {string} path */
const readText = (path) =>
  readFile(path, "utf8").then(
    (content) => content.trim(),
    () => null,
  );

/**
 * 全部网络设备，连同是否启用、有几个地址。
 * 无网络的容器里除了 lo，还可能看到内核给每个网络命名空间自动建的隧道占位设备（tunl0、gre0、sit0 之类）：
 * 它们是关着的，没有地址也没有路由；容器没有 NET_ADMIN 能力，启用不了。所以要看的是“启用的”与“有地址的”。
 */
async function networkDevices() {
  const addresses = os.networkInterfaces();
  const devices = [];
  for (const entry of await readdir("/sys/class/net", { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile()) continue; // bonding_masters 这类是文件，不是设备
    const flags = Number(await readText(`/sys/class/net/${entry.name}/flags`));
    devices.push({
      name: entry.name,
      up: (flags & 1) === 1, // IFF_UP
      addresses: (addresses[entry.name] ?? []).length,
    });
  }
  return devices;
}

export async function selfcheck() {
  const status = (await readText("/proc/self/status")) ?? "";
  /** @param {string} name */
  const field = (name) => new RegExp(`^${name}:\\s*(\\S+)`, "m").exec(status)?.[1] ?? null;
  const tmp = await statfs("/tmp");
  return {
    uid: process.getuid?.() ?? null,
    gid: process.getgid?.() ?? null,
    interfaces: await networkDevices(),
    // IPv4 路由表的条数（去掉表头）。一条都没有，往外发的包无路可走
    ipv4Routes: ((await readText("/proc/net/route")) ?? "").split("\n").length - 1,
    outbound: await tryConnect(),
    envKeys: Object.keys(process.env).sort(),
    // 能力位全为 0 即 cap_drop: ALL 且非 root
    capEff: field("CapEff"),
    capPrm: field("CapPrm"),
    capBnd: field("CapBnd"),
    noNewPrivs: field("NoNewPrivs"),
    seccomp: field("Seccomp"),
    write: {
      root: await tryWrite("/"),
      app: await tryWrite("/app"),
      etc: await tryWrite("/etc"),
      tmp: await tryWrite("/tmp"),
      work: await tryWrite("/work/.sock"),
    },
    tmpBytes: tmp.blocks * tmp.bsize,
    // cgroup v2 下容器看得到自己的上限
    cgroup: {
      memoryMax: await readText("/sys/fs/cgroup/memory.max"),
      pidsMax: await readText("/sys/fs/cgroup/pids.max"),
      cpuMax: await readText("/sys/fs/cgroup/cpu.max"),
    },
  };
}
