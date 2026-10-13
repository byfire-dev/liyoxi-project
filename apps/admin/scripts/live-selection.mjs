import { lstatSync } from "node:fs";

// 本机定点验收可用逗号分隔至多八个现有 live 文件；无参数仍为完整集合。
// 输入是文件名，不是 Playwright 正则。先核实再转成精确匹配，避免误选或零测试。
export function selectedLiveTests(value) {
  if (value === undefined) return [];
  const files = value.split(",");
  if (files.length > 8 || new Set(files).size !== files.length)
    throw new Error("--test-file 只接受一至八个不重复的精确 live 文件");
  return files.map((file) => {
    if (!/^test\/e2e\/live-[a-z0-9-]+\.spec\.ts$/.test(file))
      throw new Error("--test-file 必须是 test/e2e/live-*.spec.ts 中的精确文件名");
    let regular = false;
    try {
      regular = lstatSync(new URL(`../${file}`, import.meta.url)).isFile();
    } catch {
      // 不向用户输出任意路径或文件系统内部错误。
    }
    if (!regular) throw new Error(`未找到常规 live 用例文件：${file}`);
    return `(?:^|[/\\\\])${file.replaceAll("/", "[/\\\\]").replaceAll(".", "\\.")}$`;
  });
}
