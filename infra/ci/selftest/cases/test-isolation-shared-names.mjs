// W0-05b 的门禁：测试隔离（CI 里的 pnpm test:isolation --scope connected）。它起两个会话同时跑连库的测试项目，
// 再核对两边的用量记录：用的库名与 Redis 前缀不许有交集。这里造两份有交集的记录，只跑它的核对部分（--check）：
// 真跑时核对的是同一段代码，整条命令太重，不在反例里再跑一遍。
// 核对被拿掉、或只看两边的退出码不看交集时，这一例会红。
const usage = (session, extra = []) =>
  [
    { kind: "database", value: `lyx_test_tpl_${session}` },
    { kind: "database", value: `lyx_test_db_${session}_1` },
    { kind: "redis", value: `lyx:test:${session}:1:` },
    {
      kind: "parallel",
      value: [1, 2, 3, 4].map((worker) => `lyx_test_db_${session}_${worker}_par`),
    },
    ...extra,
  ]
    .map((record) => `${JSON.stringify(record)}\n`)
    .join("");

const SCRIPT = "packages/services/src/testing/isolation.mjs";

export default {
  gate: "测试隔离（test:isolation）",
  mutation: "乙会话的用量记录里出现了甲会话的一个库名与一个 Redis 前缀",
  reason: /不通过：库名有交集：lyx_test_db_ia_1\n[\s\S]*不通过：Redis 前缀有交集：lyx:test:ia:1:/,
  run(ctx) {
    const dir = ctx.tempDir();
    ctx.writeFiles(dir, {
      "a.jsonl": usage("ia"),
      "b.jsonl": usage("ib"),
      "b-shared.jsonl": usage("ib", [
        { kind: "database", value: "lyx_test_db_ia_1" },
        { kind: "redis", value: "lyx:test:ia:1:" },
      ]),
    });
    const file = (name) => `${dir}/${name}`;
    const baseline = ctx.node(SCRIPT, ["--check", file("a.jsonl"), file("b.jsonl")]);
    if (baseline.status !== 0) {
      throw new Error(`没有交集的两份记录没通过核对：${baseline.output.trim()}`);
    }
    return ctx.node(SCRIPT, ["--check", file("a.jsonl"), file("b-shared.jsonl")]);
  },
};
