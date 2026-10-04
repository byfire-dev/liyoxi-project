import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根目录的绝对路径 */
export const repoRoot: string = fileURLToPath(new URL("../../../", import.meta.url)).replace(
  /\/$/,
  "",
);

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  /** stdout 与 stderr 接在一起，断言“输出里指出了什么”时用 */
  output: string;
}

/** 跑一条命令，不抛错，返回退出码与输出 */
export function run(command: string, args: readonly string[], cwd: string): RunResult {
  const result = spawnSync(command, [...args], { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { status: result.status ?? -1, stdout, stderr, output: `${stdout}\n${stderr}` };
}

/** 同 run，但不阻塞事件循环：被跑的命令要回头访问本进程里起的服务时用 */
export function runAsync(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code ?? -1, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
  });
}

/** 仓库外的临时目录；用完调 cleanup */
export function makeTempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** 按相对路径写文件，自动建目录 */
export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(dir, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** 在临时目录里跑 git，不受本机的钩子、签名、身份设置影响 */
export function git(dir: string, ...args: string[]): RunResult {
  const result = run(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=lyx-test",
      "-c",
      "user.email=lyx-test@example.invalid",
      ...args,
    ],
    dir,
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${result.stderr}`);
  return result;
}

/** 建一个临时 git 仓库，写入文件并全部加入暂存区 */
export function makeTempRepo(
  prefix: string,
  files: Record<string, string>,
): { dir: string; cleanup: () => void } {
  const temp = makeTempDir(prefix);
  git(temp.dir, "init", "-q");
  writeFiles(temp.dir, files);
  git(temp.dir, "add", "-A");
  return temp;
}
