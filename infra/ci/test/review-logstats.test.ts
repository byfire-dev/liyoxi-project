import { Readable } from "node:stream";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { repoRoot } from "./helpers.js";
interface LogStats {
  readLogs(
    input: AsyncIterable<string>,
    mode: string,
    value: string,
    now: number,
    options?: { byEnvVersion?: boolean; clientVersion?: string },
  ): Promise<string>;
}
const { readLogs } = (await import(
  pathToFileURL(join(repoRoot, "infra/deploy/log-stats.mjs")).href
)) as LogStats;
const now = Date.parse("2026-10-18T00:00:00Z");
const client = "sha-0123456789ab";
const line = (fields: object) =>
  JSON.stringify({
    time: "2026-10-17T23:59:30Z",
    path: "/api/v1/m/bootstrap",
    status: 200,
    request_time: 0.2,
    client_version: client,
    ...fields,
  });
it("按同源sha客户端与受限环境类型分组，旧/无版本归unknown且不回显任意头", async () => {
  const input = Readable.from([
    [
      { env_version: "release" },
      { env_version: "trial" },
      { env_version: "forged-private-value" },
      {},
      { client_version: "sha-ffffffffffff", env_version: "develop" },
      { path: "/health", env_version: "release" },
    ]
      .map(line)
      .join("\n"),
  ]);
  const output = await readLogs(input, "stats", "1", now, {
    byEnvVersion: true,
    clientVersion: client,
  });
  const result = JSON.parse(output);
  expect(result).toMatchObject({
    samples: 4,
    envVersions: { develop: 0, trial: 1, release: 1, unknown: 2 },
    clientVersion: client,
    otherClientVersions: 1,
    excluded: 1,
    inputRows: 6,
  });
  expect(output).not.toContain("forged-private-value");
});
it("原统计输出无分组字段，非法过滤和logs分组拒绝", async () => {
  const result = JSON.parse(await readLogs(Readable.from([line({})]), "stats", "1", now));
  expect(result.samples).toBe(1);
  expect(result.envVersions).toBeUndefined();
  for (const [mode, value, options] of [
    ["stats", "1", { byEnvVersion: true, clientVersion: "weapp-v1.2.3" }],
    ["logs", "019a03ba-1111-7222-8333-444444444444", { byEnvVersion: true }],
  ] as const)
    await expect(readLogs(Readable.from([]), mode, value, now, options)).rejects.toThrow();
});
