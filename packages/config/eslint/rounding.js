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
            if (variable) return variable.defs.find((def) => def.type === "Variable")?.node;
            scope = scope.upper;
          }
          return undefined;
        };
        const constant = (node, depth = 0) => {
          if (!node || depth > 8) return undefined;
          if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression")
            return constant(node.expression, depth + 1);
          if (node.type !== "Identifier") return keyOf(node);
          const definition = binding(node);
          return definition?.id.type === "Identifier"
            ? constant(definition.init, depth + 1)
            : undefined;
        };
        const propertyOf = (node) =>
          node.computed ? constant(node.property ?? node.key) : keyOf(node.property ?? node.key);
        // 解构别名属于具体属性：{ Math: math } 的来源是 globalThis.Math，
        // { floor: fn } 的来源是 Math.floor，不能把这两个变量都当成整个 initializer。
        const patternKeys = (pattern, name) => {
          if (pattern.type !== "ObjectPattern") return undefined;
          for (const property of pattern.properties) {
            if (property.type !== "Property") continue;
            const key = propertyOf(property);
            if (typeof key !== "string") continue;
            const value =
              property.value.type === "AssignmentPattern" ? property.value.left : property.value;
            if (value.type === "Identifier" && value.name === name) return [key];
            const nested = patternKeys(value, name);
            if (nested) return [key, ...nested];
          }
          return undefined;
        };
        const pathOf = (node, depth = 0) => {
          if (!node || depth > 8) return undefined;
          if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression")
            return pathOf(node.expression, depth + 1);
          if (node.type === "MemberExpression") {
            const owner = pathOf(node.object, depth + 1);
            const property = propertyOf(node);
            return owner && typeof property === "string" ? [...owner, property] : undefined;
          }
          if (node.type !== "Identifier") return undefined;
          const definition = binding(node);
          if (!definition) return [node.name];
          const owner = pathOf(definition.init, depth + 1);
          if (definition.id.type === "Identifier") return owner;
          const keys = patternKeys(definition.id, node.name);
          return owner && keys ? [...owner, ...keys] : undefined;
        };
        const isMathPath = (path) =>
          ["Math", "globalThis.Math", "global.Math", "window.Math"].includes(path?.join("."));
        const patternPath = (pattern) => {
          const parent = pattern.parent;
          if (parent.type === "VariableDeclarator") return pathOf(parent.init);
          if (parent.type === "AssignmentExpression") return pathOf(parent.right);
          if (parent.type !== "Property" || parent.parent.type !== "ObjectPattern")
            return undefined;
          const owner = patternPath(parent.parent);
          const key = propertyOf(parent);
          return owner && typeof key === "string" ? [...owner, key] : undefined;
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
              (property === "round" && isMathPath(pathOf(node.object)))
            )
              report(node);
          },
          ObjectPattern(node) {
            for (const property of node.properties) {
              const name = propertyOf(property);
              if (
                name === "toFixed" ||
                name === "parseFloat" ||
                (name === "round" && isMathPath(patternPath(node)))
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
