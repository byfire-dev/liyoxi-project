import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { git, makeTempRepo, repoRoot, run, writeFiles } from "./helpers.js";

interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: unknown[];
  const?: unknown;
  $ref?: string;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  items?: Schema;
  additionalProperties?: Schema;
  nullable?: boolean;
  "x-open-enum"?: boolean;
}
interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema: Schema;
}
interface Body {
  required?: boolean;
  content: Record<string, { schema: Schema }>;
}
interface Operation {
  operationId: string;
  parameters?: Parameter[];
  requestBody?: Body;
  responses: Record<string, Body>;
}
interface PathItem {
  parameters?: Parameter[];
  post?: Operation;
  get?: Operation;
}
interface Document {
  openapi: string;
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, Schema> };
}
const SCRIPT = join(repoRoot, "infra/ci/contract-compat.mjs");
const CLIENTS = ["merchant", "admin", "portal"] as const;
const RETIRED = "packages/contract/released/retired.json";
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});
const objectSchema = (
  properties: Record<string, Schema>,
  required = Object.keys(properties),
): Schema => ({ type: "object", properties, required });
const body = (schema: Schema): Body => ({ content: { "application/json": { schema } } });
function document(): Document {
  return {
    openapi: "3.1.0",
    paths: {
      "/sample": {
        post: {
          operationId: "sample.write",
          requestBody: {
            ...body(objectSchema({ name: { type: "string" }, kind: { enum: ["a", "b"] } })),
            required: true,
          },
          responses: {
            "200": body(objectSchema({ id: { type: "string" }, state: { enum: ["new", "done"] } })),
          },
        },
      },
    },
    components: { schemas: {} },
  };
}
function operation(doc: Document): Operation {
  const value = doc.paths["/sample"]?.post;
  if (!value) throw new Error("fixture operation missing");
  return value;
}
function request(doc: Document): Schema {
  const value = operation(doc).requestBody?.content["application/json"]?.schema;
  if (!value) throw new Error("fixture request missing");
  return value;
}
function response(doc: Document): Schema {
  const value = operation(doc).responses["200"]?.content["application/json"]?.schema;
  if (!value) throw new Error("fixture response missing");
  return value;
}
function fields(schema: Schema): Record<string, Schema> {
  if (!schema.properties) throw new Error("fixture properties missing");
  return schema.properties;
}
function artifacts(doc: Document) {
  return Object.fromEntries(
    CLIENTS.map((client) => [
      `packages/contract/generated/${client}.openapi.json`,
      JSON.stringify(doc),
    ]),
  );
}
function fixture(
  previous = document(),
  current = structuredClone(previous),
  tag: string | null = "weapp-v1.0.0",
) {
  const temp = makeTempRepo("lyx-compat-", { ...artifacts(previous), [RETIRED]: "[]\n" });
  cleanups.push(temp.cleanup);
  git(temp.dir, "commit", "-qm", "old contract");
  if (tag) git(temp.dir, "tag", tag);
  writeFiles(temp.dir, artifacts(current));
  return {
    dir: temp.dir,
    check: () => run(process.execPath, [SCRIPT, "--root", temp.dir], repoRoot),
    retired: (value: unknown) => writeFileSync(join(temp.dir, RETIRED), JSON.stringify(value)),
  };
}
const changed = (mutate: (doc: Document) => void) => {
  const old = document();
  const current = structuredClone(old);
  mutate(current);
  return fixture(old, current);
};

const breaks: Array<[string, (doc: Document) => void, string]> = [
  [
    "删路径",
    (doc) => {
      delete doc.paths["/sample"];
    },
    "路径/方法被删除",
  ],
  [
    "删方法",
    (doc) => {
      delete doc.paths["/sample"]?.post;
    },
    "路径/方法被删除",
  ],
  [
    "改 operationId",
    (doc) => {
      operation(doc).operationId = "renamed.write";
    },
    "operationId 被改名",
  ],
  [
    "请求新增必填",
    (doc) => {
      fields(request(doc)).extra = { type: "string" };
      request(doc).required?.push("extra");
    },
    "request.body.extra：请求新增必填字段",
  ],
  [
    "响应删字段",
    (doc) => {
      delete fields(response(doc)).id;
    },
    "response.200.id：响应删字段",
  ],
  [
    "必有响应可空",
    (doc) => {
      fields(response(doc)).id = { type: ["string", "null"] };
    },
    "response.200.id：响应必有字段变为可空",
  ],
  [
    "请求枚举删值",
    (doc) => {
      fields(request(doc)).kind = { enum: ["a"] };
    },
    "request.body.kind：请求枚举删值",
  ],
  [
    "封闭响应枚举加值",
    (doc) => {
      fields(response(doc)).state = { enum: ["new", "done", "extra"] };
    },
    "response.200.state：响应封闭枚举加值",
  ],
];

