// W0-19 的验收：驱动隔离。门禁是 W0-02 的规则 providers-via-types（仓库根的 .dependency-cruiser.cjs）。
// 反例现造：照 W0-19 交付的目录摆一棵小树，领域模块 media 除了引 providers/types.ts，
// 还直接引了驱动文件 providers/storage/minio.ts。
export default {
  gate: "依赖方向与分层（dependency-cruiser）",
  mutation: "领域模块引 providers 下 types 以外的文件：media 引 providers/storage/minio.ts",
  reason:
    /error providers-via-types: packages\/services\/src\/media\/index\.ts → packages\/services\/src\/providers\/storage\/minio\.ts/,
  run(ctx) {
    const dir = ctx.tempDir();
    ctx.writeFiles(dir, {
      "packages/services/src/providers/types.ts": "export {};\n",
      "packages/services/src/providers/storage/minio.ts": 'import "../types.js";\n\nexport {};\n',
      "packages/services/src/media/index.ts":
        'import "../providers/types.js";\nimport "../providers/storage/minio.js";\n\nexport {};\n',
    });
    return ctx.node(
      "node_modules/dependency-cruiser/bin/dependency-cruiser.mjs",
      ["packages", "--config", `${ctx.repoRoot}/.dependency-cruiser.cjs`],
      { cwd: dir },
    );
  },
};
