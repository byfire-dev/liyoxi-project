#!/usr/bin/env node
// “类型解析不靠提升”检查（CLAUDE.md 第 5 节“两个 React 大版本各自安装，不提升”；来历与修法见 infra/ci/README.md 第 7 节）。
//
// 用法：node infra/ci/check-type-hoist.mjs [--root <目录>] [--all]      根脚本是 pnpm check:type-hoist
//   --root  仓库根（有 pnpm-workspace.yaml 与 node_modules 的那一层）；不给时是当前目录
//   --all   查工作区里每个带 tsconfig.json 的工程；不给时只查写 JSX 的工程（展开后的 tsconfig 里有 jsx 选项）
// 背景：pnpm 把虚拟仓库里的包各提升一份到 node_modules/.pnpm/node_modules（私有提升目录），同名的只放一份。
//   各项目直接声明的依赖排在最前、并成一层，同名的先到先得，先后跟着它收集各项目的次序走，不保证。
//   一个包的类型里写了 import "x"、自己又没把 x 声明成依赖时，tsc 顺着目录往上找，最后落在提升目录里的那一份 x 上。
//   各工程装的 x 是同一份时没有问题；不是同一份（小程序装 @types/react 18、后台装 19），解析到哪一份就看
//   这一次安装提升了谁，类型检查时过时不过。
// 口径：对每个工程，照它的 tsconfig 建一遍程序（只读文件、解析导入，不做类型检查），然后查两条。
//   1. 经私有提升目录解析到的包，工作区各工程自己装的（<工程>/node_modules/<包名>）必须是同一份。不是同一份即失败：
//      这一次提升的恰好是对的那一份也算，要拦的是“取决于提升”，不是“这一次错了”。
//      版本不同算两份，版本相同而 peer 解析不同的也算两份。
//   2. 工程自己声明的类型包（package.json 里 @types/ 开头的依赖），程序里只许出现它自己装的那一份。
//      别的工程的那一份混进来（经提升目录，或 paths 钉错了地方）即失败。
// 退出码：0 通过；1 有违规；2 用法或环境错误（依赖没装、tsconfig 读不了、工作区清单认不出、一个工程都没查到）。
// 本脚本只用根上装的 typescript（pnpm typecheck 用的同一个），不引别的依赖。已知的限度：
//   只看类型解析（tsc 的口径）。构建工具怎么解析运行时的包不归它管：那边各包声明了 react 这个 peer，pnpm 逐包接好了。
//   第 1 条只认“各工程直接装得不一样”的包。没有哪个工程直接声明、只作为传递依赖装了几份的包，经提升目录解析到也不判：
//     它们提升哪一份由 pnpm 按依赖的深度与名字排序定，不随项目的次序变（依赖图里同一个包在不同工程下深浅差很多时
//     理论上仍可能变，没有遇到过）。判了会误伤：锁文件里多出一份不相干的传递依赖，就会让前端的这道检查红。
//   不带 --all 时只查写 JSX 的工程：两个 React 大版本是仓库里唯一有意装两份的；别的工程每个都要多建一遍程序，
//     耗时跟着服务端的代码量涨，CI 里不查。要全查加 --all。
//   工作区清单只认“目录/*”与不带通配符的目录两种写法，别的写法报错退出，不猜。
//   根上的 tsconfig.json、infra/tsconfig.json 与 infra/ci/fixtures 下的最小工程不是工作区包，不查。

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

