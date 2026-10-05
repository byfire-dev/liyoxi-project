// W0-05b 的门禁：测试隔离（CI 里的 pnpm test:isolation --scope connected）。CI 的那一步只跑连库的测试项目，
// 范围是按“项目挂没挂 globalSetup”认的。范围要是缩过了头，连库、连 Redis 的用例一条没跑，两边照样“没有交集”：
// 所以核对里另有三项——两份记录都得有库、有 Redis 前缀、有“4 个 worker 同时在场”的那条记录。
// 这里造一份什么都没用到的记录，只跑核对部分（--check）。这三项被拿掉时，这一例会红。
const usage = (session) =>
  [
    { kind: "database", value: `lyx_test_tpl_${session}` },
    { kind: "database", value: `lyx_test_db_${session}_1` },
    { kind: "redis", value: `lyx:test:${session}:1:` },
    {
      kind: "parallel",
      value: [1, 2, 3, 4].map((worker) => `lyx_test_db_${session}_${worker}_par`),
    },
  ]
    .map((record) => `${JSON.stringify(record)}\n`)
    .join("");

const SCRIPT = "packages/services/src/testing/isolation.mjs";

export default {
  gate: "测试隔离（test:isolation）",
  mutation: "乙会话的用量记录是空的：连库、连 Redis 的用例一条没跑到",
  reason:
    /不通过：乙的用量记录里没有库：连库的用例没跑到\n[\s\S]*不通过：乙的用量记录里没有 Redis 前缀：连 Redis 的用例没跑到\n[\s\S]*不通过：乙没有“4 个 worker 同时在场、4 个互不相同的库”的记录/,
  run(ctx) {
    const dir = ctx.tempDir();
    ctx.writeFiles(dir, { "a.jsonl": usage("ia"), "b.jsonl": usage("ib"), "b-empty.jsonl": "" });
    const file = (name) => `${dir}/${name}`;
    const baseline = ctx.node(SCRIPT, ["--check", file("a.jsonl"), file("b.jsonl")]);
    if (baseline.status !== 0) {
      throw new Error(`两份都齐全的记录没通过核对：${baseline.output.trim()}`);
    }
    return ctx.node(SCRIPT, ["--check", file("a.jsonl"), file("b-empty.jsonl")]);
  },
};
