// 历史耗时只用于分配；测试全集和原始分片始终由 Vitest 提供。
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const identity = ({ project, file }) => `${project}\0${file}`;

export function parseIsolationTimings(value) {
  if (
    value?.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.defaultMilliseconds) ||
    value.defaultMilliseconds <= 0 ||
    !Array.isArray(value.files)
  ) {
    throw new Error("隔离调度提示格式无效");
  }
  const weights = new Map();
  for (const row of value.files) {
    if (
      typeof row?.file !== "string" ||
      !/^(packages|apps)\/[a-zA-Z0-9_./-]+\.test\.ts$/.test(row.file) ||
      row.file.split("/").includes("..") ||
      !Number.isSafeInteger(row.milliseconds) ||
      row.milliseconds <= 0 ||
      weights.has(row.file)
    ) {
      throw new Error("隔离调度提示含无效或重复文件");
    }
    weights.set(row.file, row.milliseconds);
  }
  return { defaultMilliseconds: value.defaultMilliseconds, weights };
}

export function balanceIsolationShards(baseline, timings) {
  if (baseline.length === 0) throw new Error("隔离调度缺少 Vitest 原始分片");
  const capacities = baseline.map((files) => files.length);
  if (Math.max(...capacities) - Math.min(...capacities) > 1) {
    throw new Error("Vitest 原始分片的文件数不均衡");
  }
  const rows = baseline.flat();
  const original = new Map();
  for (const [shard, files] of baseline.entries()) {
    for (const row of files) {
      const key = identity(row);
      if (original.has(key)) throw new Error("Vitest 原始分片含重复测试文件");
      original.set(key, shard);
    }
  }
  const owner = new Map(original);
  const weighted = rows
    .filter((row) => (timings.weights.get(row.file) ?? 0) > timings.defaultMilliseconds)
    .sort(
      (a, b) =>
        timings.weights.get(b.file) - timings.weights.get(a.file) ||
        compare(identity(a), identity(b)),
    );
  const weightedIds = new Set(weighted.map(identity));
  const loads = baseline.map(() => 0);
  const heavyCounts = baseline.map(() => 0);
  for (const row of weighted) {
    const key = identity(row);
    const eligible = capacities
      .map((_, shard) => shard)
      .filter((shard) => heavyCounts[shard] < capacities[shard]);
    eligible.sort(
      (a, b) =>
        loads[a] - loads[b] ||
        heavyCounts[a] - heavyCounts[b] ||
        Number(a !== original.get(key)) - Number(b !== original.get(key)) ||
        a - b,
    );
    const shard = eligible[0];
    owner.set(key, shard);
    loads[shard] += timings.weights.get(row.file) - timings.defaultMilliseconds;
    heavyCounts[shard] += 1;
  }

  // 轻文件先保留原 hash 归属，仅从超额片末尾搬到缺额片，避免全套无关文件换片。
  const counts = baseline.map(() => 0);
  for (const shard of owner.values()) counts[shard] += 1;
  for (let source = 0; source < baseline.length; source++) {
    const candidates = baseline[source].filter((row) => !weightedIds.has(identity(row))).reverse();
    while (counts[source] > capacities[source]) {
      const row = candidates.shift();
      if (!row) throw new Error("隔离调度无法保持原文件数");
      const eligible = capacities
        .map((_, shard) => shard)
        .filter((shard) => counts[shard] < capacities[shard]);
      eligible.sort((a, b) => loads[a] - loads[b] || counts[a] - counts[b] || a - b);
      const destination = eligible[0];
      if (destination === undefined) throw new Error("隔离调度缺少目标分片");
      owner.set(identity(row), destination);
      counts[source] -= 1;
      counts[destination] += 1;
    }
  }
  const result = baseline.map(() => []);
  for (const row of rows) result[owner.get(identity(row))].push(row);
  if (result.some((files, shard) => files.length !== capacities[shard])) {
    throw new Error("隔离调度改变了原分片文件数");
  }
  return result;
}
