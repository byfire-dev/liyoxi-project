// W227b2：仅本轮私网的协议收件替身与编排；不提供生产endpoint配置。
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import https from "node:https";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_CA, TEST_CERT, TEST_KEY } from "./test/fixtures/observability-tls.mjs";

export const ERROR_HOST = "errors.lyx-rehearse.invalid";
export const WRONG_HOST = "wrong.lyx-rehearse.invalid";
export function assertProject(project) {
  if (!/^lyxrh-[a-f0-9]{6}$/.test(project)) throw new Error("观测演练项目身份不符");
}
export const publicDsn = (index) =>
  `https://public_fixture_${index}@client.example.invalid/${index}`;
export const upstreamDsn = (index) =>
  `https://upstream_fixture_${index}@${ERROR_HOST}/relay/${index}`;
export function envelope(index, eventId) {
  const payload = JSON.stringify({
    event_id: eventId,
    exception: {
      values: [
        {
          type: "Error",
          value: `rehearsal-${index} 19900000999 Bearer fixture_secret`,
          stack: "Error: rehearsal at https://admin.example.invalid/assets/public.js:1:1",
        },
      ],
    },
    request: { headers: { authorization: "fixture_secret" } },
  });
  return `${JSON.stringify({ dsn: publicDsn(index), event_id: eventId })}\n${JSON.stringify({ type: "event", length: Buffer.byteLength(payload) })}\n${payload}\n`;
}

/** 有界且只接收固定两类协议；失败不写成功收据。无宿主机端口、无请求正文日志。 */
export function receive(project) {
  assertProject(project);
  const records = [];
  writeFileSync("/tmp/receipts.json", "[]");
  const server = https.createServer({ ca: TEST_CA, cert: TEST_CERT, key: TEST_KEY }, (req, res) => {
    const chunks = [];
    let size = 0;
    req.setTimeout(3_000, () => req.destroy());
    req.on("data", (part) => {
      size += part.length;
      if (size > 200 * 1024) req.destroy();
      else chunks.push(part);
    });
    req.on("error", () => {});
    req.on("end", () => {
      const robot = req.url === `/cgi-bin/webhook/send?key=${project}_robot`;
      if (
        req.method !== "POST" ||
        records.length >= 8 ||
        (!robot && !/^\/relay\/api\/(101|102)\/envelope\/$/.test(req.url))
      ) {
        res.writeHead(400).end();
        return;
      }
      records.push({
        path: req.url,
        host: req.headers.host,
        type: req.headers["content-type"],
        auth: req.headers["x-sentry-auth"],
        body: Buffer.concat(chunks).toString("utf8"),
      });
      writeFileSync("/tmp/receipts.json", JSON.stringify(records));
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(robot ? { errcode: 0 } : {}));
    });
  });
  server.requestTimeout = 3_000;
  server.listen(443, "0.0.0.0");
  process.once("SIGTERM", () => server.close(() => process.exit(0)));
}

/** 收件是判据；入口202、铃铛成功、仅落库均不能替代外部通道受理。 */
export function verifyReceipts(records, { project, eventIds, alerts }) {
  assertProject(project);
  if (!Array.isArray(records) || records.length !== eventIds.length + (alerts ? 2 : 0))
    throw new Error("观测收件数量不符");
  for (const [index, eventId] of eventIds.entries()) {
    const id = 101 + index;
    const rows = records.filter((row) => row.path === `/relay/api/${id}/envelope/`);
    if (rows.length !== 1) throw new Error("错误信封未唯一收件");
    const row = rows[0];
    const parts = row.body.split("\n");
    if (parts.length !== 4) throw new Error("错误信封项数不符");
    const [head, item, payload, tail] = parts;
    const header = JSON.parse(head),
      meta = JSON.parse(item),
      event = JSON.parse(payload);
    if (
      row.host !== ERROR_HOST ||
      row.type !== "application/x-sentry-envelope" ||
      row.auth !== `Sentry sentry_version=7, sentry_key=upstream_fixture_${id}` ||
      header.dsn !== upstreamDsn(id) ||
      header.event_id !== eventId ||
      !Number.isFinite(Date.parse(header.sent_at)) ||
      meta.type !== "event" ||
      meta.length !== Buffer.byteLength(payload) ||
      event.event_id !== eventId ||
      tail !== "" ||
      event.request !== undefined ||
      !payload.includes(`rehearsal-${id}`) ||
      /19900000999|fixture_secret/.test(row.body)
    )
      throw new Error("错误信封固定映射或清洗不符");
  }
  if (alerts) {
    const rows = records.filter((row) => row.path === `/cgi-bin/webhook/send?key=${project}_robot`);
    const messages = rows.map((row) => {
      if (row.host !== "qyapi.weixin.qq.com" || !row.type?.startsWith("application/json"))
        throw new Error("机器人固定主机或协议不符");
      const body = JSON.parse(row.body);
      if (body.msgtype !== "text" || body.text.mentioned_list !== undefined)
        throw new Error("机器人文本协议不符");
      return body.text.content;
    });
    if (
      messages.length !== 2 ||
      !messages[0].includes(`告警 P2 webhook.backlog:${project}`) ||
      !messages[1].includes(`已恢复 P2 webhook.backlog:${project}`)
    )
      throw new Error("告警与恢复未依次收件");
  }
}

