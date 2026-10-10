export default {
  gate: "在役契约兼容",
  mutation: "已打临时标签的响应删字段",
  reason: /weapp-v1\.0\.0.*POST \/sample.*response\.200\.id：响应删字段/u,
  run(ctx) {
    const path = "packages/contract/generated/merchant.openapi.json";
    const old = {
      openapi: "3.1.0",
      paths: {
        "/sample": {
          post: {
            operationId: "sample.write",
            responses: {
              200: {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { id: { type: "string" } },
                      required: ["id"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const dir = ctx.gitRepo({
      [path]: JSON.stringify(old),
      "packages/contract/released/retired.json": "[]\n",
    });
    ctx.git(dir, "commit", "-qm", "old response");
    ctx.git(dir, "tag", "weapp-v1.0.0");
    old.paths["/sample"].post.responses["200"].content["application/json"].schema.properties = {};
    ctx.writeFiles(dir, { [path]: JSON.stringify(old) });
    return ctx.node("infra/ci/contract-compat.mjs", ["--root", dir]);
  },
};
