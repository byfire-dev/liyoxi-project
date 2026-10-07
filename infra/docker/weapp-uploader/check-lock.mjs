#!/usr/bin/env node
// 独立 npm 锁与工作区锁分开；冻结安装前核完整闭包的发布时间，不设年龄豁免。
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

try {
  const { values } = parseArgs({ options: { since: { type: "string" } } });
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", import.meta.url), "utf8"));
  const previous = values.since ? JSON.parse(readFileSync(values.since, "utf8")) : null;
  const versions = (source) =>
    new Map(
      Object.entries(source.packages)
        .filter(([path]) => path)
        .map(([path, value]) => [
          path.split("node_modules/").at(-1) + "@" + value.version,
          { name: path.split("node_modules/").at(-1), version: value.version },
        ]),
    );
  if (lock.lockfileVersion !== 3) throw new Error("锁版本无效");
  for (const [path, value] of Object.entries(lock.packages)) {
    if (
      path &&
      (!value.version ||
        !/^sha512-/.test(value.integrity ?? "") ||
        !value.resolved?.startsWith("https://registry.npmjs.org/"))
    )
      throw new Error("锁的来源或 hash 无效");
  }
  const old = previous ? versions(previous) : new Map();
  const entries = [...versions(lock)].filter(([key]) => !old.has(key)).map(([, value]) => value);
  let index = 0;
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      while (index < entries.length) {
        const { name, version } = entries[index++];
        const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
          signal: AbortSignal.timeout(20_000),
        });
        if (!response.ok) throw new Error("registry 不可用");
        const metadata = await response.json();
        const published = Date.parse(metadata.time?.[version]);
        if (!Number.isFinite(published) || published > cutoff)
          throw new Error("版本未满七天或日期缺失");
      }
    }),
  );
  console.log(`独立 uploader 锁核对通过：${entries.length} 个版本满七天，完整 hash/来源有效`);
} catch {
  console.error("独立 uploader 锁核对失败；不继续安装或构建");
  process.exitCode = 2;
}