/** 仅生成本轮临时overlay；节点配置及Provider固定地址均不修改。 */
export function receiverOverlay({ home, project, image }) {
  assertProject(project);
  const trust = {
    environment: { NODE_EXTRA_CA_CERTS: "/rehearsal/ca.pem" },
    volumes: [`${home}/observability/ca.pem:/rehearsal/ca.pem:ro`],
  };
  return {
    services: {
      api: trust,
      worker: trust,
      receiver: {
        image,
        container_name: `${project}-receiver`,
        command: ["node", "/obs/observability-rehearsal.mjs", "--receive", project],
        user: "1000:1000",
        read_only: true,
        cap_drop: ["ALL"],
        security_opt: ["no-new-privileges:true"],
        tmpfs: ["/tmp:size=2m"],
        mem_limit: "64m",
        pids_limit: 32,
        restart: "no",
        sysctls: { "net.ipv4.ip_unprivileged_port_start": "0" },
        volumes: [`${home}/observability:/obs:ro`],
        networks: { default: { aliases: [ERROR_HOST, WRONG_HOST, "qyapi.weixin.qq.com"] } },
        healthcheck: {
          test: ["CMD", "node", "-e", "require('node:fs').accessSync('/tmp/receipts.json')"],
          interval: "1s",
          timeout: "2s",
          retries: 15,
        },
        logging: { driver: "json-file", options: { "max-size": "1m", "max-file": "1" } },
      },
    },
  };
}

