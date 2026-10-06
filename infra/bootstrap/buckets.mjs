#!/usr/bin/env node
// D5 §3.1/3.5 与 W2-25：只比较四个预发桶。生命周期 PUT 是完整替换，未知规则先拒绝。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROLES = ["secure", "asset", "media", "pub"];
const CONFIG = JSON.parse(readFileSync(join(HERE, "buckets.json"), "utf8"));
const FIELDS = ["acl", "policy", "versioning", "encryption", "lifecycle"];
const SSE = { Rule: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] };
const object = (value) => value && typeof value === "object" && !Array.isArray(value);

// COS XML 的整数和布尔值读回为字符串；规则顺序不表达优先级。
function canonical(value, key = "") {
  if (key === "Transition" && Array.isArray(value) && value.length === 1)
    return canonical(value[0]);
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item));
    return key === "Rule" ? items.sort((a, b) => a.ID.localeCompare(b.ID)) : items;
  }
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => [name, canonical(value[name], name)]),
    );
  if (["Days", "NoncurrentDays", "DaysAfterInitiation"].includes(key)) {
    if (!/^\d+$/.test(String(value))) throw new Error("生命周期天数无效");
    return Number(value);
  }
  return value;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function extraFields(value, expected) {
  if (Array.isArray(value))
    return (
      !Array.isArray(expected) ||
      value.length > expected.length ||
      value.some((item, index) => extraFields(item, expected[index]))
    );
  if (!object(value)) return false;
  if (!object(expected)) return true;
  return Object.keys(value).some(
    (key) => !(key in expected) || extraFields(value[key], expected[key]),
  );
}

function privateAcl(value) {
  const grants = value.AccessControlList?.Grant;
  if (!object(value.Owner) || typeof value.Owner.ID !== "string" || !Array.isArray(grants))
    throw new Error("ACL 返回结构无法识别");
  if (!grants.length) throw new Error("ACL 缺少属主授权");
  let publicGrant = false;
  for (const grant of grants) {
    if (!object(grant.Grantee)) throw new Error("ACL 授权无法识别");
    const grantee = grant.Grantee;
    if (
      grantee.Type === "CanonicalUser" &&
      grantee.ID === value.Owner.ID &&
      grant.Permission === "FULL_CONTROL"
    )
      continue;
    if (grantee.Type === "Group" && /\/groups\/global\/AllUsers$/.test(grantee.URI ?? ""))
      publicGrant = true;
    else throw new Error("存在声明外 ACL 授权，须人工核对");
  }
  return !publicGrant;
}

function differences(state, bucket, target) {
  if (!object(state) || FIELDS.some((field) => !object(state[field])))
    throw new Error("桶状态字段不完整");
  const changes = [];
  const blocked = [];
  if (!privateAcl(state.acl)) changes.push(["acl", { ACL: "private" }]);
  if (Object.keys(state.policy).length) blocked.push("存在声明外桶策略，须人工核对");
  const status = state.versioning.Status ?? "Off";
  if (!["Off", "Enabled", "Suspended"].includes(status)) throw new Error("版本状态无法识别");
  if (Object.keys(state.versioning).some((key) => key !== "Status"))
    throw new Error("版本响应无法识别");
  if (status !== target.versioning) {
    if (target.versioning === "Off") blocked.push("pub 已启用过版本，暂停不等于从未开启");
    else changes.push(["versioning", { Status: "Enabled" }]);
  }
  if (!same(state.encryption, target.encryption ? SSE : {})) {
    if (!target.encryption || Object.keys(state.encryption).length)
      blocked.push("存在声明外加密配置，须人工核对");
    else changes.push(["encryption", SSE]);
  }
  if (Object.keys(state.lifecycle).some((key) => key !== "Rule"))
    throw new Error("生命周期响应无法识别");
  const rules = state.lifecycle.Rule ?? [];
  if (!Array.isArray(rules) || rules.some((rule) => !object(rule) || typeof rule.ID !== "string"))
    throw new Error("生命周期规则无法识别");
  if (new Set(rules.map((rule) => rule.ID)).size !== rules.length)
    throw new Error("生命周期 ID 重复");
  if (
    rules.some((rule) => {
      const expected = target.rules.find((item) => item.ID === rule.ID);
      return !expected || extraFields(canonical(rule), canonical(expected));
    })
  )
    blocked.push("存在声明外生命周期，禁止覆盖");
  const lifecycle = { Rule: target.rules };
  if (!same({ Rule: rules }, lifecycle)) changes.push(["lifecycle", lifecycle]);
  return { bucket, changes, blocked };
}

