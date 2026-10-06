import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { repoRoot } from "./helpers.js";

const script = join(repoRoot, "infra/bootstrap/buckets.mjs");
const roles = ["secure", "asset", "media", "pub"];
const dirs: string[] = [];
const acl = {
  Owner: { ID: "fake-owner" },
  AccessControlList: {
    Grant: [{ Grantee: { Type: "CanonicalUser", ID: "fake-owner" }, Permission: "FULL_CONTROL" }],
  },
  CannedACL: "private",
};
const initial = () =>
  Object.fromEntries(
    roles.map((role) => [role, { acl, policy: {}, versioning: {}, encryption: {}, lifecycle: {} }]),
  );

function fixture(state = initial(), mode = "normal") {
  const dir = mkdtempSync(join(tmpdir(), "lyx-buckets-"));
  dirs.push(dir);
  const stateFile = join(dir, "state.json");
  const log = join(dir, "calls.jsonl");
  const cli = join(dir, "cos-fake.mjs");
  writeFileSync(stateFile, JSON.stringify(state));
  writeFileSync(
    join(dir, "credentials.json"),
    JSON.stringify({ secretId: "fake-id", secretKey: "fake-key" }),
  );
  // 真 Node 子进程的边界替身：记录 operation，PUT 修改现状，再由入口 GET 读回。
  writeFileSync(
    cli,
    `#!/usr/bin/env node
import fs from "node:fs";
const input=JSON.parse(fs.readFileSync(0,"utf8"));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(input)+"\\n");
const mode=${JSON.stringify(mode)};
if(mode==="nonzero") { process.stderr.write("fake-key must never escape");process.exit(1); }
if(mode==="bad-json") { process.stdout.write("not-json fake-key");process.exit(0); }
const file=${JSON.stringify(stateFile)},state=JSON.parse(fs.readFileSync(file));
const role=input.bucket.match(/^lyx-stg-(secure|asset|media|pub)-1234567890$/)?.[1];
if(!role)process.exit(2);
const [field,action]=input.operation.split(".");
if(action==="put") {
  if(process.env.LYX_COS_APPLY_ENABLED!=="true")process.exit(2);
  if(mode!=="stale")state[role][field]=field==="acl"?${JSON.stringify(acl)}:input.configuration;
  fs.writeFileSync(file,JSON.stringify(state));
}
let value=input.operation==="head"||action==="put"?{}:state[role][field];
if(field==="lifecycle"&&action==="get")value=JSON.parse(JSON.stringify(value,(key,v)=>["Days","NoncurrentDays","DaysAfterInitiation"].includes(key)?String(v):key==="Transition"&&!Array.isArray(v)?[v]:v));
console.log(JSON.stringify({value}));
`,
  );
  chmodSync(cli, 0o755);
  const run = (args: string[], enabled = false) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        LYX_COS_ADAPTER: cli,
        LYX_COS_CREDENTIAL_FILE: join(dir, "credentials.json"),
        LYX_COS_APPLY_ENABLED: enabled ? "true" : "false",
      },
    });
  const calls = () => {
    try {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  return { run, calls, dir, state: () => JSON.parse(readFileSync(stateFile, "utf8")) };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("预发四桶命令：真实 Node 与子进程边界", () => {
  it("默认只读：完整四桶有差异但所有云写为零；输出不含凭据", () => {
    const f = fixture();
    const r = f.run(["--appid", "1234567890"]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout).map((v: { bucket: string }) => v.bucket)).toEqual(roles);
    expect(f.calls()).toHaveLength(24);
    expect(f.calls().some((v) => v.operation.endsWith(".put"))).toBe(false);
    expect(r.stdout + r.stderr).not.toMatch(/fake-key|fake-id/);
  });

  it("显式 apply 写完整 D5 四桶并真实读回，重复执行零写", () => {
    const f = fixture();
    expect(f.run(["--apply", "--appid", "1234567890"], true).status).toBe(0);
    const state = f.state();
    const rules = (role: string) =>
      Object.fromEntries(state[role].lifecycle.Rule.map((v: { ID: string }) => [v.ID, v]));
    for (const role of roles)
      expect(rules(role)["lyx-multipart"].AbortIncompleteMultipartUpload.DaysAfterInitiation).toBe(
        7,
      );
    for (const role of ["secure", "asset", "media"]) {
      expect(state[role].versioning.Status).toBe("Enabled");
      expect(rules(role)["lyx-incoming"].Expiration.Days).toBe(3);
      expect(rules(role)["lyx-versions"].NoncurrentVersionExpiration.NoncurrentDays).toBe(
        role === "secure" ? 90 : 30,
      );
      expect(rules(role)["lyx-markers"].Expiration.ExpiredObjectDeleteMarker).toBe("true");
    }
    expect(state.pub.versioning).toEqual({});
    expect(rules("pub")["lyx-incoming"]).toBeUndefined();
    expect(rules("secure")["lyx-export"].Expiration.Days).toBe(2);
    expect(rules("secure")["lyx-ci"].Expiration.Days).toBe(7);
    expect(rules("media")["lyx-ci-out"].Expiration.Days).toBe(3);
    expect(rules("media")["lyx-final"].Transition).toEqual({
      Days: 60,
      StorageClass: "STANDARD_IA",
    });
    expect(state.secure.encryption.Rule[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm).toBe(
      "AES256",
    );
    const puts = f.calls().filter((v) => v.operation.endsWith(".put"));
    expect(puts).toHaveLength(8);
    expect(
      f
        .calls()
        .slice(0, 24)
        .every((v) => !v.operation.endsWith(".put")),
    ).toBe(true);
    expect(f.run(["--apply", "--appid", "1234567890"], true).status).toBe(0);
    expect(f.calls().filter((v) => v.operation.endsWith(".put"))).toHaveLength(8);
  });

  it.each(["Enabled", "Suspended"])("pub %s 阻止全部四桶 apply，不能把暂停伪装 Off", (Status) => {
    const state = initial();
    state.pub!.versioning = { Status };
    const f = fixture(state);
    expect(f.run(["--apply", "--appid", "1234567890"], true).status).toBe(1);
    expect(f.calls().some((v) => v.operation.endsWith(".put"))).toBe(false);
  });

  it.each(["policy", "lifecycle"])("声明外 %s 不被覆盖，写前读全四桶后零写", (field) => {
    const state = initial();
    state.media![field as "policy" | "lifecycle"] =
      field === "policy"
        ? { Statement: [{ Effect: "Allow", Principal: "*" }] }
        : { Rule: [{ ID: "external-retention", Status: "Enabled" }] };
    const f = fixture(state);
    expect(f.run(["--apply", "--appid", "1234567890"], true).status).toBe(1);
    expect(f.calls()).toHaveLength(24);
    expect(f.calls().some((v) => v.operation.endsWith(".put"))).toBe(false);
  });

  it.each(["nonzero", "bad-json", "stale"])("%s Provider 失败关闭，外部错误不被回显", (mode) => {
    const f = fixture(initial(), mode);
    const r = f.run(["--apply", "--appid", "1234567890"], true);
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).not.toContain("fake-key");
    if (mode !== "stale") expect(f.calls().some((v) => v.operation.endsWith(".put"))).toBe(false);
  });

  it.each([
    {
      ID: "lyx-incoming",
      Status: "Enabled",
      Filter: { Prefix: "incoming/", And: { Tag: { Key: "owner", Value: "external" } } },
      Expiration: { Days: 3 },
    },
    {
      ID: "lyx-final",
      Status: "Enabled",
      Filter: { Prefix: "final/" },
      Transition: [
        { Days: "60", StorageClass: "STANDARD_IA" },
        { Days: "180", StorageClass: "ARCHIVE" },
      ],
    },
  ])("受管理 ID $ID 中额外条件或多段沉降也不能被覆盖", (rule) => {
    const state = initial();
    state.media!.lifecycle = { Rule: [rule] };
    const f = fixture(state);
    expect(f.run(["--apply", "--appid", "1234567890"], true).status).toBe(1);
    expect(f.calls()).toHaveLength(24);
    expect(f.calls().some((v) => v.operation.endsWith(".put"))).toBe(false);
  });

  it("offline 不读取不存在的凭据或执行 adapter；非法组合及关闭 apply 在调用前拒绝", () => {
    const f = fixture();
    expect(f.run(["--check", "--offline"]).status).toBe(1);
    expect(f.run(["--apply", "--offline"], true).status).toBe(2);
    expect(f.run(["--apply", "--appid", "1234567890"]).status).toBe(2);
    expect(f.run(["--appid", "wx1234567890"]).status).toBe(2);
    expect(f.calls()).toEqual([]);
    const r = spawnSync(process.execPath, [script, "--offline"], {
      encoding: "utf8",
      env: { LYX_COS_CREDENTIAL_FILE: "/missing/credentials", LYX_COS_ADAPTER: "/missing/adapter" },
    });
    expect(r.status).toBe(1);
  });
});