export async function runObservability({
  root,
  home,
  env,
  config,
  hosts,
  flags,
  request,
  step,
  run,
  bootstrap,
}) {
  const project = env.LYX_NODE_PROJECT;
  assertProject(project);
  if (
    env.LYX_NODE_PREFIX !== project ||
    env.LYX_NODE_PROVIDERS !== "" ||
    env.LYX_NODE_HOME !== home ||
    env.LYX_SECRETS_DIR !== join(home, "secrets") ||
    !basename(home).startsWith("lyx-rehearse-")
  )
    throw new Error("观测演练须从默认自有项目开始");
  const directory = join(home, "observability");
  mkdirSync(join(directory, "test/fixtures"), { recursive: true });
  copyFileSync(fileURLToPath(import.meta.url), join(directory, "observability-rehearsal.mjs"));
  copyFileSync(
    join(root, "infra/deploy/test/fixtures/observability-tls.mjs"),
    join(directory, "test/fixtures/observability-tls.mjs"),
  );
  writeFileSync(join(directory, "ca.pem"), TEST_CA);
  const base = [
    "compose",
    "-p",
    project,
    "--env-file",
    join(root, "infra/compose/env/stg.env"),
    "-f",
    join(root, "infra/compose/node.yml"),
  ];
  const dockerOptions = () => ({
    capture: true,
    env: { ...env, LYX_TAG: config.tag },
    timeoutMs: 90_000,
  });
  const execute = (args) => {
    const result = run(args, dockerOptions());
    if (result.status !== 0)
      throw new Error(
        `观测演练Docker步骤失败:${args[0]} ${/观测演练夹具失败:[a-z_]+/.exec(result.stderr)?.[0] ?? ""}`,
      );
    return result;
  };
  const owned = (name) => {
    const [row] = JSON.parse(execute(["inspect", `${project}-${name}`]).stdout);
    if (
      row.Config.Labels["com.docker.compose.project"] !== project ||
      row.Config.Labels["com.docker.compose.service"] !== name
    )
      throw new Error("观测容器归属不符");
    return row;
  };
  const cleanup = (name, service, fixture = false) => {
    const containerName = `${project}-${name}`;
    const ids = execute([
      "container",
      "ls",
      "-a",
      "--filter",
      `name=^/${containerName}$`,
      "--format",
      "{{.ID}}",
    ])
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    if (!ids.length) return;
    if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0]))
      throw new Error("观测清理容器身份不唯一");
    const [row] = JSON.parse(execute(["inspect", "--type", "container", ids[0]]).stdout);
    const labels = row.Config.Labels;
    if (
      row.Name !== `/${containerName}` ||
      labels["com.docker.compose.project"] !== project ||
      labels["com.docker.compose.service"] !== service ||
      (fixture && labels["io.liyoxi.observability"] !== project)
    )
      throw new Error("观测清理拒绝非自有容器");
    execute(["rm", "-f", row.Id]);
  };
  const sendErrors = async () => {
    const ids = [];
    if (flags.errors)
      for (const [index, host, path] of [
        [101, hosts.api, "/api/v1/m/client-errors"],
        [102, hosts.admin, "/api/v1/admin/client-errors"],
      ]) {
        const id = randomBytes(16).toString("hex");
        const response = await request(host, path, {
          method: "POST",
          body: envelope(index, id),
          headers: {
            "Content-Type": "application/x-sentry-envelope",
            ...(index === 102 ? { Origin: `http://${host}`, "X-LYX-Admin": "1" } : {}),
          },
        });
        if (response.status !== 202) throw new Error("真实错误接口未受理");
        ids.push(id);
      }
    return ids;
  };
  owned("api");
  owned("worker");
  await sendErrors();
  if (flags.errors) {
    const logs = execute(["logs", "--tail", "200", `${project}-api`]);
    if (
      !`${logs.stdout}\n${logs.stderr}`.split("\n").some((line) => {
        try {
          const row = JSON.parse(line);
          return row.evt === "telemetry.forward" && row.outcome === "unconfigured";
        } catch {
          return false;
        }
      })
    )
      throw new Error("默认未配日志缺失");
  }
  const selected = [flags.errors ? "client-errors" : "", flags.alerts ? "alerts" : ""].filter(
    Boolean,
  );
  const files = selected.map((name) =>
    name === "alerts" ? "alerts.json" : "client-error-projects.json",
  );
  writeFileSync(
    join(env.LYX_SECRETS_DIR, "client-error-projects.json"),
    JSON.stringify({
      projects: [101, 102].map((index) => ({
        dsn: publicDsn(index),
        upstreamDsn: upstreamDsn(index),
      })),
    }),
    { mode: 0o400 },
  );
  writeFileSync(
    join(env.LYX_SECRETS_DIR, "alerts.json"),
    JSON.stringify({ robotKey: `${project}_robot`, oncallPhones: [] }),
    { mode: 0o400 },
  );
  if (process.platform === "linux")
    execute([
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "0",
      "-v",
      `${env.LYX_SECRETS_DIR}:/s`,
      "--entrypoint",
      "chown",
      config.images.server,
      "1000:1000",
      ...files.map((file) => `/s/${file}`),
    ]);
  const overlay = join(directory, "compose.json");
  writeFileSync(
    overlay,
    JSON.stringify(receiverOverlay({ home, project, image: config.images.server })),
  );
  const compose = [
    ...base,
    ...selected.flatMap((name) => ["-f", join(root, `infra/compose/providers/${name}.yml`)]),
    "-f",
    overlay,
  ];
  let stopped = false,
    failure;
  try {
    if (flags.alerts) bootstrap(base, { ...env, LYX_TAG: config.tag });
    stopped = true;
    step("stop", "worker");
    env.LYX_NODE_PROVIDERS = selected.join(" ");
    step("check-env", config.tag);
    execute([...compose, "up", "-d", "--wait", "--no-deps", "--pull", "never", "receiver", "api"]);
    execute([...compose, "create", "--no-deps", "--pull", "never", "worker"]);
    for (const service of ["api", "worker"]) {
      const row = owned(service);
      const mounted = row.Mounts.filter((one) => one.Destination.startsWith("/run/secrets/"))
        .map((one) => one.Destination.slice(13))
        .sort();
      const manifest = JSON.parse(
        readFileSync(join(root, "infra/deploy/secrets.manifest.json"), "utf8"),
      ).secrets;
      const expected = manifest
        .filter(
          (one) =>
            (one.required || files.includes(one.file)) && one.services.split(" ").includes(service),
        )
        .map((one) => one.file)
        .sort();
      if (
        JSON.stringify(mounted) !== JSON.stringify(expected) ||
        row.Mounts.some((one) => one.Destination.startsWith("/run/secrets/") && one.RW) ||
        !row.Config.Env.includes("NODE_EXTRA_CA_CERTS=/rehearsal/ca.pem") ||
        !row.Mounts.some((one) => one.Destination === "/rehearsal/ca.pem" && !one.RW)
      )
        throw new Error("观测FILE角色或只读CA挂载不符");
    }
    const receiver = owned("receiver");
    if (
      Object.keys(receiver.HostConfig.PortBindings ?? {}).length ||
      Object.keys(receiver.NetworkSettings.Networks).join() !== `${project}-node`
    )
      throw new Error("假收件端端口或网络越界");
    const eventIds = await sendErrors();
    const { build } = createRequire(join(root, "apps/worker/package.json"))("esbuild");
    const bundle = join(directory, "fixture.mjs");
    await build({
      absWorkingDir: root,
      entryPoints: ["infra/deploy/observability-rehearsal-fixture.mjs"],
      outfile: bundle,
      bundle: true,
      platform: "node",
      target: "node24",
      format: "esm",
      external: [
        "bullmq",
        "ioredis",
        "mammoth",
        "sanitize-html",
        "pdfjs-dist",
        "@napi-rs/canvas",
        "tencentcloud-sdk-nodejs-ocr",
      ],
      banner: {
        js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
      },
      logLevel: "silent",
    });
    const address = Object.values(owned("postgres").NetworkSettings.Networks)[0].IPAddress;
    const result = execute([
      ...compose,
      "run",
      "--rm",
      "-T",
      "--no-deps",
      "--pull",
      "never",
      "--name",
      `${project}-observability-fixture`,
      "--label",
      `io.liyoxi.observability=${project}`,
      "--volume",
      `${bundle}:/app/apps/worker/dist/observability-fixture.mjs:ro`,
      "--entrypoint",
      "node",
      "worker",
      "/app/apps/worker/dist/observability-fixture.mjs",
      project,
      address,
      flags.alerts ? "alerts" : "tls",
    ]);
    const fact = JSON.parse(result.stdout.trim());
    if (
      !fact.tlsVerified ||
      (flags.alerts &&
        (!fact.recovered || fact.notifyCount !== 2 || fact.bells !== 2 || !fact.unconfigured))
    )
      throw new Error("观测生产公口事实不完整");
    const deadline = Date.now() + 5_000;
    for (;;) {
      const records = JSON.parse(
        execute([
          "exec",
          `${project}-receiver`,
          "node",
          "-p",
          "require('node:fs').readFileSync('/tmp/receipts.json','utf8')",
        ]).stdout,
      );
      try {
        verifyReceipts(records, { project, eventIds, alerts: flags.alerts });
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((done) => setTimeout(done, 100));
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    const errors = [];
    for (const action of [
      () => cleanup("observability-fixture", "worker", true),
      () => {
        env.LYX_NODE_PROVIDERS = "";
        if (stopped) step("up", config.tag);
      },
      () => cleanup("receiver", "receiver"),
    ]) {
      try {
        action();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      failure = new AggregateError(
        [...(failure ? [failure] : []), ...errors],
        "观测演练失败或清理失败",
      );
  }
  if (failure) throw failure;
  console.log("  通过  原生HTTPS实际收件、固定协议/去敏、租约与生产告警恢复/超管铃铛（所选段）");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--receive")
    throw new Error("仅用于自有观测收件容器");
  receive(process.argv[3]);
}
