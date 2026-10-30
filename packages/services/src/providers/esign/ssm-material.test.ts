import { Agent, createServer } from "node:http";
import type {
  ClientRequest,
  IncomingHttpHeaders,
  RequestOptions,
  Server,
  ServerResponse,
} from "node:http";
import { chmod, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { gzipSync } from "node:zlib";
import { AbstractClient } from "tencentcloud-sdk-nodejs-common";
import { afterEach, expect, it } from "vitest";
import { createSsmMaterialSource } from "./ssm-material.js";
import type { SsmMaterialOptions } from "./ssm-material.js";
import { guardSsmRequest, SSM_HOST, SsmAgent } from "./ssm-agent.js";
import { createPlatformCertEsign } from "./provider.js";
import { createTestMaterial, verifyTestPdf } from "../../testing/index.js";
import { PDFDocument } from "pdf-lib";

const now = new Date("2026-10-30T03:00:00Z");
const credential = {
  TmpSecretId: "TEST_ONLY_STS_ID",
  TmpSecretKey: "TEST_ONLY_STS_KEY",
  Token: "TEST_ONLY_STS_TOKEN",
  ExpiredTime: Math.floor(now.getTime() / 1000) + 600,
};
const sources = new Set<ReturnType<typeof createSsmMaterialSource>>();
const servers = new Set<Server>();
const agents = new Set<Agent>();
const directories: string[] = [];
const failures: unknown[] = [];
const signal = () => new AbortController().signal;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
};
afterEach(async () => {
  await Promise.all([...sources].map((source) => source.close()));
  sources.clear();
  for (const agent of agents) agent.destroy();
  agents.clear();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  if (failures.length) throw failures.shift();
});
class LoopbackAgent extends Agent {
  constructor(private readonly port: number) {
    super({ keepAlive: false });
  }
  override createConnection(
    options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    expect(options.host).toBe(SSM_HOST);
    return super.createConnection({ ...options, host: "127.0.0.1", port: this.port }, callback);
  }
  addRequest(request: ClientRequest, options: RequestOptions): void {
    guardSsmRequest(request);
    const addRequest: unknown = Reflect.get(Agent.prototype, "addRequest");
    if (typeof addRequest !== "function") throw new Error("测试挂载点缺失");
    Reflect.apply(addRequest, this, [request, options]);
  }
}
async function local(
  handler: (headers: IncomingHttpHeaders, body: string, response: ServerResponse) => void,
) {
  let calls = 0;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        if (!Buffer.isBuffer(chunk)) throw new Error("字节流缺失");
        chunks.push(chunk);
      }
      calls++;
      handler(request.headers, Buffer.concat(chunks).toString("utf8"), response);
    } catch (error) {
      failures.push(error);
      response.statusCode = 500;
      response.end("test failure");
    }
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback缺失");
  const createClient: NonNullable<SsmMaterialOptions["createClient"]> = (config) => {
    expect(config.credential).toMatchObject({
      secretId: credential.TmpSecretId,
      secretKey: credential.TmpSecretKey,
    });
    expect(config.profile?.httpProfile).toMatchObject({
      endpoint: SSM_HOST,
      protocol: "https://",
      reqMethod: "POST",
      reqTimeout: 6,
    });
    expect(config.profile?.httpProfile?.agent).toBeInstanceOf(SsmAgent);
    const agent = new LoopbackAgent(address.port);
    agents.add(agent);
    return new AbstractClient(SSM_HOST, "2019-09-23", {
      ...config,
      profile: {
        ...config.profile,
        httpProfile: { ...config.profile?.httpProfile, protocol: "http://", agent },
      },
    });
  };
  return { createClient, calls: () => calls };
}
async function fresh(createClient?: SsmMaterialOptions["createClient"], timeoutMs?: number) {
  const directory = await mkdtemp(join(tmpdir(), "lyx-esign-test-"));
  directories.push(directory);
  const file = join(directory, "sts.json");
  await writeFile(file, JSON.stringify(credential), { mode: 0o600 });
  const config = {
    region: "ap-guangzhou",
    secretName: "test-only-cert",
    versionId: "test-fixed-v1",
    stsCredentialsFile: file,
  };
  const source = createSsmMaterialSource(config, {
    clock: { now: () => now },
    ...(createClient ? { createClient } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
  sources.add(source);
  return { source, file, config };
}
function json(response: ServerResponse, value: unknown) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ Response: value }));
}
const response = (SecretString: string) => ({
  SecretName: "test-only-cert",
  VersionId: "test-fixed-v1",
  RequestId: "test-only-request",
  SecretString,
});

it("真实SDK固定TC3+临时token、原子轮换每次重读、SSM材料完成真实PDF签署", async () => {
  const material = createTestMaterial();
  const payload = JSON.stringify({
    schemaVersion: 1,
    p12Base64: Buffer.from(material.material.p12).toString("base64"),
    passphrase: material.material.passphrase,
  });
  const tokens: string[] = [];
  const http = await local((headers, body, res) => {
    expect(JSON.parse(body)).toEqual({ SecretName: "test-only-cert", VersionId: "test-fixed-v1" });
    expect(headers["x-tc-action"]).toBe("GetSecretValue");
    expect(headers["x-tc-version"]).toBe("2019-09-23");
    expect(headers["x-tc-region"]).toBe("ap-guangzhou");
    expect(headers.host).toBe(SSM_HOST);
    expect(headers.authorization).toMatch(
      /^TC3-HMAC-SHA256 Credential=TEST_ONLY_STS_ID\/\d{4}-\d{2}-\d{2}\/ssm\/tc3_request, SignedHeaders=content-type;host, Signature=[a-f0-9]{64}$/,
    );
    expect(headers["accept-encoding"]).toBe("identity");
    tokens.push(String(headers["x-tc-token"]));
    json(res, response(payload));
  });
  const { source, file } = await fresh(http.createClient);
  const document = await PDFDocument.create();
  document.addPage();
  const signer = createPlatformCertEsign({
    clock: { now: () => now },
    loadMaterial: source.loadMaterial,
  });
  const sealed = await signer.provider.seal({ pdf: await document.save() });
  expect(sealed.ok).toBe(true);
  if (sealed.ok) verifyTestPdf(sealed.value.pdf, material.leaf, material.root);
  const next = `${file}.new`;
  await writeFile(next, JSON.stringify({ ...credential, Token: "TEST_ONLY_REFRESHED_TOKEN" }), {
    mode: 0o600,
  });
  await rename(next, file);
  expect((await source.loadMaterial({ signal: signal() })).p12).toEqual(material.material.p12);
  expect(tokens).toEqual([credential.Token, "TEST_ONLY_REFRESHED_TOKEN"]);
  await signer.close();
}, 30000);

