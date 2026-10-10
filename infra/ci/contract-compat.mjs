#!/usr/bin/env node
// C77/C78：只比较六类破坏；旧契约来自本地标签，绝不 fetch 或改标签。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const TYPES = ["null", "boolean", "object", "array", "number", "integer", "string"];
const started = performance.now();
const argv = process.argv.slice(2);
if (argv.length !== 0 && (argv.length !== 2 || argv[0] !== "--root")) {
  console.error("用法：node infra/ci/contract-compat.mjs [--root <仓库>]");
  process.exit(2);
}
const root = resolve(argv[1] ?? fileURLToPath(new URL("../../", import.meta.url)));
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const encoded = (value) => JSON.stringify(value);
const intersect = (a, b) =>
  a
    .filter((value) => b.includes(value) || (value === "integer" && b.includes("number")))
    .concat(
      b.includes("integer") && a.includes("number") && !a.includes("integer") ? ["integer"] : [],
    );

function budget() {
  if (performance.now() - started > 20_000) throw new Error("契约兼容检查超过 20 秒预算");
}

function git(...args) {
  const remaining = 20_000 - (performance.now() - started);
  if (remaining <= 0) throw new Error("契约兼容检查超过 20 秒预算");
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: Math.ceil(remaining),
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(`git ${args[0]} 失败（缺失标签生成物也必须失败）`);
  return result.stdout;
}

