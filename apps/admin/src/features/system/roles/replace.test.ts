import { expect, it, vi } from "vitest";
import { RoleReplaceBodySchema } from "@liyoxi/contract";
import { defaultRoleActions, staffRoleDefault } from "@liyoxi/contract/authz";
import { createAdminApi } from "../../../lib/api";
import { replaceRole } from "./replace";

const defaults = staffRoleDefault("cs")!;
const body = RoleReplaceBodySchema.parse({
  moduleLevels: defaults.moduleLevels,
  actions: defaultRoleActions("cs"),
  dataScope: defaults.dataScope,
  lockVersion: 0,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(invalidate: () => void) {
  const entered = deferred(),
    release = deferred(),
    requests: Request[] = [];
  const invalidated = vi.fn(invalidate);
  const noop = () => {};
  const api = createAdminApi({
    build: "test",
    baseUrl: "https://admin.example.test",
    handlers: {
      redirectToLogin: noop,
      stepUp: async () => false,
      refreshAccess: noop,
      invalidateQueries: invalidated,
      notify: noop,
      showBlocked: noop,
      buildMismatch: noop,
    },
    fetch: async (request) => {
      requests.push(request.clone());
      entered.resolve();
      await release.promise;
      return new Response(
        JSON.stringify({
          error: "VERSION_CONFLICT",
          message: "内容已被他人修改，请刷新后重试",
          details: { lockVersion: 1 },
        }),
        { status: 409, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  return { services: { api }, entered, release, requests, invalidated };
}

it("真实409先触发中央失效并卸载旧编辑器，稳定父层仍处理冲突且不重发", async () => {
  let editorAlive = true;
  const h = setup(() => {
    // Force the query observer's new-version cleanup before the caller sees the error.
    editorAlive = false;
  });
  const conflict = vi.fn(async () => {
    expect(editorAlive).toBe(false);
  });
  const saved = vi.fn(async () => {});
  const pending = replaceRole(h.services, "cs", body, "role-cas-intent", {
    current: () => true,
    conflict,
    saved,
  });
  await h.entered.promise;
  h.release.resolve();
  await expect(pending).resolves.toBeUndefined();
  expect(h.invalidated).toHaveBeenCalledTimes(1);
  expect(conflict).toHaveBeenCalledTimes(1);
  expect(saved).not.toHaveBeenCalled();
  expect(h.requests).toHaveLength(1);
  const request = h.requests[0]!;
  expect(request.method).toBe("PUT");
  expect(new URL(request.url).pathname).toBe("/api/v1/admin/roles/cs");
  expect(request.headers.get("Idempotency-Key")).toBe("role-cas-intent");
  expect(await request.json()).toEqual(body);
});

it("身份、角色或后继请求已变化时，旧409保留中央失效但不向当前父层串提示", async () => {
  const started = { actor: "staff-a", role: "cs", request: 1 };
  for (const next of [
    { ...started, actor: "staff-b" },
    { ...started, role: "finance" },
    { ...started, request: 2 },
  ]) {
    let current = started;
    const h = setup(() => {}),
      conflict = vi.fn(async () => {}),
      saved = vi.fn(async () => {});
    const pending = replaceRole(h.services, "cs", body, "old-role-intent", {
      current: () => current === started,
      conflict,
      saved,
    });
    await h.entered.promise;
    current = next;
    h.release.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(h.invalidated).toHaveBeenCalledTimes(1);
    expect(conflict).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(h.requests).toHaveLength(1);
  }
});
