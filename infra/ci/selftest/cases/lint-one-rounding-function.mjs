// 逐个语法变体单独跑，不能靠其中一条报错掩盖其他绕过方式。
export default {
  gate: "lint：业务只有一个取整函数",
  mutation: "src 业务直接调用、方括号、解构与金额替换被拦；精确计时、测试与构建脚本通过",
  reason: "lyx/one-rounding-function",
  async run(ctx) {
    const cases = [
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "const { Math: math } = globalThis; export const value = math.round(12.5);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        'const { ["Math"]: math } = globalThis; export const value = math["round"](12.5);',
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "const root = globalThis; const { Math: math } = root; export const value = math.round(12.5);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "const { Math: math } = globalThis; const copy = math; const { round } = copy; export const value = round(12.5);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "const { Number: ctor } = globalThis; const { toFixed: fixed } = ctor.prototype; export const value = fixed.call(12.5, 2);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "export const value = globalThis.Math.round(12.5);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "const math = Math; export const value = math.round(12.5);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        'const method = "round" as const; export const value = Math[method](12.5);',
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "export const value = Math[`round`](12.5);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "const { Math: { round } } = globalThis; export const value = round(12.5);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "export const value = Math.round(12.5);",
      ],
      ["apps/api/src/lyxtest-rounding.ts", 'export const value = Math["round"](12.5);'],
      [
        "apps/worker/src/lyxtest-rounding.ts",
        "const { round } = Math; export const value = round(12.5);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "export const value = (12.5).toFixed(2);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        'export const value = (12.5)["toFixed"](2);',
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "const { toFixed: fixed } = Number.prototype; export const value = fixed.call(12.5, 2);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        'export const value = parseFloat("12.5");',
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        'export const value = Number["parseFloat"]("12.5");',
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        'const { parseFloat: parse } = Number; export const value = parse("12.5");',
      ],
      ["apps/api/src/http/access-log.ts", "export const value = Math.round(125);"],
      ["apps/worker/src/lease.ts", "export const value = Math.round(125);"],
      ["apps/worker/src/cli/redis-compat.ts", "export const value = (125).toFixed(1);"],
      ["packages/services/src/testing/m0-chain.ts", "export const value = (125).toFixed(1);"],
    ];
    const outputs = [];
    for (const [filename, input] of cases) {
      const result = ctx.node(
        "node_modules/eslint/bin/eslint.js",
        ["--stdin", "--stdin-filename", filename],
        { input },
      );
      outputs.push(result.output);
      if (result.status !== 1 || !result.output.includes("lyx/one-rounding-function"))
        return { status: 0, output: `没有拦住 ${filename}：${input}\n${result.output}` };
    }
    const allowed = [
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "const { Math: math } = globalThis; export const value = math.floor(12.5) + math.trunc(12.5);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "const { Math: { floor: round } } = globalThis; export const value = round(12.5);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "const { floor: fn } = Math; export const value = fn.round?.(12.5);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        "const { Math: local } = { Math: { round: (value: number) => value } }; export const value = local.round(12.5);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.ts",
        'const math = Math; const method = "min" as const; export const value = math[method](1, 2);',
      ],
      [
        "apps/api/src/http/access-log.ts",
        "const startedAt = 0; export const value = Math.round(performance.now() - startedAt);",
      ],
      ["apps/worker/src/lease.ts", "const late = 1; export const value = Math.round(late);"],
      [
        "apps/worker/src/cli/redis-compat.ts",
        "const samples = [1]; const q = 0.5; export const value = (samples[Math.floor(samples.length * q)] ?? 0).toFixed(1);",
      ],
      [
        "packages/services/src/testing/m0-chain.ts",
        "const waitMs = 1; export const value = (waitMs / 1000).toFixed(1);",
      ],
      [
        "packages/services/src/billing/lyxtest-rounding.test.ts",
        "export const value = Math.round(125);",
      ],
      ["apps/worker/scripts/build.mjs", "export const value = (125).toFixed(1);"],
    ];
    for (const [filename, input] of allowed) {
      const result = ctx.node(
        "node_modules/eslint/bin/eslint.js",
        ["--stdin", "--stdin-filename", filename],
        { input },
      );
      if (result.status !== 0)
        return { status: 0, output: `边界误报 ${filename}：${input}\n${result.output}` };
    }
    return { status: 1, output: outputs.join("\n") };
  },
};