function provider(appid, env) {
  // 只有明确配置的工具/凭据文件才进入在线模式；不从宿主环境猜测或寻找账号。
  const executable = env.LYX_COS_ADAPTER;
  const credentials = env.LYX_COS_CREDENTIAL_FILE;
  if (!executable || !credentials) throw new Error("须显式配置 COS adapter 与凭据文件");
  const contents = JSON.parse(readFileSync(credentials, "utf8"));
  if (
    !object(contents) ||
    Object.keys(contents).some((key) => !["secretId", "secretKey", "sessionToken"].includes(key)) ||
    ![contents.secretId, contents.secretKey].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  )
    throw new Error("凭据文件结构无效");
  const childEnv = {
    PATH: env.PATH,
    LYX_COS_PYTHON: env.LYX_COS_PYTHON,
    LYX_COS_SECRET_ID: contents.secretId,
    LYX_COS_SECRET_KEY: contents.secretKey,
    LYX_COS_SESSION_TOKEN: contents.sessionToken ?? "",
    LYX_COS_APPLY_ENABLED: env.LYX_COS_APPLY_ENABLED ?? "false",
  };
  return (operation, role, configuration) => {
    const result = spawnSync(executable, [], {
      input: JSON.stringify({
        operation,
        bucket: `lyx-stg-${role}-${appid}`,
        ...(configuration ? { configuration } : {}),
      }),
      env: childEnv,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error("COS adapter 失败；未输出外部响应");
    const output = JSON.parse(result.stdout);
    if (!object(output) || Object.keys(output).join() !== "value" || !object(output.value))
      throw new Error("COS adapter 返回无法识别");
    return output.value;
  };
}

export function main(args, env = process.env) {
  const { values } = parseArgs({
    args: args[0] === "--" ? args.slice(1) : args,
    options: {
      check: { type: "boolean" },
      apply: { type: "boolean" },
      offline: { type: "boolean" },
      fixture: { type: "string" },
      appid: { type: "string" },
    },
  });
  if ((values.apply && (values.check || values.offline)) || (values.fixture && !values.offline))
    throw new Error("apply、check、offline 的组合无效");
  if (CONFIG.region !== "ap-shanghai" || Object.keys(CONFIG.buckets).join() !== ROLES.join())
    throw new Error("四桶声明无效");
  let readState;
  let call;
  if (values.offline) {
    const fixture = values.fixture ? JSON.parse(readFileSync(values.fixture, "utf8")) : null;
    if (
      fixture &&
      (!object(fixture) || Object.keys(fixture).sort().join() !== [...ROLES].sort().join())
    )
      throw new Error("离线夹具须包含完整四桶");
    const acl = {
      Owner: { ID: "offline-owner" },
      AccessControlList: {
        Grant: [
          { Grantee: { Type: "CanonicalUser", ID: "offline-owner" }, Permission: "FULL_CONTROL" },
        ],
      },
    };
    readState = (role) =>
      fixture?.[role] ?? { acl, policy: {}, versioning: {}, encryption: {}, lifecycle: {} };
  } else {
    if (!/^\d{5,20}$/.test(values.appid ?? "")) throw new Error("须提供 COS 数字 appid 后缀");
    if (values.apply && env.LYX_COS_APPLY_ENABLED !== "true")
      throw new Error("COS apply 尚未显式启用");
    call = provider(values.appid, env);
    readState = (role) => {
      call("head", role);
      return Object.fromEntries(FIELDS.map((field) => [field, call(`${field}.get`, role)]));
    };
  }
  // 写前完整读四桶；任何声明外配置/未知输出/缺桶都使所有 PUT 为零。
  const plan = ROLES.map((role) => differences(readState(role), role, CONFIG.buckets[role]));
  if (values.apply && plan.every((item) => item.blocked.length === 0)) {
    for (const item of plan)
      for (const [field, configuration] of item.changes)
        call(`${field}.put`, item.bucket, configuration);
    const verified = ROLES.map((role) => differences(readState(role), role, CONFIG.buckets[role]));
    if (verified.some((item) => item.changes.length || item.blocked.length))
      throw new Error("写后读回不一致");
    console.log("四桶配置已逐项读回一致");
    return 0;
  }
  console.log(
    JSON.stringify(
      plan.map(({ bucket, changes, blocked }) => ({
        bucket,
        differences: changes.map(([field]) => field),
        blocked,
      })),
      null,
      2,
    ),
  );
  return plan.some((item) => item.changes.length || item.blocked.length) ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch {
    console.error("桶核对失败：参数、配置或 Provider 不符合要求；未回显外部数据");
    process.exitCode = 2;
  }
}
