// 门禁：状态文件核对（CI 里的 node infra/ci/status-summary.mjs --check）。
// 状态汇总不入库，这一步不再比对汇总；它只查状态文件合不合规，这一条不能跟着丢：
// 目录里有一个合规的文件、一个状态取值越界的文件，核对必须失败，并点出是哪个文件的哪一项。
// 目录里另放一份与合规文件对得上的旧汇总：核对不读它，有它也不能放行。
const file = (id, status) =>
  [
    `# ${id} 示例包`,
    "",
    "| 项 | 内容 |",
    "| --- | --- |",
    `| 编号 | ${id} |`,
    "| 里程碑 | M9 |",
    `| 状态 | ${status} |`,
    "| PR | — |",
    "| 依赖 | — |",
    "| 评审级别 | 乙 |",
    "| 规模 | S |",
    "| 阻塞原因 | 无 |",
    "",
  ].join("\n");

export default {
  gate: "状态文件核对",
  mutation: "状态文件的状态写成表外的“已合并”，跑 --check",
  reason: /W9-02\.md：状态“已合并”不在取值范围内/,
  run(ctx) {
    const dir = ctx.tempDir();
    ctx.writeFiles(dir, { "W9-01.md": file("W9-01", "完成"), "W9-02.md": file("W9-02", "完成") });
    const first = ctx.node("infra/ci/status-summary.mjs", ["--dir", dir]);
    if (first.status !== 0) throw new Error(`基线汇总没生成出来：${first.output.trim()}`);
    const baseline = ctx.node("infra/ci/status-summary.mjs", ["--dir", dir, "--check"]);
    if (baseline.status !== 0) throw new Error(`合规的基线没通过核对：${baseline.output.trim()}`);
    ctx.writeFiles(dir, { "W9-02.md": file("W9-02", "已合并") });
    return ctx.node("infra/ci/status-summary.mjs", ["--dir", dir, "--check"]);
  },
};
