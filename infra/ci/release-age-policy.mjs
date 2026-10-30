// ADR-035 安全修复的单次例外；不接受外部配置扩大包、版本或截止时间。
export const MINIMUM_RELEASE_AGE_MINUTES = 10080;
export const FORGE_SECURITY_RELEASE = Object.freeze({
  key: "node-forge@1.4.2",
  publishedAt: "2026-10-27T14:09:15.471Z",
  expiresAt: "2026-11-03T14:09:15.471Z",
});

/** 只认原有设置和本次精确 selector，不开放通用豁免表。 */
export function checkWorkspaceReleaseAge(workspace) {
  const violations = [];
  const lines = workspace.split("\n");
  const minimum = lines.filter((line) => /^["']?minimumReleaseAge["']?\s*:/.test(line));
  if (minimum.length !== 1 || !/^minimumReleaseAge:\s*10080\s*(?:#.*)?$/.test(minimum[0])) {
    violations.push("pnpm-workspace.yaml 里没有 minimumReleaseAge: 10080（须唯一且使用原值）");
  }
  const headers = lines.flatMap((line, index) =>
    /^["']?minimumReleaseAgeExclude["']?\s*:/.test(line) ? [index] : [],
  );
  if (headers.length === 0) return { violations, exceptionConfigured: false };
  const index = headers[0];
  const items = [];
  for (let next = index + 1; next < lines.length; next += 1) {
    const line = lines[next];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    items.push(line);
  }
  const exact =
    /^ {2}-\s+(?:node-forge@1\.4\.2|"node-forge@1\.4\.2"|'node-forge@1\.4\.2')\s*(?:#.*)?$/;
  const exceptionConfigured =
    headers.length === 1 &&
    /^minimumReleaseAgeExclude:\s*(?:#.*)?$/.test(lines[index]) &&
    items.length === 1 &&
    exact.test(items[0]);
  if (!exceptionConfigured) {
    violations.push(
      "pnpm-workspace.yaml 里有 minimumReleaseAgeExclude：只允许本次精确 node-forge@1.4.2 安全修复例外",
    );
  }
  return { violations, exceptionConfigured };
}

/** 时钟由调用方传入，命令行仍只用 Date.now()，不提供绕过门禁的时钟参数。 */
export function checkVersionReleaseAge({ key, published, nowMs, exceptionConfigured }) {
  const publishedMs = typeof published === "string" ? Date.parse(published) : NaN;
  if (
    !Number.isFinite(publishedMs) ||
    new Date(publishedMs).toISOString() !== published ||
    !Number.isFinite(nowMs)
  ) {
    return { error: `${key}：registry 发布时间或核对时间无效`, ageMs: NaN, exempt: false };
  }
  const ageMs = nowMs - publishedMs;
  if (key === FORGE_SECURITY_RELEASE.key && published !== FORGE_SECURITY_RELEASE.publishedAt) {
    return { error: `${key}：registry 发布时间与本次已核记录不一致`, ageMs, exempt: false };
  }
  if (ageMs >= MINIMUM_RELEASE_AGE_MINUTES * 60_000) {
    return { error: null, ageMs, exempt: false };
  }
  if (
    exceptionConfigured &&
    key === FORGE_SECURITY_RELEASE.key &&
    ageMs >= 0 &&
    nowMs < Date.parse(FORGE_SECURITY_RELEASE.expiresAt)
  ) {
    return { error: null, ageMs, exempt: true };
  }
  return {
    error: `${key}：发布于 ${published}，才 ${(ageMs / 86_400_000).toFixed(1)} 天，未满 7 天`,
    ageMs,
    exempt: false,
  };
}
