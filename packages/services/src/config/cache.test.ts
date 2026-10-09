// 版本号缓存、版本范围、规则匹配的用例（任务书 W0-18 第 7 节第 6 条与第 4 条的一部分）。不连库、不连 Redis。
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClock } from "../testing/index.js";

import {
  CONFIG_NAMESPACES,
  createConfigCache,
  HARD_EXPIRE_MS,
  PROBE_INTERVAL_MS,
  PROBE_TIMEOUT_MS,
  STALE_TOLERANCE_MS,
  versionKey,
} from "./cache.js";
import type { VersionStore } from "./cache.js";
import { matchesRule } from "./flags.js";
import type { ConfigProblem } from "./types.js";
import { compareVersions, matchesVersionRange, parseVersion } from "./version.js";

/** 内存里的版本号存储：可以让它“连不上”，记下被问了几次 */
function fakeStore() {
  const values = new Map<string, number>();
  const state = { down: false, gets: 0 };
  const store: VersionStore = {
    get(key) {
      state.gets += 1;
      if (state.down) return Promise.reject(new Error("ECONNREFUSED"));
      const value = values.get(key);
      return Promise.resolve(value === undefined ? null : String(value));
    },
    incr(key) {
      if (state.down) return Promise.reject(new Error("ECONNREFUSED"));
      const next = (values.get(key) ?? 0) + 1;
      values.set(key, next);
      return Promise.resolve(next);
    },
  };
  return { store, state, values };
}

