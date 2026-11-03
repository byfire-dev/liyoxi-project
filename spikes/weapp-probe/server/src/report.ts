import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { attemptSchema, Redactor, type RecordRow } from "./records.ts";

export function summarize(rows: RecordRow[], mode: "fake" | "real") {
  const clean = new Redactor();
  const selected = rows.filter((row) => row.probeMode === mode);
  const groups = new Map<string, RecordRow[]>();
  for (const row of selected) {
    const key = [
      row.item,
      row.device,
      row.system,
      row.baseLibrary,
      row.network,
      row.scenario,
      row.sizeBytes,
      row.mode ?? "—",
    ]
      .map(String)
      .map((value) => clean.text(value))
      .join(" | ");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const output = [
    `# X-01 ${mode === "fake" ? "替身演练" : "真机尝试"}汇总`,
    "",
    `生成于 ${new Date().toISOString()}；模式 ${mode}；${selected.length} 条。`,
    "",
    "本表仅是观测数据，不自动宣告通过。fake 不是真机证据；调试模式 V3/V7 只算初测。成功率分母包含失败、取消和中断；恢复成功是另一次尝试。缺数据仍记“未实测”。",
    "",
    "| 项 | 机型 | 系统 | 基础库 | 网络 | 场景 | 字节 | 落盘 | 尝试 | 成功 | 成功率 | 中位耗时 ms | 最大耗时 ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const [key, values] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const durations = values.map((row) => row.durationMs).sort((a, b) => a - b);
    const half = Math.floor(durations.length / 2);
    const median =
      durations.length % 2 ? durations[half]! : (durations[half - 1]! + durations[half]!) / 2;
    const successes = values.filter((row) => row.result === "success").length;
    output.push(
      `| ${key} | ${values.length} | ${successes} | ${((successes / values.length) * 100).toFixed(1)}% | ${median} | ${durations.at(-1)} |`,
    );
  }
  output.push(
    "",
    "## 尝试明细（已脱敏）",
    "",
    "| 时间 UTC | 项 | 场景 | 结果 | 错误码 | runId / 序号 | 已完成块 / 总块 | 本次发块 / 重传已完成块 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const row of selected)
    output.push(
      `| ${clean.text(row.recordedAt)} | ${row.item} | ${clean.text(row.scenario)} | ${row.result} | ${clean.text(row.errorCode)} | ${clean.text(row.runId ?? "—")} / ${row.index ?? "—"} | ${row.completedParts ?? "—"} / ${row.totalParts ?? "—"} | ${row.sentParts ?? "—"} / ${row.retransmittedParts ?? "—"} |`,
    );
  output.push(
    "",
    "## 业主观察（另填 CHECKLIST 记录栏后一起回传）",
    "",
    "| 项 | 当前数据 | 仍须人工记录 |",
    "| --- | --- | --- |",
  );
  for (const item of ["V19", "V8", "V3", "V7"])
    output.push(
      `| ${item} | ${selected.some((row) => row.item === item) ? "有尝试，待业主判定" : "未实测"} | ${item === "V19" ? "添加其他号码交互/数量、换微信同号、体验是否可接受" : item === "V8" ? "亮度分组、电脑轮询终点耗时、识别失败次数" : item === "V3" ? "未压缩续传分块交集、压缩匹配、实际120秒超时" : "两台主力机各80集、相册数量、低存储、清理后残留、目标体积/模式"} |`,
    );
  return `${output.join("\n")}\n`;
}
export function generateReport(root: string, mode: "fake" | "real") {
  const file = path.join(root, "server/.logs", `${mode}.jsonl`);
  const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
  const rows: RecordRow[] = lines.map((line) => {
    const input = JSON.parse(line) as RecordRow;
    const { recordedAt, probeMode, ...attempt } = input;
    if (!/^\d{4}-\d{2}-\d{2}T/.test(recordedAt) || !["real", "fake"].includes(probeMode))
      throw new Error("REPORT_INVALID_ROW");
    return { ...attemptSchema.parse(attempt), recordedAt, probeMode };
  });
  mkdirSync(path.join(root, "results"), { recursive: true });
  writeFileSync(
    path.join(root, "results", mode === "fake" ? "fake-summary.md" : "summary.md"),
    summarize(rows, mode),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const mode = process.env.PROBE_MODE ?? "real";
    if (!["real", "fake"].includes(mode)) throw 0;
    generateReport(path.resolve(import.meta.dirname, "../.."), mode as "fake" | "real");
    console.log(mode === "fake" ? "results/fake-summary.md" : "results/summary.md");
  } catch {
    console.error("REPORT_INVALID_ROW");
    process.exitCode = 1;
  }
}
