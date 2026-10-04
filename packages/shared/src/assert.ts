// 子路径 @liyoxi/shared/assert。借自参考工程 packages/shared/src/assert.ts，只取 assertNever。

/** 穷尽性检查：switch 漏分支时编译期报错，运行期走到即抛错 */
export function assertNever(value: never, message = "未处理的分支"): never {
  throw new Error(`${message}: ${String(value)}`);
}
