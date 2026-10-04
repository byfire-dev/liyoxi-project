// 全仓规则片段（D7 第 2.2 节 D9：全仓禁 axios）。
// 片段只放数据，不引任何包；插件与解析器由根 eslint.config.js 装配。

/** 全仓禁用的 import。后面的包要再禁别的，把自己的条目与这里的拼在一起，不要覆盖。 */
export const repoRestrictedImports = {
  paths: [
    {
      name: "axios",
      message: "全仓禁止 axios：服务端用全局 fetch，小程序用 Taro.request。",
    },
  ],
  patterns: [
    {
      group: ["axios/*"],
      message: "全仓禁止 axios：服务端用全局 fetch，小程序用 Taro.request。",
    },
  ],
};

export const repoRules = {
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
  "@typescript-eslint/no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
  "no-restricted-imports": ["error", repoRestrictedImports],
};
