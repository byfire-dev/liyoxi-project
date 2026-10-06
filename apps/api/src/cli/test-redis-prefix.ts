/** 浏览器真实接口验收共享本地 Redis 时使用专属键空间；运行环境必须为 test。 */
export function testRedisKeyPrefix(appEnv: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (appEnv !== "test" || !/^lyx:test:[a-z0-9_-]{1,48}:$/.test(value)) {
    throw new Error(
      "--test-redis-prefix 仅在 test 环境使用，须为 lyx:test:<1–48 位小写字母、数字、下划线、连字符>: 格式",
    );
  }
  return value;
}
