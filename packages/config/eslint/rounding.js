// W1-10：业务取整只走 shared/pricing。四条既有耗时日志精确到表达式，不豁免文件或目录。
const timingExpressions = {
  "apps/api/src/http/access-log.ts": "Math.round(performance.now() - startedAt)",
  "apps/worker/src/lease.ts": "Math.round(late)",
  "apps/worker/src/cli/redis-compat.ts":
    "(samples[Math.floor(samples.length * q)] ?? 0).toFixed(1)",
  "packages/services/src/testing/m0-chain.ts": "(waitMs / 1000).toFixed(1)",
};
const keyOf = (node) =>
  node?.type === "Identifier"
    ? node.name
    : node?.type === "Literal"
      ? node.value
      : node?.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0]?.value.cooked
        : undefined;
export const roundingFiles = [
  [
    "{packages/services,apps/api,apps/worker}/src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
    "!**/*.test.{ts,tsx,js,jsx,mjs,cjs}",
    "!**/__fixtures__/**",
  ],
];
export const roundingPlugin = {
  rules: {
    "one-rounding-function": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          forbidden:
            "业务取整只用 @liyoxi/shared/pricing，不能直接用 Math.round、toFixed、parseFloat。",
        },
      },
      create(context) {
        const source = context.sourceCode;
        const binding = (node) => {
          let scope = source.getScope(node);
          while (scope) {
            const variable = scope.set.get(node.name);
            if (variable) return variable.defs.find((def) => def.type === "Variable")?.node.init;
            scope = scope.upper;
          }
          return undefined;
        };
        const constant = (node, depth = 0) => {
          if (!node || depth > 8) return undefined;
          if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression")
            return constant(node.expression, depth + 1);
          return node.type === "Identifier" ? constant(binding(node), depth + 1) : keyOf(node);
        };
        const propertyOf = (node) =>
          node.computed ? constant(node.property ?? node.key) : keyOf(node.property ?? node.key);
        const isMath = (node, depth = 0) => {
          if (!node || depth > 8) return false;
          if (node.type === "MemberExpression") return propertyOf(node) === "Math";
          return (
            node.type === "Identifier" && (node.name === "Math" || isMath(binding(node), depth + 1))
          );
        };
        const filename = context.filename.replaceAll("\\", "/");
        const except = Object.entries(timingExpressions).find(([path]) =>
          filename.endsWith(`/${path}`),
        )?.[1];
        const report = (node) => {
          if (
            except &&
            node.parent.type === "CallExpression" &&
            node.parent.callee === node &&
            source.getText(node.parent) === except
          )
            return;
          context.report({ node, messageId: "forbidden" });
        };
        return {
          MemberExpression(node) {
            const property = propertyOf(node);
            if (
              property === "toFixed" ||
              property === "parseFloat" ||
              (property === "round" && isMath(node.object))
            )
              report(node);
          },
          ObjectPattern(node) {
            const parent = node.parent;
            const object = parent.type === "VariableDeclarator" ? parent.init : parent.right;
            for (const property of node.properties) {
              const name = propertyOf(property);
              if (
                name === "toFixed" ||
                name === "parseFloat" ||
                (name === "round" &&
                  (isMath(object) || (parent.type === "Property" && propertyOf(parent) === "Math")))
              )
                report(property);
            }
          },
          Identifier(node) {
            if (node.name !== "parseFloat") return;
            if (
              (node.parent.type === "MemberExpression" && node.parent.property === node) ||
              (node.parent.type === "Property" &&
                node.parent.key === node &&
                !node.parent.shorthand)
            )
              return;
            let current = source.getScope(node);
            while (current) {
              const variable = current.set.get("parseFloat");
              if (variable) {
                if (variable.defs.length === 0) report(node);
                return;
              }
              current = current.upper;
            }
            report(node);
          },
        };
      },
    },
  },
};