describe("C77/C78 临时 Git 标签兼容检查", () => {
  it.each(breaks)("%s：真实脚本退出 1，定位版本、路由与字段", (_name, mutate, reason) => {
    const result = changed(mutate).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[merchant weapp-v1.0.0] POST /sample");
    expect(result.stderr).toContain(reason);
  });

  it.each(["新路由", "可选请求字段", "响应字段"])("%s 是加法，真实脚本通过", (kind) => {
    const result = changed((doc) => {
      if (kind === "新路由") doc.paths["/extra"] = { get: structuredClone(operation(doc)) };
      else
        fields(kind === "可选请求字段" ? request(doc) : response(doc)).extra = { type: "string" };
    }).check();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("merchant weapp-v1.0.0：兼容");
  });

  it("只读 OLD x-open-enum；在新契约补标记不能使破坏消失", () => {
    const old = document();
    fields(response(old)).state = { enum: ["new", "done"], "x-open-enum": true };
    const current = structuredClone(old);
    fields(response(current)).state = { enum: ["new", "done", "extra"] };
    expect(fixture(old, current).check().status).toBe(0);
    const closed = document();
    fields(response(current)).state = { enum: ["new", "done", "extra"], "x-open-enum": true };
    expect(fixture(closed, current).check().stderr).toContain("旧契约未标 x-open-enum");
  });

  it("组件上的 OLD 开放枚举经 $ref 保留；enum 移除也不能假装仍封闭", () => {
    const old = document();
    old.components.schemas.State = { type: "string", enum: ["new"], "x-open-enum": true };
    fields(response(old)).state = { $ref: "#/components/schemas/State" };
    const current = structuredClone(old);
    current.components.schemas.State = { type: "string" };
    expect(fixture(old, current).check().status).toBe(0);
    delete old.components.schemas.State["x-open-enum"];
    expect(fixture(old, current).check().status).toBe(1);
  });

  it("数组、嵌套属性、本地引用与引用兄弟键都参与比较", () => {
    const old = document();
    old.components.schemas["Item/~"] = objectSchema({ code: { enum: ["a", "b"] } });
    fields(request(old)).items = {
      type: "array",
      items: { $ref: "#/components/schemas/Item~1~0" },
    };
    const current = structuredClone(old);
    fields(request(current)).items = {
      type: "array",
      items: {
        $ref: "#/components/schemas/Item~1~0",
        required: ["extra"],
        properties: { extra: { type: "string" } },
      },
    };
    const result = fixture(old, current).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("request.body.items[].extra：请求新增必填字段");
  });

  it("allOf 是交集：object 与可空 object 相交仍不可空，真实放宽 null 才失败", () => {
    const old = document();
    old.components.schemas.Item = objectSchema({ name: { type: "string" } });
    fields(response(old)).id = { $ref: "#/components/schemas/Item" };
    const current = structuredClone(old);
    fields(response(current)).id = {
      allOf: [{ $ref: "#/components/schemas/Item" }, { type: ["object", "null"] }],
    };
    expect(fixture(old, current).check().status).toBe(0);
    fields(response(current)).id = {
      anyOf: [{ $ref: "#/components/schemas/Item" }, { type: "null" }],
    };
    expect(fixture(old, current).check().stderr).toContain("response.200.id：响应必有字段变为可空");
  });

  it("allOf 请求 required 取并集、enum 取交集，不漏掉新的必填或枚举删值", () => {
    const old = document();
    const current = structuredClone(old);
    operation(current).requestBody = {
      ...body({
        allOf: [
          request(old),
          objectSchema({ extra: { type: "string" } }),
          { properties: { kind: { enum: ["a"] } } },
        ],
      }),
      required: true,
    };
    const result = fixture(old, current).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("request.body.extra：请求新增必填字段");
    expect(result.stderr).toContain("request.body.kind：请求枚举删值");
  });

  it.each(["anyOf", "oneOf"] as const)(
    "%s 按判别字段对应分支，响应加字段通过、原分支删字段失败",
    (key) => {
      const old = document();
      const branches = [
        objectSchema({ kind: { const: "a" }, a: { type: "string" } }),
        objectSchema({ kind: { const: "b" }, b: { type: "string" } }),
      ];
      operation(old).responses["200"] = body({ [key]: branches });
      const current = structuredClone(old);
      const first = response(current)[key]?.[0];
      if (!first) throw new Error("fixture branch missing");
      fields(first).extra = { type: "string" };
      expect(fixture(old, current).check().status).toBe(0);
      delete fields(first).a;
      expect(fixture(old, current).check().stderr).toContain("response.200.a：响应删字段");
    },
  );

  it("oneOf 的两个 null 分支不接受 null，不把 union 盲平为 nullable", () => {
    const old = document();
    fields(response(old)).id = { type: "string" };
    const current = structuredClone(old);
    fields(response(current)).id = { oneOf: [{ type: ["string", "null"] }, { type: "null" }] };
    expect(fixture(old, current).check().status).toBe(0);
  });

  it.each(["anyOf", "oneOf"] as const)("%s 有限 request 判别枚举等价拆分通过", (key) => {
    const old = document();
    const current = structuredClone(old);
    operation(current).requestBody = {
      ...body({
        [key]: ["a", "b"].map((kind) =>
          objectSchema({ name: { type: "string" }, kind: { enum: [kind] } }),
        ),
      }),
      required: true,
    };
    expect(fixture(old, current).check().status).toBe(0);
  });

  it.each(["anyOf", "oneOf"] as const)("%s 跨候选仍拒绝真实 request 枚举删值", (key) => {
    const old = document();
    fields(request(old)).kind = { enum: ["a", "b", "c"] };
    const current = structuredClone(old);
    operation(current).requestBody = {
      ...body({
        [key]: ["a", "b"].map((kind) =>
          objectSchema({ name: { type: "string" }, kind: { enum: [kind] } }),
        ),
      }),
      required: true,
    };
    const result = fixture(old, current).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("request.body.kind：请求枚举删值");
  });

  it.each(["anyOf", "oneOf"] as const)("%s 判别字段分别值齐全也拒绝联合组合缺口", (key) => {
    const old = document();
    fields(request(old)).shade = { enum: ["x", "y"] };
    request(old).required?.push("shade");
    const current = structuredClone(old);
    operation(current).requestBody = {
      ...body({
        [key]: [
          objectSchema({ name: { type: "string" }, kind: { const: "a" }, shade: { const: "x" } }),
          objectSchema({ name: { type: "string" }, kind: { const: "b" }, shade: { const: "y" } }),
        ],
      }),
      required: true,
    };
    const result = fixture(old, current).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/request.body.(kind|shade)：请求枚举删值/u);
  });

  it.each(["anyOf", "oneOf"] as const)("%s 等价枚举覆盖不能掩盖某分支新增必填", (key) => {
    const old = document();
    const current = structuredClone(old);
    operation(current).requestBody = {
      ...body({
        [key]: [
          objectSchema({ name: { type: "string" }, kind: { const: "a" } }),
          objectSchema({
            name: { type: "string" },
            kind: { const: "b" },
            extra: { type: "string" },
          }),
        ],
      }),
      required: true,
    };
    const result = fixture(old, current).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("request.body.extra：请求新增必填字段");
  });

  it.each(["anyOf", "oneOf"] as const)("%s 有限 response 分支等价合并通过，新增值仍拒绝", (key) => {
    const old = document();
    operation(old).responses["200"] = body({
      [key]: ["new", "done"].map((state) =>
        objectSchema({ id: { type: "string" }, state: { enum: [state] } }),
      ),
    });
    const current = document();
    expect(fixture(old, current).check().status).toBe(0);
    fields(response(current)).state = { enum: ["new", "done", "extra"] };
    expect(fixture(old, current).check().stderr).toContain("响应封闭枚举加值");
  });

  it.each(["anyOf", "oneOf"] as const)("%s 递归 request 的有限等价拆分保留成对终止", (key) => {
    const old = document();
    old.components.schemas.Node = objectSchema(
      { kind: { enum: ["a", "b"] }, child: { $ref: "#/components/schemas/Node" } },
      ["kind"],
    );
    operation(old).requestBody = { ...body({ $ref: "#/components/schemas/Node" }), required: true };
    const current = structuredClone(old);
    current.components.schemas.Node = {
      [key]: ["a", "b"].map((kind) =>
        objectSchema({ kind: { const: kind }, child: { $ref: "#/components/schemas/Node" } }, [
          "kind",
        ]),
      ),
    };
    expect(fixture(old, current).check().status).toBe(0);
  });

  it.each(["anyOf", "oneOf"] as const)("%s 含 null 的 response 分支等价合并遵循选中投影", (key) => {
    const old = document();
    operation(old).responses["200"] = body({
      [key]: ["a", null].map((state) =>
        objectSchema({ id: { type: "string" }, state: { enum: [state] } }),
      ),
    });
    const current = structuredClone(old);
    operation(current).responses["200"] = body(
      objectSchema({ id: { type: "string" }, state: { enum: ["a", null] } }),
    );
    expect(fixture(old, current).check().status).toBe(0);
  });

  it.each(["anyOf", "oneOf"] as const)("%s response 联合覆盖仍拒绝真正新增 null", (key) => {
    const old = document();
    operation(old).responses["200"] = body({
      [key]: ["a", "b"].map((state) =>
        objectSchema({ id: { type: "string" }, state: { enum: [state] } }),
      ),
    });
    const current = structuredClone(old);
    operation(current).responses["200"] = body(
      objectSchema({ id: { type: "string" }, state: { enum: ["a", "b", null] } }),
    );
    const result = fixture(old, current).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("response.200.state：响应必有字段变为可空");
  });

  it("nullable enum union 的旧开放标记保留；oneOf/allOf 不能丢掉 null 分支", () => {
    const old = document();
    fields(response(old)).state = {
      anyOf: [{ type: "string", enum: ["new"], "x-open-enum": true }, { type: "null" }],
    };
    const current = structuredClone(old);
    fields(response(current)).state = {
      anyOf: [{ type: "string", enum: ["new", "done"] }, { type: "null" }],
    };
    expect(fixture(old, current).check().status).toBe(0);
    const enumBranch = fields(response(old)).state?.anyOf?.[0];
    if (!enumBranch) throw new Error("fixture enum branch missing");
    delete enumBranch["x-open-enum"];
    expect(fixture(old, current).check().stderr).toContain("响应封闭枚举加值");
  });

  it("不支持的结构关键字与不可满足的交集受控失败，输出具体路由", () => {
    const old = document();
    const setup = fixture(old);
    const unsupported = JSON.parse(JSON.stringify(old)) as Document;
    const json = JSON.stringify(unsupported).replace(
      '"type":"string"',
      '"type":"string","not":{"type":"null"}',
    );
    writeFiles(setup.dir, { "packages/contract/generated/merchant.openapi.json": json });
    const result = setup.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("POST /sample request.body");
    expect(result.stderr).toContain("无法可靠比较 schema.not");
    const current = structuredClone(old);
    operation(current).requestBody = {
      ...body({ allOf: [{ type: "object" }, { type: "null" }] }),
      required: true,
    };
    expect(fixture(old, current).check().stderr).toContain("空 schema 交集");
  });

  it("递归 schema 用成对引用终止，递归字段新增必填仍能发现", () => {
    const old = document();
    old.components.schemas.Node = objectSchema(
      { child: { $ref: "#/components/schemas/Node" }, label: { type: "string" } },
      ["label"],
    );
    operation(old).requestBody = { ...body({ $ref: "#/components/schemas/Node" }), required: true };
    const current = structuredClone(old);
    expect(fixture(old, current).check().status).toBe(0);
    current.components.schemas.Node?.required?.push("extra");
    const result = fixture(old, current).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("request.body.extra：请求新增必填字段");
  });

  it("参数按 in/name 匹配并遵循 operation 对 path 参数的覆盖；body 新必填拒绝", () => {
    const old = document();
    const item = old.paths["/sample"];
    if (!item) throw new Error("fixture path missing");
    item.parameters = [{ in: "query", name: "q", required: false, schema: { type: "string" } }];
    const current = structuredClone(old);
    operation(current).parameters = [
      { in: "query", name: "q", required: true, schema: { type: "string" } },
    ];
    expect(fixture(old, current).check().stderr).toContain("request.query:q：请求新增必填字段");
    operation(old).requestBody = { ...body(request(old)), required: false };
    expect(fixture(old, current).check().stderr).toContain("request.body：请求新增必填字段");
    delete operation(old).requestBody;
    expect(fixture(old, current).check().stderr).toContain("request.body：请求新增必填字段");
  });

  it("可选请求字段变必填和响应必有字段变可选都失败；没有其它严格差异算法", () => {
    const old = document();
    request(old).required = ["name"];
    const current = structuredClone(old);
    request(current).required = ["name", "kind"];
    response(current).required = ["state"];
    const result = fixture(old, current).check();
    expect(result.stderr).toContain("request.body.kind：请求新增必填字段");
    expect(result.stderr).toContain("response.200.id：响应字段不再必有");
    const unrelated = structuredClone(old);
    fields(request(unrelated)).name = { type: "number" };
    expect(fixture(old, unrelated).check().status).toBe(0);
  });

  it("在役版本全比较；retired 仅摘除精确版本，理由日期必填", () => {
    const old = document();
    const current = structuredClone(old);
    delete fields(response(current)).id;
    const setup = fixture(old, current);
    git(setup.dir, "tag", "weapp-v2.0.0");
    setup.retired([{ version: "weapp-v1.0.0", reason: "客户端已淘汰", date: "2026-10-10" }]);
    const result = setup.check();
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("[merchant weapp-v1.0.0]");
    expect(result.stderr).toContain("[merchant weapp-v2.0.0]");
    setup.retired(
      ["weapp-v1.0.0", "weapp-v2.0.0"].map((version) => ({
        version,
        reason: "已淘汰",
        date: "2026-10-10",
      })),
    );
    expect(setup.check().status).toBe(0);
  });

  it("5 个在役标签只提醒、全部比较；后台与下载页只比较最近服务端标签", () => {
    const setup = fixture();
    for (const version of [2, 3, 4, 5]) git(setup.dir, "tag", `weapp-v${version}.0.0`);
    const result = setup.check();
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("5 个在役 weapp 版本");
    expect(result.stdout).toContain("比较 5 份快照");
    git(setup.dir, "tag", "v1.0.0");
    git(setup.dir, "tag", "v2.0.0");
    const server = setup.check();
    expect(server.status).toBe(0);
    expect(server.stdout).toContain("admin v2.0.0：兼容");
    expect(server.stdout).toContain("portal v2.0.0：兼容");
    expect(server.output).not.toContain("admin v1.0.0");
  });

  it("各类没有标签分别明确无可比版本，不读取不存在的快照", () => {
    const setup = fixture(document(), document(), null);
    for (const client of CLIENTS)
      rmSync(join(setup.dir, `packages/contract/generated/${client}.openapi.json`));
    const result = setup.check();
    expect(result.status).toBe(0);
    for (const client of CLIENTS) expect(result.stdout).toContain(`${client}：无可比版本`);
  });

  it("标签存在但缺生成物必须失败，不当成没有可比版本", () => {
    const setup = fixture(document(), document(), null);
    rmSync(join(setup.dir, "packages/contract/generated/merchant.openapi.json"));
    git(setup.dir, "add", "-A");
    git(setup.dir, "commit", "-qm", "missing merchant artifact");
    git(setup.dir, "tag", "weapp-v1.0.0");
    writeFiles(setup.dir, artifacts(document()));
    const result = setup.check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[merchant weapp-v1.0.0]");
    expect(result.stderr).toContain("缺失标签生成物");
  });

  it.each([
    [{ version: "weapp-v1", reason: "", date: "2026-10-10" }],
    [{ version: "weapp-v1", reason: "x", date: "2026-02-30" }],
    [{ version: "weapp-v1", reason: "x", date: "2026-10-10", extra: true }],
    [0],
  ])("retired 非法条目受控失败：%j", (row) => {
    const setup = fixture();
    setup.retired([row]);
    expect(setup.check().status).toBe(1);
    expect(setup.check().stderr).toContain("retired.json 条目无效");
  });

  it("重复退役与非数组退役记录失败", () => {
    const setup = fixture();
    const row = { version: "weapp-v1", reason: "x", date: "2026-10-10" };
    setup.retired([row, row]);
    expect(setup.check().status).toBe(1);
    setup.retired({ versions: [] });
    expect(setup.check().stderr).toContain("retired.json 必须是数组");
  });

  it.each(["external", "missing", "cycle"])("无法可靠解析的 %s 引用受控失败", (kind) => {
    const old = document();
    fields(response(old)).id = {
      $ref: kind === "external" ? "https://example.invalid/schema" : "#/components/schemas/Gone",
    };
    if (kind === "cycle") old.components.schemas.Gone = { $ref: "#/components/schemas/Gone" };
    const result = fixture(old).check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[merchant weapp-v1.0.0]");
    expect(result.stderr).toMatch(/只支持本地|找不到引用|纯引用环/u);
  });

  it("当前 JSON 非法、退役文件缺失与未知参数均不假绿", () => {
    const setup = fixture();
    writeFileSync(join(setup.dir, "packages/contract/generated/merchant.openapi.json"), "{");
    expect(setup.check().stderr).toContain("JSON 无效");
    rmSync(join(setup.dir, RETIRED));
    expect(setup.check().status).toBe(1);
    expect(run(process.execPath, [SCRIPT, "--unknown"], repoRoot).status).toBe(2);
  });

  it("本仓库三份实际生成物以临时标签作旧快照：必须完整解析、保持兼容", () => {
    const setup = fixture(document(), document(), null);
    const files = Object.fromEntries(
      CLIENTS.map((client) => {
        const path = `packages/contract/generated/${client}.openapi.json`;
        return [path, readFileSync(join(repoRoot, path), "utf8")];
      }),
    );
    writeFiles(setup.dir, files);
    git(setup.dir, "add", "-A");
    git(setup.dir, "commit", "-qm", "actual generated snapshots");
    git(setup.dir, "tag", "weapp-v1.0.0");
    git(setup.dir, "tag", "v1.0.0");
    const result = setup.check();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("比较 3 份快照，0 处失败");
  });

  it("两条门禁自测通过真实临时标签产生精确的两类拒绝", () => {
    const result = run(
      process.execPath,
      [join(repoRoot, "infra/ci/selftest/run.mjs"), "--only", "contract-compat-"],
      repoRoot,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("门禁自测通过：2 个反例");
    expect(result.stdout).toContain("响应删字段");
    expect(result.stdout).toContain("请求新增必填字段");
  });

  it("只有只增 CI step/root command 与新 frozen 退役登记，旧 checkout 已包含标签", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const verify = workflow.slice(workflow.indexOf("  verify:"), workflow.indexOf("  test:"));
    expect(verify).toContain("fetch-depth: 0");
    expect(verify.indexOf("run: pnpm contract:compat")).toBeGreaterThan(
      verify.indexOf("run: pnpm contract:check"),
    );
    expect(verify.match(/run: pnpm contract:compat/gu)).toHaveLength(1);
    const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["contract:compat"]).toBe("node infra/ci/contract-compat.mjs");
    const gates = JSON.parse(readFileSync(join(repoRoot, "infra/ci/gate-files.json"), "utf8")) as {
      files: Array<{ pattern: string; kind: string }>;
    };
    expect(gates.files.filter((row) => row.pattern === RETIRED)).toEqual([
      expect.objectContaining({ kind: "frozen" }),
    ]);
    expect(JSON.parse(readFileSync(join(repoRoot, RETIRED), "utf8"))).toEqual([]);
  });
});