function fail(message) {
  console.error(`类型解析不靠提升检查：${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = { root: process.cwd(), all: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--all") options.all = true;
    else if (flag === "--root") {
      const value = argv[(index += 1)];
      if (value === undefined) fail("--root 后面要跟一个目录");
      options.root = resolve(process.cwd(), value);
    } else
      fail(`不认识的参数 ${flag}。用法 node infra/ci/check-type-hoist.mjs [--root <目录>] [--all]`);
  }
  return options;
}

/** tsc 给出的路径一律用正斜杠 */
const slashed = (path) => path.split(sep).join("/");

/** pnpm-workspace.yaml 的 packages 一段 → 工作区包的目录（绝对路径，按字典序） */
function workspaceDirs(root) {
  const file = join(root, "pnpm-workspace.yaml");
  if (!existsSync(file)) fail(`找不到 ${file}：--root 要指到仓库根`);
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const start = lines.findIndex((line) => /^packages:\s*(?:#.*)?$/.test(line));
  if (start === -1) fail("pnpm-workspace.yaml 里没有 packages: 一段");
  const patterns = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const item = line.match(/^\s+-\s+(?:"([^"]+)"|'([^']+)'|([^\s#"']+))\s*(?:#.*)?$/);
    if (!item) fail(`pnpm-workspace.yaml 的 packages 里有一行认不出：${line.trim()}`);
    patterns.push(item[1] ?? item[2] ?? item[3]);
  }
  if (patterns.length === 0) fail("pnpm-workspace.yaml 的 packages 一段是空的");
  const dirs = new Set();
  for (const pattern of patterns) {
    const one = pattern.match(/^([^*!?[\]{}]+)\/\*$/);
    if (one) {
      const parent = join(root, one[1]);
      if (!existsSync(parent)) continue;
      for (const entry of readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.add(join(parent, entry.name));
      }
    } else if (/^[^*!?[\]{}]+$/.test(pattern)) dirs.add(join(root, pattern));
    else
      fail(
        `pnpm-workspace.yaml 的 packages 里有本脚本不认的匹配式：${pattern}（只认“目录/*”与不带通配符的目录）`,
      );
  }
  return [...dirs].filter((dir) => existsSync(join(dir, "package.json"))).sort();
}

/** 提升目录或 node_modules 之下的相对路径 → 包名（带 scope 的取两段） */
function packageNameAt(rest) {
  const [first, second] = rest.split("/");
  if (!first) return null;
  if (!first.startsWith("@")) return first;
  return second ? `${first}/${second}` : null;
}

const options = parseArgs(process.argv.slice(2));
if (!existsSync(options.root)) fail(`找不到目录 ${options.root}`);
const root = slashed(realpathSync(options.root));
const store = `${root}/node_modules/.pnpm`;
const hoistPrefix = `${store}/node_modules/`;
const packageDirs = workspaceDirs(root);
const projectDirs = packageDirs.filter((dir) => existsSync(join(dir, "tsconfig.json")));
if (!existsSync(store)) fail(`找不到 ${store}：先 pnpm install --frozen-lockfile`);

let ts;
try {
  ts = (await import("typescript")).default;
} catch (error) {
  fail(`加载不了 typescript：先 pnpm install --frozen-lockfile。${error.message}`);
}

/** 真实路径落在虚拟仓库的哪个条目里（<包名>@<版本>…）；不在里面时原样返回 */
function storeEntryOf(path) {
  return path.startsWith(`${store}/`) ? path.slice(store.length + 1).split("/")[0] : path;
}

const show = (dir) => relative(root, dir) || ".";

const installedCache = new Map();
/** 工作区各工程自己装的这个包各是哪一份：虚拟仓库的条目 → 装它的工程 */
function installedBy(name) {
  if (!installedCache.has(name)) {
    const copies = new Map();
    for (const dir of packageDirs) {
      const link = join(dir, "node_modules", name);
      if (!existsSync(link)) continue;
      const entry = storeEntryOf(slashed(realpathSync(link)));
      copies.set(entry, [...(copies.get(entry) ?? []), show(dir)]);
    }
    installedCache.set(name, copies);
  }
  return installedCache.get(name);
}

/** 照工程的 tsconfig 建程序，返回经提升目录解析到的包与程序里的全部文件 */
function inspect(parsed) {
  const host = ts.createCompilerHost(parsed.options);
  /** 包名 → 这一次提升到的真实路径 */
  const viaHoist = new Map();
  const note = (path, real) => {
    if (!path.startsWith(hoistPrefix)) return;
    const name = packageNameAt(path.slice(hoistPrefix.length));
    if (name !== null && !viaHoist.has(name)) viaHoist.set(name, real);
  };
  // tsc 在 node_modules 里找到东西后都会取它的真实路径：包一层，就知道哪些是从提升目录找到的
  const realpath = host.realpath ? host.realpath.bind(host) : (path) => path;
  host.realpath = (path) => {
    const real = realpath(path);
    note(path, real);
    return real;
  };
  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    host,
  });
  const files = program.getSourceFiles().map((file) => file.fileName);
  // preserveSymlinks 之类的设置下不取真实路径，文件名里直接带着提升目录
  for (const file of files) note(file, file);
  return { viaHoist, files };
}

