import { coverageInput } from "./machines-coverage-unlisted.mjs";

export default {
  gate: "状态机覆盖基线只减不增",
  mutation: "追加去除一行后又追加恢复那一行",
  reason: /覆盖基线只减不增：/,
  run(ctx) {
    const input = coverageInput(ctx);
    const last = JSON.parse(input.baseline.trim().split("\n")[0]);
    if (!last.rows.length) throw new Error("首份基线没有历史存量，需新已知迁移夹具");
    const lower = { ...last, rows: last.rows.slice(0, -1) };
    ctx.writeFiles(input.dir, {
      "baseline.jsonl": `${JSON.stringify(last)}\n${JSON.stringify(lower)}\n${JSON.stringify(last)}\n`,
    });
    return ctx.run(input.tool, [...input.args, "--baseline", input.path]);
  },
};
