import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { repoRoot } from "./helpers.js";

const names = ["server", "gateway", "mediatool", "weapp-uploader"];
const sha = "a".repeat(40);
const tag = `sha-${sha.slice(0, 12)}`;
const digest = (raw: string) => `sha256:${createHash("sha256").update(raw).digest("hex")}`;
const dirs: string[] = [];
function script(file: string, name: string) {
  const body = readFileSync(join(repoRoot, ".github/workflows", file), "utf8")
    .split(`      - name: ${name}\n`)[1]!
    .split(/^ {6}- name:/m)[0]!;
  return body
    .split("        run: |\n")[1]!
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}
function fixture(store = "classic", mode = "normal") {
  const dir = mkdtempSync(join(tmpdir(), "lyx-image-facts-"));
  dirs.push(dir);
  const callsFile = join(dir, "calls.jsonl");
  const out = join(dir, "images-out");
  spawnSync("mkdir", ["-p", out]);
  const models = Object.fromEntries(
    names.map((name, index) => {
      const config = JSON.stringify({ os: "linux", architecture: "amd64", name });
      const child = JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: {
          mediaType: "application/vnd.oci.image.config.v1+json",
          digest: digest(config),
          size: config.length,
        },
        layers: [],
      });
      const descriptor = {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: digest(child),
        size: child.length,
        platform: { os: "linux", architecture: "amd64" },
      };
      const root =
        index % 2
          ? child
          : JSON.stringify({
              schemaVersion: 2,
              mediaType: "application/vnd.oci.image.index.v1+json",
              manifests: [descriptor],
            });
      return [name, { root, child, config, registry: digest(root), configDigest: digest(config) }];
    }),
  );
  const env = {
    PATH: `${dir}:${process.env.PATH}`,
    RUNNER_TEMP: dir,
    HOME: dir,
    GITHUB_SHA: sha,
    TAG: tag,
    EXPECTED_SHA: sha,
    REGISTRY: "registry.invalid",
    NAMESPACE: "liyoxi",
    REGISTRY_USER: "fake-user",
    REGISTRY_PASSWORD: "fake-password",
    WEAPP_APPID: "wx0123456789abcdef",
    WEAPP_API_BASE_URL: "https://api.invalid",
    STG_NODE_USER: "release",
    STG_NODE_HOST: "node.invalid",
    SSH_PRIVATE_KEY: "fake-key",
    SSH_KNOWN_HOSTS: "fake-host",
    FAKE_CALLS: callsFile,
  };
  const archive = "offline fixture";
  writeFileSync(join(out, "weapp.tar.gz"), archive);
  writeFileSync(join(out, "images.tar.gz"), "offline fixture");
  writeFileSync(
    join(out, "source.json"),
    JSON.stringify({
      source: sha,
      tag,
      appid: env.WEAPP_APPID,
      apiBaseUrl: env.WEAPP_API_BASE_URL,
      weappSha256: createHash("sha256").update(archive).digest("hex"),
    }),
  );
  const docker = join(dir, "docker");
  writeFileSync(
    docker,
    `#!${process.execPath}
import fs from "node:fs";
const args=process.argv.slice(2),models=${JSON.stringify(models)},mode=${JSON.stringify(mode)};
fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify(["docker",...args])+"\\n");
if(args[0]!=="buildx")process.exit(0);
if(mode==="docker-error")process.exit(1);
const ref=args[3],name=ref.match(/\\/(server|gateway|mediatool|weapp-uploader)(?=[:@])/)?.[1],m=models[name];
if(!m)process.exit(2);
if(args.includes("--raw")) {
 let raw=ref.endsWith(m.registry)?m.root:m.child;
 if(mode==="raw-mismatch")raw+=" ";
 if(mode==="bad-json")raw="not-json";
 process.stdout.write(raw);
} else if(args.includes("{{json .Image}}")) process.stdout.write(JSON.stringify({os:"linux",architecture:mode==="wrong-platform"?"arm64":"amd64"}));
else process.stdout.write(m.registry+"\\n");
`,
  );
  chmodSync(docker, 0o755);
  const ssh = join(dir, "ssh");
  writeFileSync(
    ssh,
    `#!${process.execPath}
import fs from "node:fs";
const args=process.argv.slice(2),models=${JSON.stringify(models)},mode=${JSON.stringify(mode)},store=${JSON.stringify(store)};
fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify(["ssh",...args])+"\\n");
if(!args.includes("image-facts"))process.exit(0);
const rows=["server","gateway","mediatool"].map(n=>"LYX_IMAGE="+n+"|"+(store==="classic"?models[n].configDigest:models[n].registry));
if(mode==="wrong-config")rows[0]="LYX_IMAGE=server|sha256:"+"f".repeat(64);
if(mode==="duplicate")rows.push(rows[0]);
if(mode==="missing-row")rows.pop();
if(mode==="bad-row")rows[0]="LYX_IMAGE=server|broken";
if(mode==="unknown-row")rows.push("LYX_IMAGE=unrelated|"+models.server.registry);
process.stdout.write(rows.join("\\n")+"\\n");
`,
  );
  chmodSync(ssh, 0o755);
  const run = (text: string) =>
    spawnSync("bash", ["-c", text], { cwd: repoRoot, env, encoding: "utf8" });
  const publish = () => run(script("images.yml", "验证发布配置并推四镜像"));
  const deploy = () => {
    const before = script("deploy-stg.yml", "验证同源摘要并走登记的预发节点步骤").split(
      "node infra/deploy/orchestrate.mjs --tag",
    )[0]!;
    // 运行真实工作流的全部核验语句；只将正式编排入口替换为无外部效果的到达标记。
    return run(`${before}\nprintf '"orchestrate"\\n' >> "$FAKE_CALLS"`);
  };
  const calls = () =>
    readFileSync(callsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  const artifactFile = join(dir, "images-release/images.json");
  return { publish, deploy, calls, artifactFile, models };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("镜像制品事实：真实 Node 工作流与 fake Docker/SSH", () => {
  it.each(["classic", "containerd"])("同源 %s 镜像允许到达编排入口", (store) => {
    const f = fixture(store);
    expect(f.publish().status).toBe(0);
    const deployed = f.deploy();
    expect(deployed.stderr).toBe("");
    expect(deployed.status).toBe(0);
    expect(f.calls()).toContain("orchestrate");
  });
  it.each(["wrong-config", "duplicate", "missing-row", "bad-row", "unknown-row"])(
    "节点 %s 在编排前停止",
    (mode) => {
      const f = fixture("classic", mode);
      expect(f.publish().status).toBe(0);
      expect(f.deploy().status).not.toBe(0);
      expect(f.calls()).not.toContain("orchestrate");
    },
  );
  it.each([
    "missing-config",
    "bad-config",
    "extra-field",
    "missing-image",
    "extra-image",
    "wrong-source",
    "wrong-tag",
  ])("制品 %s 在节点拉取前停止", (mode) => {
    const f = fixture();
    expect(f.publish().status).toBe(0);
    const artifact = JSON.parse(readFileSync(f.artifactFile, "utf8"));
    if (mode === "missing-config") delete artifact.images.server.amd64ConfigDigest;
    if (mode === "bad-config") artifact.images.server.amd64ConfigDigest = "broken";
    if (mode === "extra-field") artifact.images.server.unverified = f.models.server!.registry;
    if (mode === "missing-image") delete artifact.images.gateway;
    if (mode === "extra-image") artifact.images.unrelated = artifact.images.server;
    if (mode === "wrong-source") artifact.source = "b".repeat(40);
    if (mode === "wrong-tag") artifact.tag = "sha-bbbbbbbbbbbb";
    writeFileSync(f.artifactFile, JSON.stringify(artifact));
    expect(f.deploy().status).not.toBe(0);
    expect(f.calls().filter((call) => Array.isArray(call) && call[0] === "ssh")).toEqual([]);
    expect(f.calls()).not.toContain("orchestrate");
  });
  it.each(["raw-mismatch", "bad-json", "wrong-platform", "docker-error"])(
    "Docker %s 不产生可部署制品",
    (mode) => {
      const f = fixture("classic", mode);
      expect(f.publish().status).not.toBe(0);
    },
  );
});
