// 服务端规则片段（D7 第 2.2 节 D9：服务端禁 console.log）。日志走注入的 logger。

/** 服务端代码所在的路径 */
export const serverFiles = [
  "apps/api/**/*.{ts,js,mjs,cjs}",
  "apps/worker/**/*.{ts,js,mjs,cjs}",
  "packages/services/**/*.{ts,js,mjs,cjs}",
  "packages/db/**/*.{ts,js,mjs,cjs}",
];

export const serverRules = {
  "no-console": ["error", { allow: ["warn", "error"] }],
};

/** 脚本与配置文件放宽 console */
export const scriptFiles = ["**/scripts/**", "**/*.config.{js,cjs,mjs,ts}"];

export const scriptRules = {
  "no-console": "off",
};