function setup(options: { redis?: VersionStore | null } = {}) {
  const clock = createClock();
  const fake = fakeStore();
  const problems: ConfigProblem[] = [];
  const cache = createConfigCache({
    clock,
    redis: options.redis === undefined ? fake.store : options.redis,
    report: (problem) => problems.push(problem),
  });
  let loads = 0;
  const load = (nextSwitchAt?: Date) => () => {
    loads += 1;
    return Promise.resolve({ data: `第 ${String(loads)} 次装载`, nextSwitchAt });
  };
  return { clock, cache, problems, load, loads: () => loads, ...fake };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("版本号缓存（D6 第 4.6 节）", () => {
  it("协议配置追加独立命名空间，保留原完整集合", () => {
    expect(CONFIG_NAMESPACES).toEqual(["dict", "param", "site", "flag", "checklist", "agreement"]);
  });

  it("协议写后信号让另一实例重读，站点版本与缓存保持独立", async () => {
    const { cache, clock, store } = setup();
    const peer = createConfigCache({ clock, redis: store });
    let value = "旧版";
    const load = () => Promise.resolve({ data: value });
    expect(await peer.read("agreement", load)).toBe("旧版");
    expect(await peer.read("site", load)).toBe("旧版");
    value = "新版";
    await cache.bump("agreement");
    expect(await cache.version("agreement")).toBe(1);
    expect(await cache.version("site")).toBe(0);
    expect(await peer.read("agreement", load)).toBe("旧版");
    clock.advance(PROBE_INTERVAL_MS);
    expect(await peer.read("agreement", load)).toBe("新版");
    expect(await peer.read("site", load)).toBe("旧版");
    expect(versionKey("agreement", "lyx:test:")).toBe("lyx:test:cfg:ver:agreement");
  });

  it("探测间隔内不碰 Redis；版本号没变不重读库", async () => {
    const { cache, clock, load, loads, state } = setup();
    expect(await cache.read("param", load())).toBe("第 1 次装载");
    expect(await cache.read("param", load())).toBe("第 1 次装载");
    expect(state.gets).toBe(1);
    clock.advance(PROBE_INTERVAL_MS);
    expect(await cache.read("param", load())).toBe("第 1 次装载");
    expect([loads(), state.gets]).toEqual([1, 2]);
  });

  it("别的进程把版本号加了 1：下一次探测即重读", async () => {
    const { cache, clock, load, loads, store } = setup();
    await cache.read("dict", load());
    await store.incr(versionKey("dict"));
    // 还在探测间隔内：仍是旧值
    clock.advance(PROBE_INTERVAL_MS - 1);
    expect(await cache.read("dict", load())).toBe("第 1 次装载");
    clock.advance(1);
    expect(await cache.read("dict", load())).toBe("第 2 次装载");
    expect(loads()).toBe(2);
  });

  it("本进程 bump：版本号加 1，自己手里的旧值立刻丢掉；别的命名空间不受影响", async () => {
    const { cache, load, loads, values } = setup();
    await cache.read("flag", load());
    await cache.read("site", load());
    await cache.bump("flag");
    expect(values.get("cfg:ver:flag")).toBe(1);
    expect(await cache.version("flag")).toBe(1);
    expect(await cache.version("site")).toBe(0);
    expect(await cache.read("flag", load())).toBe("第 3 次装载");
    expect(await cache.read("site", load())).toBe("第 2 次装载");
    expect(loads()).toBe(3);
  });

  it("Redis 不可用：60 秒内用旧值，且一个探测间隔只试一次；之后重读库", async () => {
    const { cache, clock, load, loads, state, problems } = setup();
    await cache.read("param", load());
    state.down = true;
    clock.advance(PROBE_INTERVAL_MS);
    expect(await cache.read("param", load())).toBe("第 1 次装载");
    expect(await cache.read("param", load())).toBe("第 1 次装载");
    expect(state.gets).toBe(2);
    expect(problems.map((problem) => problem.kind)).toEqual(["version_unavailable"]);
    clock.advance(STALE_TOLERANCE_MS - PROBE_INTERVAL_MS);
    expect(await cache.read("param", load())).toBe("第 2 次装载");
    // Redis 一直不可用：每 60 秒重读一次库
    clock.advance(STALE_TOLERANCE_MS - PROBE_INTERVAL_MS);
    expect(await cache.read("param", load())).toBe("第 2 次装载");
    clock.advance(PROBE_INTERVAL_MS);
    expect(await cache.read("param", load())).toBe("第 3 次装载");
    // 恢复之后的第一次探测：手里的值不知道是哪个版本的，重读一次，此后照常
    state.down = false;
    clock.advance(PROBE_INTERVAL_MS);
    expect(await cache.read("param", load())).toBe("第 4 次装载");
    clock.advance(PROBE_INTERVAL_MS);
    expect(await cache.read("param", load())).toBe("第 4 次装载");
    expect(loads()).toBe(4);
  });

  it("Redis 不可用时 bump 不抛错；version 给本进程记着的", async () => {
    const { cache, load, state, problems } = setup();
    await cache.bump("site");
    await cache.read("site", load());
    state.down = true;
    expect(await cache.version("site")).toBe(1);
    await expect(cache.bump("site")).resolves.toBeUndefined();
    expect(problems.map((problem) => problem.kind)).toEqual([
      "version_unavailable",
      "version_unavailable",
    ]);
  });

  it("取版本号挂住不回：到时限当取不到，不拖住读配置的一方", async () => {
    vi.useFakeTimers();
    const hanging: VersionStore = {
      get: () => new Promise<string | null>(() => undefined),
      incr: () => Promise.resolve(1),
    };
    const { cache, load, problems } = setup({ redis: hanging });
    const reading = cache.read("param", load());
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    expect(await reading).toBe("第 1 次装载");
    expect(problems).toHaveLength(1);
  });

  it("到点切换：硬过期不晚于下一个切换时刻，版本号没变也重读", async () => {
    const { cache, clock, load, loads } = setup();
    const switchAt = new Date(clock.now().getTime() + 60_000);
    await cache.read("param", load(switchAt));
    clock.advance(59_999);
    expect(await cache.read("param", load())).toBe("第 1 次装载");
    clock.advance(1);
    expect(await cache.read("param", load())).toBe("第 2 次装载");
    expect(loads()).toBe(2);
  });

  it("没有切换时刻：装载满 10 分钟重读", async () => {
    const { cache, clock, load } = setup();
    await cache.read("checklist", load());
    clock.advance(HARD_EXPIRE_MS - 1);
    expect(await cache.read("checklist", load())).toBe("第 1 次装载");
    clock.advance(1);
    expect(await cache.read("checklist", load())).toBe("第 2 次装载");
  });

  it("同时来的读只装载一次；装载失败不留半截的条目", async () => {
    const { cache, load, loads } = setup();
    const results = await Promise.all([
      cache.read("dict", load()),
      cache.read("dict", load()),
      cache.read("dict", load()),
    ]);
    expect(results).toEqual(["第 1 次装载", "第 1 次装载", "第 1 次装载"]);
    expect(loads()).toBe(1);
    await expect(cache.read("site", () => Promise.reject(new Error("库连不上")))).rejects.toThrow(
      "库连不上",
    );
    expect(await cache.read("site", load())).toBe("第 2 次装载");
  });

  it("不给 Redis：只有本进程自己的 bump 与硬过期让它重读；键带前缀", async () => {
    const { cache, clock, load } = setup({ redis: null });
    await cache.read("param", load());
    clock.advance(PROBE_INTERVAL_MS * 3);
    expect(await cache.read("param", load())).toBe("第 1 次装载");
    await cache.bump("param");
    expect(await cache.read("param", load())).toBe("第 2 次装载");
    cache.invalidate();
    expect(await cache.read("param", load())).toBe("第 3 次装载");
    expect(versionKey("param", "lyx:prod:")).toBe("lyx:prod:cfg:ver:param");
  });
});

describe("版本号与范围", () => {
  it("解析与比较", () => {
    expect(parseVersion("1.20.3")).toEqual([1, 20, 3]);
    for (const bad of ["1.2", "v1.2.3", "1.2.3-beta", "", null, undefined]) {
      expect(parseVersion(bad), String(bad)).toBeNull();
    }
    expect(compareVersions([1, 2, 3], [1, 2, 3])).toBe(0);
    expect(compareVersions([1, 10, 0], [1, 9, 9])).toBeGreaterThan(0);
    expect(compareVersions([0, 9, 9], [1, 0, 0])).toBeLessThan(0);
  });

  it.each([
    ["1.2.0", ">=1.2.0", true],
    ["1.1.9", ">=1.2.0", false],
    ["1.9.9", ">=1.2.0 <2.0.0", true],
    ["2.0.0", ">=1.2.0 <2.0.0", false],
    ["2.0.0", "=2.0.0", true],
    ["2.0.1", ">2.0.0 <=2.0.1", true],
    ["1.10.0", ">1.9.0", true],
    // 写法不对、没带版本号：一律不命中
    ["1.2.0", "^1.2.0", false],
    ["1.2.0", "", false],
    ["1.2", ">=1.0.0", false],
    [null, ">=0.0.0", false],
  ])("%s 在不在 %s 里：%s", (version, range, expected) => {
    expect(matchesVersionRange(version, range)).toBe(expected);
  });
});

describe("规则匹配：写了的条件都满足才命中", () => {
  const entity = "019a0000-0000-7000-8000-000000000001";

  it("四种条件各自的命中与不命中", () => {
    expect(matchesRule({ platform: ["ios"] }, { platform: "ios" })).toBe(true);
    expect(matchesRule({ platform: ["ios"] }, { platform: "android" })).toBe(false);
    expect(matchesRule({ clientVersion: ">=1.2.0" }, { clientVersion: "1.3.0" })).toBe(true);
    expect(matchesRule({ clientVersion: ">=1.2.0" }, { clientVersion: "1.1.0" })).toBe(false);
    expect(matchesRule({ envVersion: ["trial"] }, { envVersion: "trial" })).toBe(true);
    expect(matchesRule({ envVersion: ["trial"] }, { envVersion: "release" })).toBe(false);
    expect(matchesRule({ entityIds: [entity] }, { entityId: entity })).toBe(true);
    expect(matchesRule({ entityIds: [entity] }, { entityId: "别的主体" })).toBe(false);
  });

  it("上下文里缺的那一项当不满足；几个条件要同时满足", () => {
    expect(matchesRule({ platform: ["ios"] }, {})).toBe(false);
    expect(matchesRule({ entityIds: [entity] }, { entityId: null })).toBe(false);
    const when = { platform: ["ios"], clientVersion: ">=2.0.0" };
    expect(matchesRule(when, { platform: "ios", clientVersion: "2.0.0" })).toBe(true);
    expect(matchesRule(when, { platform: "ios", clientVersion: "1.9.0" })).toBe(false);
    expect(matchesRule(when, { platform: "android", clientVersion: "2.0.0" })).toBe(false);
  });
});
