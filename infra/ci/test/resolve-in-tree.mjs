// 给 dependency-cruiser 的解析设界：解析结果落在工作目录之外的，一律当作解析不了。
// 只在 infra/ci/test/layers.test.ts 跑夹具时用（--webpack-config 指到本文件）；pnpm depcheck 不用。
//
// 为什么要设界：模块解析会沿目录一直往上找 node_modules。夹具里没有 node_modules，按包名写的引用
// 本该解析不了、留下包名本身；可夹具的上层（仓库根、检出所在的目录、家目录）装了同名的包时，引用会被
// 解析到那里去。终点随之变成 ../../…/node_modules/<包>/…，有的违规还会整条不见，夹具的结果就取决于
// 检出放在哪儿、外面装了什么。
//
// 为什么借 --webpack-config：仓库不用 webpack。dependency-cruiser 把这里的 resolve 一节原样交给
// enhanced-resolve；它自己的 options.enhancedResolveOptions 不收 restrictions，只有这个口子递得进去。
// 工作目录就是 dependency-cruiser 的基准目录（它取 process.cwd()），也就是夹具的根。

export default {
  resolve: { restrictions: [process.cwd()] },
};
