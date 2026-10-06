// W1-11b 发现固定 summary 被动态 UUID 路径抢先校验；正常鉴权和生产挂载器目标回归。
import { adminRoute, IdSchema, okResponse, z } from "@liyoxi/contract";
import { uuidv7 } from "@liyoxi/services";
import { signInAsStaff } from "@liyoxi/services/testing";
import { describe, expect, it } from "vitest";
import { ok } from "../src/http/errors.js";
import { defineAdminHandler } from "../src/routing/admin.js";
import { useTestApi } from "../src/testing/index.js";
const h = useTestApi();
const output = z.object({ handler: z.string() });
const dynamic = defineAdminHandler(
  adminRoute({
    operationId: "admin.lyxtestSpecificity.get",
    method: "get",
    path: "/admin/lyxtest-specificity/{id}",
    request: { params: z.object({ id: IdSchema }) },
    responses: okResponse(output),
    "x-permission": null,
  }),
  null,
  (c) => ok(c, { handler: "dynamic" }),
);
const fixed = defineAdminHandler(
  adminRoute({
    operationId: "admin.lyxtestSpecificity.summary",
    method: "get",
    path: "/admin/lyxtest-specificity/summary",
    responses: okResponse(output),
    "x-permission": null,
  }),
  { module: "order", need: "view" },
  (c) => ok(c, { handler: "fixed" }),
);
const nestedDynamic = defineAdminHandler(
  adminRoute({
    operationId: "admin.lyxtestSpecificity.child",
    method: "get",
    path: "/admin/lyxtest-specificity/{parent}/{child}",
    request: { params: z.object({ parent: IdSchema, child: IdSchema }) },
    responses: okResponse(output),
    "x-permission": null,
  }),
  null,
  (c) => ok(c, { handler: "nested_dynamic" }),
);
const nestedFixed = defineAdminHandler(
  adminRoute({
    operationId: "admin.lyxtestSpecificity.nested",
    method: "get",
    path: "/admin/lyxtest-specificity/{differentName}/summary",
    request: { params: z.object({ differentName: IdSchema }) },
    responses: okResponse(output),
    "x-permission": null,
  }),
  { module: "order", need: "view" },
  (c) => ok(c, { handler: "nested_fixed" }),
);
describe("固定段优先的真实挂载", () => {
  it("动态先注册/逆序都匹配正确处理器，固定路由保留其权限与校验", async () => {
    const input = [dynamic, nestedDynamic, fixed, nestedFixed];
    let prior: string[] | undefined;
    for (const handlers of [input, [...input].reverse()]) {
      const api = await h.start({ handlers });
      const db = await h.db.prisma();
      const finance = await signInAsStaff(db, { roleKey: "finance" });
      const editor = await signInAsStaff(db, { roleKey: "editor" });
      const mounted = api.api.mounted.map((r) => r.operationId);
      if (prior) expect(mounted).toEqual(prior);
      prior = mounted;
      for (const [path, handler] of [
        ["summary", "fixed"],
        [`${uuidv7()}/summary`, "nested_fixed"],
        [uuidv7(), "dynamic"],
        [`${uuidv7()}/${uuidv7()}`, "nested_dynamic"],
      ]) {
        const response = await api.request(`/api/v1/admin/lyxtest-specificity/${path}`, {
          headers: finance.headers,
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ data: { handler } });
        const restricted = await api.request(`/api/v1/admin/lyxtest-specificity/${path}`, {
          headers: editor.headers,
        });
        expect(restricted.status).toBe(handler!.includes("fixed") ? 403 : 200);
        if (restricted.status === 403)
          expect(await restricted.json()).toMatchObject({ error: "PERMISSION_DENIED" });
      }
      expect(
        (
          await api.request("/api/v1/admin/lyxtest-specificity/not-a-uuid", {
            headers: finance.headers,
          })
        ).status,
      ).toBe(400);
    }
  }, 60_000);
});
