import { describe, expect, it } from "vitest";
import { fetchReleaseChecks } from "../release-check-fetch.mjs";

const source = "a".repeat(40);
const repository = "owner/project";
const env = { EXPECTED_SHA: source, GITHUB_REPOSITORY: repository, GH_TOKEN: "fixture-token" };
const response = (name: string, status = "completed", conclusion = "success") => ({
  total_count: 1,
  workflow_runs: [
    {
      id: name === "images" ? 1 : 2,
      workflow_id: name === "images" ? 11 : 12,
      run_number: 1,
      run_attempt: 1,
      name,
      path: `.github/workflows/${name}.yml`,
      repository: { full_name: repository },
      head_repository: { full_name: repository },
      event: "push",
      head_branch: "main",
      head_sha: source,
      status,
      conclusion,
    },
  ],
});

describe("发布检查有界读取", () => {
  it("恰好串行两个SHA过滤GET，成功仅返回选择后的安全事实", async () => {
    const calls: string[] = [];
    const request: typeof fetch = async (input, init) => {
      expect(init).toMatchObject({ method: "GET", redirect: "error" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-token");
      const url = String(input);
      calls.push(url);
      const name = calls.length === 1 ? "images" : "mixed-smoke";
      expect(url).toBe(
        `https://api.github.com/repos/${repository}/actions/workflows/${name}.yml/runs?branch=main&event=push&head_sha=${source}&per_page=100`,
      );
      return Response.json(response(name));
    };
    const result = await fetchReleaseChecks(env, request);
    expect(calls).toHaveLength(2);
    expect(result).toEqual({
      source,
      repository,
      compatibility: "passed",
      imagesRunId: 1,
      imagesAttempt: 1,
      mixedRunId: 2,
      mixedAttempt: 1,
    });
    expect(JSON.stringify(result)).not.toContain(env.GH_TOKEN);
  });

  it("403、429、Retry-After、网络失败立即停止，无重试或后续请求", async () => {
    for (const failure of [403, 429, "retry-after", "network"]) {
      for (const failedAt of [1, 2]) {
        let count = 0;
        const request: typeof fetch = async () => {
          count += 1;
          if (count !== failedAt) return Response.json(response("images"));
          if (failure === "network") throw new Error("private transport diagnostic");
          return new Response("private response", {
            status: typeof failure === "number" ? failure : 200,
            headers: failure === "retry-after" ? { "retry-after": "60" } : {},
          });
        };
        await expect(fetchReleaseChecks(env, request)).rejects.toThrow();
        expect(count).toBe(failedAt);
      }
    }
  });

  it("身份/凭据先验不发请求，超限与缺失/未完成/失败检查关闭发布", async () => {
    let calls = 0;
    const unused: typeof fetch = async () => {
      calls += 1;
      throw new Error("must not call");
    };
    for (const invalid of [{ EXPECTED_SHA: "bad" }, { GH_TOKEN: "" }, { GH_TOKEN: "a\nb" }])
      await expect(fetchReleaseChecks({ ...env, ...invalid }, unused)).rejects.toThrow();
    expect(calls).toBe(0);
    const tooLarge: typeof fetch = async () => new Response("x".repeat(8 * 1024 * 1024 + 1));
    await expect(fetchReleaseChecks(env, tooLarge)).rejects.toThrow("超限");
    for (const mixed of [
      { total_count: 0, workflow_runs: [] },
      response("mixed-smoke", "in_progress", ""),
      response("mixed-smoke", "completed", "failure"),
    ]) {
      let count = 0;
      await expect(
        fetchReleaseChecks(env, async () =>
          Response.json(++count === 1 ? response("images") : mixed),
        ),
      ).rejects.toThrow("mixed-smoke");
      expect(count).toBe(2);
    }
  });
});
