// 必过检查并行化的门禁：测试隔离的全量分成四片跑（node infra/ci/isolation-shard.mjs --shard <i>/4）。
// 每一片的名单是问 Vitest 得来的；跑完要对一遍：两个会话实际跑的用例文件数都等于名单的个数。
// 这里造两份会话日志，一份少跑了一个文件（过滤没对上、文件被悄悄漏掉时就是这样），只跑这道核对（--check-ran）：
// 必须失败并指出是哪一份。这道核对被拿掉时，这一例会红。不连库，不跑用例。
const log = (files) =>
  `\n Test Files  ${files} passed (${files})\n      Tests  486 passed (486)\n   Duration  104.62s\n`;

const SCRIPT = "infra/ci/isolation-shard.mjs";

export default {
  gate: "测试隔离的全量分片跑（isolation-shard.mjs）",
  mutation: "这一片应当跑 33 个用例文件，第二个会话只跑了 32 个",
  reason: /不通过：第 2 份日志跑了 32 个用例文件，这一片应当是 33 个：分片对不上/,
  run(ctx) {
    const dir = ctx.tempDir();
    ctx.writeFiles(dir, { "a.log": log(33), "b.log": log(32), "b-full.log": log(33) });
    const check = (...files) =>
      ctx.node(SCRIPT, ["--check-ran", "33", ...files.map((name) => `${dir}/${name}`)]);
    const baseline = check("a.log", "b-full.log");
    if (baseline.status !== 0) {
      throw new Error(`两份都跑满的日志没通过核对：${baseline.output.trim()}`);
    }
    return check("a.log", "b.log");
  },
};
