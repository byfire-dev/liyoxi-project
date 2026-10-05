// 客户端版本号的比较与范围匹配（W0-18）。开关规则的 clientVersion、最低版本（约定 C71）都用它。
// 版本号是三段数字（1.2.3）；范围是用空格连起来的比较式（>=1.2.0 <2.0.0），写法见契约的 VERSION_RANGE_PATTERN。
// 不引 semver 库：只有这一种写法，十几行就够。

export type Version = readonly [number, number, number];

const VERSION = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})$/;
const COMPARATOR = /^(>=|<=|>|<|=)(\d{1,5}\.\d{1,5}\.\d{1,5})$/;

/** 解析版本号；写法不对返回 null */
export function parseVersion(text: string | null | undefined): Version | null {
  const match = typeof text === "string" ? VERSION.exec(text) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** 比较两个版本：负数即 a 小于 b，0 相等，正数即 a 大于 b */
export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/**
 * 版本在不在范围里。版本号或范围写法不对一律算不在：
 * 规则写坏了、客户端没带版本号，都不该让一条按版本放开的规则命中。
 */
export function matchesVersionRange(version: string | null | undefined, range: string): boolean {
  const actual = parseVersion(version);
  if (!actual || range === "") return false;
  return range.split(" ").every((part) => {
    const match = COMPARATOR.exec(part);
    const bound = parseVersion(match?.[2]);
    if (!match || !bound) return false;
    const order = compareVersions(actual, bound);
    switch (match[1]) {
      case ">=":
        return order >= 0;
      case ">":
        return order > 0;
      case "<=":
        return order <= 0;
      case "<":
        return order < 0;
      default:
        return order === 0;
    }
  });
}