it("严格文件权限/UTF8/schema/到期/大小/软链：失败不回退旧身份且无请求", async () => {
  const http = await local((_headers, _body, res) => json(res, response("{}")));
  const { source, file } = await fresh(http.createClient);
  for (const bytes of [
    Buffer.from(
      JSON.stringify({ ...credential, ExpiredTime: Math.floor(now.getTime() / 1000) + 30 }),
    ),
    Buffer.from(JSON.stringify({ ...credential, extra: true })),
    Buffer.from(JSON.stringify({ ...credential, Token: "" })),
    Buffer.from([0xff]),
    Buffer.alloc(16385, 0x61),
  ]) {
    await writeFile(file, bytes);
    await expect(source.loadMaterial({ signal: signal() })).rejects.toThrow("机构签署材料暂不可用");
  }
  await writeFile(file, JSON.stringify(credential));
  await chmod(file, 0o644);
  await expect(source.loadMaterial({ signal: signal() })).rejects.toThrow();
  await chmod(file, 0o600);
  await rename(file, `${file}.target`);
  await symlink(`${file}.target`, file);
  await expect(source.loadMaterial({ signal: signal() })).rejects.toThrow();
  expect(http.calls()).toBe(0);
});

it("响应身份/二义性/strict payload/base64/32KiB/压缩/重定向/超界受控脱敏", async () => {
  let reply = (res: ServerResponse) => json(res, response("{}"));
  const http = await local((_headers, _body, res) => reply(res));
  const { source } = await fresh(http.createClient);
  const payload = { schemaVersion: 1, p12Base64: "YQ==", passphrase: "TEST_ONLY" };
  const invalid = [
    { ...response(JSON.stringify(payload)), SecretName: "wrong" },
    { ...response(JSON.stringify(payload)), VersionId: "wrong" },
    { ...response(JSON.stringify(payload)), SecretBinary: "YQ==" },
    response(JSON.stringify({ ...payload, extra: 1 })),
    response(JSON.stringify({ ...payload, p12Base64: "YR==" })),
    response("a".repeat(32769)),
    response(JSON.stringify({ ...payload, passphrase: "" })),
  ];
  for (const value of invalid) {
    reply = (res) => json(res, value);
    await expect(source.loadMaterial({ signal: signal() })).rejects.toThrow("机构签署材料暂不可用");
  }
  reply = (res) => {
    res.setHeader("Content-Encoding", "gzip");
    res.end(gzipSync(JSON.stringify({ Response: response(JSON.stringify(payload)) })));
  };
  await expect(source.loadMaterial({ signal: signal() })).rejects.toThrow();
  reply = (res) => {
    res.statusCode = 302;
    res.setHeader("Location", `http://${SSM_HOST}/secret`);
    res.end();
  };
  const before = http.calls();
  await expect(source.loadMaterial({ signal: signal() })).rejects.toThrow();
  expect(http.calls()).toBe(before + 1);
  reply = (res) => res.end("a".repeat(262145));
  await expect(source.loadMaterial({ signal: signal() })).rejects.toThrow();
  const padded = JSON.stringify(payload).padEnd(32768, " ");
  reply = (res) => json(res, response(padded));
  expect((await source.loadMaterial({ signal: signal() })).p12).toEqual(Buffer.from("a"));
});

it("真实socket取消/超时/close等待实际请求结束，实例互不关闭", async () => {
  const entered = deferred();
  const disconnected = deferred();
  const http = await local((_headers, _body, res) => {
    res.on("close", () => disconnected.resolve());
    entered.resolve();
  });
  const first = await fresh(http.createClient, 2000);
  const controller = new AbortController();
  const work = first.source.loadMaterial({ signal: controller.signal });
  await entered.promise;
  controller.abort();
  await expect(work).rejects.toThrow();
  await disconnected.promise;
  await first.source.close();
  await expect(first.source.loadMaterial({ signal: signal() })).rejects.toThrow();
  const timeout = await fresh(http.createClient, 80);
  await expect(timeout.source.loadMaterial({ signal: signal() })).rejects.toThrow();
  const active = await fresh(http.createClient, 2000);
  const waiting = active.source.loadMaterial({ signal: signal() });
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  const closing = active.source.close();
  await expect(waiting).rejects.toThrow();
  await closing;
  const liveHttp = await local((_headers, _body, res) =>
    json(
      res,
      response(JSON.stringify({ schemaVersion: 1, p12Base64: "YQ==", passphrase: "TEST_ONLY" })),
    ),
  );
  const live = await fresh(liveHttp.createClient);
  expect((await live.source.loadMaterial({ signal: signal() })).p12).toEqual(Buffer.from("a"));
});
