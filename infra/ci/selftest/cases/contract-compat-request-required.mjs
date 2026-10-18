export default {
  gate: "在役契约兼容",
  mutation: "已打临时标签的请求新增必填字段",
  reason: /weapp-v1\.0\.0.*POST \/sample.*request\.body\.name：请求新增必填字段/u,
  run(ctx) {
    const path = "packages/contract/generated/merchant.openapi.json";
    const schema = { type: "object", properties: { name: { type: "string" } }, required: [] };
    const old = {
      openapi: "3.1.0",
      paths: {
        "/sample": {
          post: {
            operationId: "sample.write",
            requestBody: { content: { "application/json": { schema } } },
            responses: { 200: { content: { "application/json": { schema: { type: "string" } } } } },
          },
        },
      },
    };
    const dir = ctx.gitRepo({
      [path]: JSON.stringify(old),
      "packages/contract/released/retired.json": "[]\n",
    });
    ctx.git(dir, "commit", "-qm", "old request");
    ctx.git(dir, "tag", "weapp-v1.0.0");
    schema.required.push("name");
    ctx.writeFiles(dir, { [path]: JSON.stringify(old) });
    return ctx.node("infra/ci/contract-compat.mjs", ["--root", dir]);
  },
};