function parse(text, location) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${location}：JSON 无效`);
  }
}

function pointer(doc, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/"))
    throw new Error(`只支持本地 JSON pointer：${String(ref)}`);
  let value = doc;
  for (const raw of ref.slice(2).split("/")) {
    if (/~(?![01])/u.test(raw)) throw new Error(`无效 JSON pointer：${ref}`);
    const key = raw.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (value === null || typeof value !== "object" || !owns(value, key))
      throw new Error(`找不到引用 ${ref}`);
    value = value[key];
  }
  return value;
}

// Reference Object（参数、响应、路径）也支持本地引用，兄弟键保留；纯引用环拒绝。
function entry(value, doc, seen = new Set()) {
  if (!object(value)) throw new Error("OpenAPI 对象写法无效");
  if (!owns(value, "$ref")) return value;
  if (seen.has(value.$ref)) throw new Error(`纯引用环 ${value.$ref}`);
  const next = new Set([...seen, value.$ref]);
  const { $ref, ...siblings } = value;
  return { ...entry(pointer(doc, $ref), doc, next), ...siblings };
}

// 对 null/枚举值求真实组合语义；oneOf 重叠的 null 不属于其可接受值。
function accepts(value, schema, doc, seen = new Set()) {
  if (typeof schema === "boolean") return schema;
  if (!object(schema)) throw new Error("schema 写法无效");
  if (seen.has(schema)) throw new Error("schema 值判断遇到纯引用环");
  const next = new Set([...seen, schema]);
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  if (
    schema.type !== undefined &&
    ![]
      .concat(schema.type)
      .some((allowed) => allowed === type || (allowed === "integer" && Number.isInteger(value))) &&
    !(value === null && schema.nullable === true)
  )
    return false;
  if (owns(schema, "const") && encoded(schema.const) !== encoded(value)) return false;
  if (schema.enum && !schema.enum.some((item) => encoded(item) === encoded(value))) return false;
  if (schema.$ref && !accepts(value, pointer(doc, schema.$ref), doc, next)) return false;
  if (schema.allOf && !schema.allOf.every((member) => accepts(value, member, doc, next)))
    return false;
  if (schema.anyOf && !schema.anyOf.some((member) => accepts(value, member, doc, next)))
    return false;
  if (
    schema.oneOf &&
    schema.oneOf.filter((member) => accepts(value, member, doc, next)).length !== 1
  )
    return false;
  return true;
}

function schemaReader(doc) {
  const cache = new WeakMap();
  const ids = new WeakMap();
  const validated = new WeakSet();
  let sequence = 0;
  function id(value) {
    if (!object(value)) return String(value);
    if (!ids.has(value)) ids.set(value, ++sequence);
    return ids.get(value);
  }
  function atom(schema) {
    for (const keyword of [
      "not",
      "if",
      "then",
      "else",
      "prefixItems",
      "patternProperties",
      "dependentSchemas",
      "dependentRequired",
      "unevaluatedProperties",
      "unevaluatedItems",
      "$dynamicRef",
    ]) {
      if (owns(schema, keyword)) throw new Error(`无法可靠比较 schema.${keyword}`);
    }
    const types = schema.type === undefined ? TYPES : [].concat(schema.type);
    if (!types.every((type) => TYPES.includes(type))) throw new Error("不认识的 schema.type");
    const allowed = schema.nullable === true ? [...new Set([...types, "null"])] : types;
    const enums = owns(schema, "const")
      ? [schema.const]
      : (schema.enum ?? (allowed.length === 1 && allowed[0] === "null" ? [null] : undefined));
    if (enums !== undefined && !Array.isArray(enums)) throw new Error("schema.enum 必须是数组");
    if (schema.properties !== undefined && !object(schema.properties))
      throw new Error("schema.properties 必须是对象");
    if (
      schema.required !== undefined &&
      (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string"))
    )
      throw new Error("schema.required 必须是字段名数组");
    return {
      types: allowed,
      enums,
      open: schema["x-open-enum"] === true,
      props: Object.assign(
        Object.create(null),
        Object.fromEntries(
          Object.entries(schema.properties ?? {}).map(([key, child]) => [key, [child]]),
        ),
      ),
      required: schema.required ?? [],
      items: schema.items === undefined ? [] : [schema.items],
      additional: object(schema.additionalProperties) ? [schema.additionalProperties] : [],
    };
  }
  function merge(a, b) {
    const types = intersect(a.types, b.types);
    const enums =
      a.enums === undefined
        ? b.enums
        : b.enums === undefined
          ? a.enums
          : a.enums.filter((value) => b.enums.some((other) => encoded(value) === encoded(other)));
    const props = Object.assign(Object.create(null), a.props);
    for (const [key, parts] of Object.entries(b.props))
      props[key] = [...(props[key] ?? []), ...parts];
    return {
      types,
      enums,
      props,
      open: a.open || b.open,
      required: [...new Set([...a.required, ...b.required])],
      items: [...a.items, ...b.items],
      additional: [...a.additional, ...b.additional],
    };
  }
  function product(left, right) {
    if (left.length * right.length > 128) throw new Error("schema 分支超过 128，无法可靠比较");
    return left
      .flatMap((a) => right.map((b) => merge(a, b)))
      .filter(
        (view) => view.types.length > 0 && (view.enums === undefined || view.enums.length > 0),
      );
  }
  function validate(schema) {
    if (typeof schema === "boolean") return;
    if (!object(schema)) throw new Error("schema 必须是对象或布尔值");
    if (validated.has(schema)) return;
    validated.add(schema);
    atom(schema);
    if (owns(schema, "$ref")) validate(pointer(doc, schema.$ref));
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      if (schema[key] === undefined) continue;
      if (!Array.isArray(schema[key])) throw new Error(`${key} 必须是数组`);
      for (const member of schema[key]) validate(member);
    }
    for (const child of Object.values(schema.properties ?? {})) validate(child);
    if (schema.items !== undefined) validate(schema.items);
    if (object(schema.additionalProperties)) validate(schema.additionalProperties);
  }
  function views(schema, chain = new Set()) {
    if (schema === true) return [atom({})];
    if (schema === false) return [];
    if (!object(schema)) throw new Error("schema 必须是对象或布尔值");
    validate(schema);
    if (cache.has(schema)) return cache.get(schema);
    if (chain.has(schema)) throw new Error("schema 顶层组合纯引用环，无法可靠比较");
    const next = new Set([...chain, schema]);
    let result = [atom(schema)];
    if (owns(schema, "$ref")) result = product(result, views(pointer(doc, schema.$ref), next));
    if (schema.allOf !== undefined) {
      if (!Array.isArray(schema.allOf)) throw new Error("allOf 必须是数组");
      for (const member of schema.allOf) result = product(result, views(member, next));
    }
    for (const key of ["anyOf", "oneOf"]) {
      if (schema[key] === undefined) continue;
      if (!Array.isArray(schema[key]) || schema[key].length === 0)
        throw new Error(`${key} 必须是非空数组`);
      // oneOf 的互斥条件不改变这里的字段/枚举投影；分支对应由真实判别字段匹配。
      result = product(
        result,
        schema[key].flatMap((member) => views(member, next)),
      );
    }
    result = result
      .map((view) => ({
        ...view,
        enums: view.enums?.filter((value) => accepts(value, schema, doc)),
      }))
      .filter((view) => view.enums === undefined || view.enums.length > 0);
    cache.set(schema, result);
    return result;
  }
  function parts(schemas) {
    return schemas.reduce((result, schema) => product(result, views(schema)), [atom({})]);
  }
  return {
    parts,
    nullable: (schemas) => schemas.every((schema) => accepts(null, schema, doc)),
    key: (schemas) => schemas.map(id).join(","),
  };
}

const valuesOf = (views) =>
  views.some((view) => view.enums === undefined)
    ? undefined
    : [
        ...new Map(
          views.flatMap((view) => view.enums).map((value) => [encoded(value), value]),
        ).values(),
      ];

function compareSchemas(oldDoc, newDoc) {
  const oldReader = schemaReader(oldDoc);
  const newReader = schemaReader(newDoc);
  function compatibleBranch(a, b) {
    if (intersect(a.types, b.types).length === 0) return false;
    for (const key of Object.keys(a.props)) {
      if (!b.props[key]) continue;
      const left = valuesOf(oldReader.parts(a.props[key]));
      const right = valuesOf(newReader.parts(b.props[key]));
      if (
        left?.length &&
        right?.length &&
        !left.some((value) => right.some((other) => encoded(value) === encoded(other)))
      )
        return false;
    }
    return true;
  }
  function coverageVariants(origin, candidates, reader, otherReader) {
    let variants = [Object.create(null)];
    if (candidates.length < 2) return variants;
    for (const key of origin.required) {
      if (!origin.props[key]) continue;
      const values = valuesOf(reader.parts(origin.props[key]));
      if (!values || values.length < 2) continue;
      if (
        !candidates.some((candidate) => {
          const other = valuesOf(otherReader.parts(candidate.props[key] ?? []));
          return (
            other && values.some((value) => !other.some((item) => encoded(item) === encoded(value)))
          );
        })
      )
        continue;
      if (variants.length * values.length > 128)
        throw new Error("schema 分支超过 128，无法可靠比较");
      // 联合枚举组合分别覆盖，不能把 (a,x)/(b,y) 当成完整的笛卡尔积。
      variants = variants.flatMap((variant) =>
        values.map((value) => Object.assign(Object.create(null), variant, { [key]: [value] })),
      );
    }
    return variants;
  }
  function compare(oldParts, newParts, path, mode, required, active = new Set(), limit) {
    budget();
    const pair = `${oldReader.key(oldParts)}|${newReader.key(newParts)}|${mode}|${required}|${encoded(limit)}`;
    if (active.has(pair)) return [];
    const next = new Set([...active, pair]);
    const before = oldReader.parts(oldParts);
    const after = newReader.parts(newParts);
    const problems = [];
    if (before.length === 0 || after.length === 0) throw new Error("空 schema 交集，无法可靠比较");
    if (
      mode === "response" &&
      required &&
      !oldReader.nullable(oldParts) &&
      (limit === undefined || limit.some((value) => value === null)) &&
      newReader.nullable(newParts)
    )
      problems.push(`${path}：响应必有字段变为可空`);
    const oldValues = (mode === "request" ? limit : undefined) ?? valuesOf(before);
    const newValues = (mode === "response" ? limit : undefined) ?? valuesOf(after);
    if (
      oldValues &&
      mode === "request" &&
      newValues &&
      oldValues.some((value) => !newValues.some((other) => encoded(value) === encoded(other)))
    )
      problems.push(`${path}：请求枚举删值`);
    if (
      oldValues &&
      mode === "response" &&
      !before.every((view) => view.open || view.enums?.every((value) => value === null)) &&
      (newValues === undefined ||
        newValues.some((value) => !oldValues.some((other) => encoded(value) === encoded(other))))
    )
      problems.push(`${path}：响应封闭枚举加值（旧契约未标 x-open-enum）`);
    const oldObjects = before.filter((view) => view.types.some((type) => type !== "null"));
    const newObjects = after.filter((view) => view.types.some((type) => type !== "null"));
    const origins = mode === "request" ? oldObjects : newObjects;
    for (const origin of origins) {
      const candidates = (mode === "request" ? newObjects : oldObjects).filter((candidate) =>
        mode === "request"
          ? compatibleBranch(origin, candidate)
          : compatibleBranch(candidate, origin),
      );
      // 判别值全变时也比较字段：枚举变化的诊断不能掩盖其它字段破坏。
      const matches = candidates.length ? candidates : mode === "request" ? newObjects : oldObjects;
      const reader = mode === "request" ? oldReader : newReader;
      const otherReader = mode === "request" ? newReader : oldReader;
      for (const limits of coverageVariants(origin, matches, reader, otherReader)) {
        const eligible = matches.filter((candidate) =>
          Object.entries(limits).every(([key, values]) => {
            const other = valuesOf(otherReader.parts(candidate.props[key] ?? []));
            return (
              other === undefined ||
              values.some((value) => other.some((item) => encoded(item) === encoded(value)))
            );
          }),
        );
        const choices = (eligible.length ? eligible : matches).map((candidate) => {
          const a = mode === "request" ? origin : candidate;
          const b = mode === "request" ? candidate : origin;
          const found = [];
          if (mode === "request")
            for (const key of b.required) {
              if (!a.required.includes(key)) found.push(`${path}.${key}：请求新增必填字段`);
            }
          for (const [key, child] of Object.entries(a.props)) {
            if (!owns(b.props, key)) {
              if (mode === "response") found.push(`${path}.${key}：响应删字段`);
              continue;
            }
            if (mode === "response" && a.required.includes(key) && !b.required.includes(key))
              found.push(`${path}.${key}：响应字段不再必有`);
            found.push(
              ...compare(
                child,
                b.props[key],
                `${path}.${key}`,
                mode,
                a.required.includes(key),
                next,
                limits[key],
              ),
            );
          }
          if (a.items.length || b.items.length)
            found.push(...compare(a.items, b.items, `${path}[]`, mode, true, next));
          if (a.additional.length && b.additional.length)
            found.push(...compare(a.additional, b.additional, `${path}.*`, mode, true, next));
          return found;
        });
        if (choices.length) problems.push(...choices.sort((a, b) => a.length - b.length)[0]);
      }
    }
    return [...new Set(problems)];
  }
  return (a, b, path, mode, required = true) => compare([a], [b], path, mode, required);
}

function compareDocuments(before, after) {
  if (!object(before.paths) || !object(after.paths)) throw new Error("OpenAPI 缺少 paths 对象");
  const compare = compareSchemas(before, after);
  const problems = [];
  for (const [path, rawPath] of Object.entries(before.paths)) {
    const oldPath = entry(rawPath, before);
    const newPath = owns(after.paths, path) ? entry(after.paths[path], after) : {};
    for (const method of METHODS.filter((key) => owns(oldPath, key))) {
      const route = `${method.toUpperCase()} ${path}`;
      const add = (message) => problems.push(`${route} ${message}`);
      const checked = (...args) => {
        try {
          return compare(...args);
        } catch (error) {
          throw new Error(`${route} ${args[2]}：${error.message}`, { cause: error });
        }
      };
      if (!owns(newPath, method)) {
        add("路径/方法被删除");
        continue;
      }
      const oldOp = entry(oldPath[method], before);
      const newOp = entry(newPath[method], after);
      if (typeof oldOp.operationId !== "string" || typeof newOp.operationId !== "string")
        throw new Error(`${route} 缺少 operationId`);
      if (oldOp.operationId !== newOp.operationId) add("operationId 被改名");
      const parameters = (item, operation, doc) => {
        const merged = new Map();
        for (const raw of [...(item.parameters ?? []), ...(operation.parameters ?? [])]) {
          const value = entry(raw, doc);
          if (typeof value.name !== "string" || typeof value.in !== "string")
            throw new Error(`${route} parameter 缺少 name/in`);
          merged.set(`${value.in}:${value.name}`, value);
        }
        return merged;
      };
      const oldParams = parameters(oldPath, oldOp, before);
      const newParams = parameters(newPath, newOp, after);
      for (const [key, current] of newParams) {
        const previous = oldParams.get(key);
        if (current.required === true && previous?.required !== true)
          add(`request.${key}：请求新增必填字段`);
        if (previous?.schema !== undefined && current.schema !== undefined)
          for (const problem of checked(
            previous.schema,
            current.schema,
            `request.${key}`,
            "request",
          ))
            add(problem);
      }
      const body = (operation, doc) =>
        operation.requestBody === undefined ? undefined : entry(operation.requestBody, doc);
      const oldBody = body(oldOp, before);
      const newBody = body(newOp, after);
      if (newBody?.required === true && oldBody?.required !== true)
        add("request.body：请求新增必填字段");
      function content(left, right, label, mode) {
        for (const [media, value] of Object.entries(left?.content ?? {})) {
          const target = right?.content?.[media];
          if (!target) {
            if (mode === "response") add(`${label}.${media}：响应删字段（媒体类型）`);
          } else {
            for (const problem of checked(value.schema ?? true, target.schema ?? true, label, mode))
              add(problem);
          }
        }
      }
      content(oldBody, newBody, "request.body", "request");
      if (!object(oldOp.responses) || !object(newOp.responses))
        throw new Error(`${route} 缺少 responses`);
      for (const [status, raw] of Object.entries(oldOp.responses)) {
        if (!owns(newOp.responses, status)) {
          add(`response.${status}：响应删字段（状态）`);
          continue;
        }
        content(
          entry(raw, before),
          entry(newOp.responses[status], after),
          `response.${status}`,
          "response",
        );
      }
    }
  }
  return problems;
}

try {
  const retiredPath = "packages/contract/released/retired.json";
  const retired = parse(readFileSync(resolve(root, retiredPath), "utf8"), retiredPath);
  if (!Array.isArray(retired)) throw new Error("retired.json 必须是数组");
  const excluded = new Set();
  for (const row of retired) {
    if (
      !object(row) ||
      Object.keys(row).sort().join(",") !== "date,reason,version" ||
      typeof row.version !== "string" ||
      !/^(?:weapp-)?v[^\s:]+$/u.test(row.version) ||
      typeof row.reason !== "string" ||
      row.reason.trim() === "" ||
      typeof row.date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/u.test(row.date) ||
      !Number.isFinite(Date.parse(row.date)) ||
      new Date(row.date).toISOString().slice(0, 10) !== row.date ||
      excluded.has(row.version)
    )
      throw new Error("retired.json 条目无效或版本重复（version/reason/date）");
    excluded.add(row.version);
  }
  const tags = git(
    "for-each-ref",
    "--sort=-version:refname",
    "--sort=-creatordate",
    "--format=%(refname:strip=2)",
    "refs/tags",
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  const weapp = tags.filter((tag) => tag.startsWith("weapp-v") && !excluded.has(tag));
  const server = tags.filter((tag) => tag.startsWith("v") && !excluded.has(tag)).slice(0, 1);
  if (weapp.length > 4)
    console.warn(`提醒：${weapp.length} 个在役 weapp 版本（超过 4 个）；继续逐一比较`);
  let failures = 0;
  let compared = 0;
  for (const [client, versions] of [
    ["merchant", weapp],
    ["admin", server],
    ["portal", server],
  ]) {
    if (versions.length === 0) {
      console.log(`${client}：无可比版本`);
      continue;
    }
    const path = `packages/contract/generated/${client}.openapi.json`;
    const current = parse(readFileSync(resolve(root, path), "utf8"), path);
    for (const version of versions) {
      try {
        const previous = parse(git("show", `${version}:${path}`), `${version}:${path}`);
        const problems = compareDocuments(previous, current);
        for (const problem of problems) console.error(`[${client} ${version}] ${problem}`);
        failures += problems.length;
        compared += 1;
        if (problems.length === 0) console.log(`${client} ${version}：兼容`);
      } catch (error) {
        failures += 1;
        console.error(`[${client} ${version}] ${path}：${error.message}`);
      }
    }
  }
  budget();
  console.log(`contract:compat：比较 ${compared} 份快照，${failures} 处失败`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  console.error(`contract:compat 未通过：${error.message}`);
  process.exitCode = 1;
}