const problems = [];
const checked = [];
const settled = new Set();

for (const dir of projectDirs) {
  const configPath = join(dir, "tsconfig.json");
  const configErrors = [];
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => configErrors.push(diagnostic),
  });
  configErrors.push(...(parsed?.errors ?? []));
  if (!parsed || configErrors.length > 0) {
    const text = configErrors
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "))
      .join("；");
    fail(`${show(dir)}/tsconfig.json 读不了：${text}`);
  }
  const writesJsx = parsed.options.jsx !== undefined && parsed.options.jsx !== ts.JsxEmit.None;
  if (!options.all && !writesJsx) continue;
  checked.push(show(dir));

  const { viaHoist, files } = inspect(parsed);

  // 第 1 条：经提升目录解析到的包，各工程自己装的必须是同一份
  for (const [name, real] of [...viaHoist].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const copies = installedBy(name);
    if (copies.size < 2) {
      settled.add(name);
      continue;
    }
    const who = [...copies]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([entry, dirs]) => `${entry}：${dirs.join("、")}`)
      .join("；");
    problems.push(
      `${show(dir)}: ${name} 经私有提升目录解析，而各工程自己装的不是同一份（${who}）；这一次提升的是 ${storeEntryOf(slashed(real))}`,
    );
  }

  // 第 2 条：工程自己声明的类型包，程序里只许出现它自己装的那一份
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const declared = Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  })
    .filter((name) => name.startsWith("@types/"))
    .sort();
  for (const name of declared) {
    const link = join(dir, "node_modules", name);
    if (!existsSync(link))
      fail(`${show(dir)} 声明了 ${name} 却没装上：先 pnpm install --frozen-lockfile`);
    const own = slashed(realpathSync(link));
    const marker = `/node_modules/${name}/`;
    const others = new Set();
    for (const file of files) {
      const at = file.lastIndexOf(marker);
      if (at === -1) continue;
      const copy = file.slice(0, at + marker.length - 1);
      if (copy !== own && slashed(realpathSync(copy)) !== own) others.add(storeEntryOf(copy));
    }
    if (others.size > 0) {
      problems.push(
        `${show(dir)}: 程序里出现了不是它自己装的 ${name}：${[...others].sort().join("、")}（它自己装的是 ${storeEntryOf(own)}）`,
      );
    }
  }
}

if (checked.length === 0) {
  fail(
    options.all
      ? "工作区里没有带 tsconfig.json 的工程，一个都没查"
      : "工作区里没有写 JSX 的工程（展开后的 tsconfig 里有 jsx 选项的），一个都没查；要查全部工程加 --all",
  );
}

if (problems.length > 0) {
  console.error(`类型解析不靠提升检查未通过，共 ${problems.length} 处：`);
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    [
      "各工程装得不一样的包，提升目录里放哪一份由 pnpm 收集各项目的先后决定，不保证：换一次安装，解析到的可能就是另一份，类型检查的结果跟着变。",
      "修法：让工程的 tsconfig 把这个包钉到它自己装的那一份（compilerOptions.paths，照 packages/config/tsconfig 下两份 React 预设的写法）。",
      "工程自己写了 paths 会整体顶掉预设里的 paths，要把预设里那几行一并抄上。来历见 infra/ci/README.md 第 7 节。",
      "查是谁引进来的：pnpm --dir <工程> exec tsc --noEmit -p tsconfig.json --explainFiles",
    ].join("\n"),
  );
  process.exit(1);
}

const hoisted = settled.size > 0 ? `（${[...settled].sort().join("、")}）` : "";
console.log(
  `类型解析不靠提升检查通过：查了 ${checked.length} 个工程（${checked.join("、")}）；经私有提升目录解析到的包 ${settled.size} 个${hoisted}，各工程自己装的没有不一致的；各工程声明的类型包在程序里都只有自己装的那一份。`,
);
