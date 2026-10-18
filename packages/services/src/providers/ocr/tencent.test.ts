import { Agent, createServer } from "node:http";
import type {
  ClientRequest,
  IncomingHttpHeaders,
  RequestOptions,
  Server,
  ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { ocr } from "tencentcloud-sdk-nodejs-ocr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviders, ProviderConfigError } from "../index.js";
import { guardOcrRequest, OCR_HOST, OcrAgent } from "./agent.js";
import { createTencentOcr } from "./tencent.js";
import { parseBusinessLicense } from "./parse.js";
import { parseBankReceipt } from "./receipt.js";

// 所有凭据、证照与URL均为公开虚构标记；真实固定SDK只请求本测试的loopback服务器。
const config = {
  secretId: "AKID_PUBLIC_OCR",
  secretKey: "PUBLIC_OCR_SECRET",
  region: "ap-guangzhou",
};
const imageUrl = "https://example.invalid/license.jpg?signature=PRIVATE_URL_MARKER";
const license = {
  RequestId: "public-request-id",
  Name: "虚构测试有限公司",
  RegNum: "91000000FAKE000001",
  Person: "测试负责人",
  Address: "虚构市测试路1号",
  Type: "有限责任公司（自然人独资）",
  Period: "2024年02月29日至2034年02月28日",
  RecognizeWarnCode: [-9102, -9104],
  RecognizeWarnMsg: ["WARN_COPY_CARD", "WARN_RESHOOT_CARD"],
};
const servers = new Set<Server>();
const agents = new Set<Agent>();
const owned = new Set<ReturnType<typeof createTencentOcr>>();
const handlerFailures: unknown[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function json(response: ServerResponse, value: unknown) {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ Response: value }));
}
class LoopbackAgent extends Agent {
  constructor(private readonly port: number) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void,
  ): Duplex | null | undefined {
    expect(options.host).toBe(OCR_HOST);
    return super.createConnection({ ...options, host: "127.0.0.1", port: this.port }, callback);
  }

  // 复用生产的真实response首监听，只有目的地/TLS在私有测试边界换成loopback。
  addRequest(request: ClientRequest, options: RequestOptions): void {
    guardOcrRequest(request);
    const addRequest: unknown = Reflect.get(Agent.prototype, "addRequest");
    if (typeof addRequest !== "function") throw new Error("测试Agent挂载点缺失");
    Reflect.apply(addRequest, this, [request, options]);
  }
}
async function local(
  handler: (
    input: { headers: IncomingHttpHeaders; body: string },
    response: ServerResponse,
  ) => void,
) {
  let calls = 0;
  const server = createServer(async (request, response) => {
    try {
      const parts: Buffer[] = [];
      for await (const part of request) {
        if (!Buffer.isBuffer(part)) throw new Error("测试请求未使用字节流");
        parts.push(part);
      }
      calls += 1;
      handler({ headers: request.headers, body: Buffer.concat(parts).toString("utf8") }, response);
    } catch (error) {
      // 原断言通过afterEach受控回报；结束HTTP使客户端立即退出，不留异步未处理拒绝或等超时。
      handlerFailures.push(error);
      response.statusCode = 500;
      response.end("测试HTTP断言失败");
    }
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务器未就绪");
  const createClient: NonNullable<Parameters<typeof createTencentOcr>[1]>["createClient"] = (
    settings,
  ) => {
    expect(settings.credential).toEqual({ secretId: config.secretId, secretKey: config.secretKey });
    expect(settings.profile?.signMethod).toBe("TC3-HMAC-SHA256");
    expect(settings.profile?.httpProfile).toMatchObject({
      endpoint: OCR_HOST,
      protocol: "https://",
      reqMethod: "POST",
      reqTimeout: 6,
    });
    expect(settings.profile?.httpProfile?.agent).toBeInstanceOf(OcrAgent);
    const agent = new LoopbackAgent(address.port);
    agents.add(agent);
    return new ocr.v20181119.Client({
      ...settings,
      profile: {
        ...settings.profile,
        httpProfile: {
          ...settings.profile?.httpProfile,
          protocol: "http://",
          // SDK由endpoint推导service：保持ocr，只有Agent连接目的地换loopback。
          endpoint: OCR_HOST,
          agent,
        },
      },
    });
  };
  function driver() {
    const instance = createTencentOcr(config, { createClient });
    owned.add(instance);
    return instance;
  }
  return { calls: () => calls, createClient, driver };
}
afterEach(async () => {
  await Promise.all([...owned].map((driver) => driver.close()));
  owned.clear();
  for (const agent of agents) agent.destroy();
  agents.clear();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
  vi.useRealTimers();
  const failure = handlerFailures[0];
  handlerFailures.length = 0;
  if (failure !== undefined) throw failure;
});

describe("营业执照官方SDK：真实loopback协议", () => {
  it("固定签名协议、真实字段和unknown边界；压缩及原始越界在解析前拒绝，失败脱敏且不外呼附加能力", async () => {
    let reply = (response: ServerResponse) => json(response, license);
    const http = await local(({ body, headers }, response) => {
      expect(JSON.parse(body)).toEqual({
        ImageUrl: imageUrl,
        EnableCopyWarn: true,
        EnablePeriodComplete: true,
        EnableBusinessCertificate: false,
      });
      expect(headers["x-tc-action"]).toBe("BizLicenseOCR");
      expect(headers["x-tc-version"]).toBe("2018-11-19");
      expect(headers["x-tc-region"]).toBe(config.region);
      expect(headers.host).toBe(OCR_HOST);
      expect(headers.authorization).toMatch(
        /^TC3-HMAC-SHA256 Credential=AKID_PUBLIC_OCR\/\d{4}-\d{2}-\d{2}\/ocr\/tc3_request, SignedHeaders=content-type;host, Signature=[a-f0-9]{64}$/,
      );
      expect(headers["accept-encoding"]).toBe("identity");
      reply(response);
    });
    const driver = http.driver();
    expect(http.calls()).toBe(0);
    expect(await driver.provider.recognizeBusinessLicense({ imageUrl })).toEqual({
      ok: true,
      value: {
        name: license.Name,
        uscc: license.RegNum,
        principal: license.Person,
        address: license.Address,
        subjectType: "enterprise",
        principalRole: "legal_rep",
        raw: JSON.stringify(license),
        subjectTypeText: license.Type,
        periodText: license.Period,
        validFrom: "2024-02-29",
        validTo: "2034-02-28",
        warnings: ["WARN_COPY_CARD", "WARN_RESHOOT_CARD"],
      },
    });
    for (const [type, period, expected] of [
      ["个体工商户", "1998年11月至长期", { subjectType: "individual", validTo: "long_term" }],
      ["有限责任公司分公司", "长期", { subjectType: "branch", validTo: "long_term" }],
      ["未知新型主体", "尚未识别", { subjectType: "unknown" }],
    ] as const) {
      reply = (response) => json(response, { ...license, Type: type, Period: period });
      const result = await driver.provider.recognizeBusinessLicense({ imageUrl });
      expect(result).toMatchObject({
        ok: true,
        value: { ...expected, subjectTypeText: type, periodText: period },
      });
      if (result.ok) {
        expect(result.value.validFrom).toBeUndefined();
        if (expected.subjectType === "unknown") expect(result.value.validTo).toBeUndefined();
        expect(result.value).not.toHaveProperty("confidence");
      }
    }
    const partial = {
      RequestId: license.RequestId,
      Name: "仅识别名称",
      Type: "未知",
      Period: "2023年02月29日至2030年01月01日",
      RecognizeWarnCode: [-9999],
      Raw: "PRIVATE_RESPONSE_MARKER",
    };
    reply = (response) => json(response, partial);
    expect(await driver.provider.recognizeBusinessLicense({ imageUrl })).toEqual({
      ok: true,
      value: {
        name: "仅识别名称",
        uscc: "",
        principal: "",
        subjectType: "unknown",
        subjectTypeText: "未知",
        periodText: "2023年02月29日至2030年01月01日",
        warnings: ["PROVIDER_WARNING_-9999"],
        raw: JSON.stringify(partial),
      },
    });
    const bigint = parseBusinessLicense({
      ...license,
      RecognizeWarnCode: [-9102n, 9007199254740993n],
      OriginalInteger: 18446744073709551615n,
    });
    expect(bigint?.warnings).toEqual([
      "WARN_COPY_CARD",
      "PROVIDER_WARNING_9007199254740993",
      "WARN_RESHOOT_CARD",
    ]);
    expect(JSON.parse(bigint!.raw!)).toMatchObject({
      RecognizeWarnCode: ["-9102", "9007199254740993"],
      OriginalInteger: "18446744073709551615",
    });
    for (const [code, reason] of [
      ["FailedOperation.NoBizLicense", "rejected"],
      ["AuthFailure.SecretIdNotFound", "unavailable"],
    ] as const) {
      reply = (response) =>
        json(response, {
          RequestId: license.RequestId,
          Error: { Code: code, Message: `${imageUrl}/${config.secretKey}/PRIVATE_RESPONSE_MARKER` },
        });
      const result = await driver.provider.recognizeBusinessLicense({ imageUrl });
      expect(result).toMatchObject({ ok: false, reason });
      for (const marker of [imageUrl, config.secretId, config.secretKey, "PRIVATE_RESPONSE_MARKER"])
        expect(JSON.stringify(result)).not.toContain(marker);
    }
    reply = (response) => json(response, { Name: "缺少真实RequestId" });
    expect(await driver.provider.recognizeBusinessLicense({ imageUrl })).toMatchObject({
      ok: false,
      reason: "rejected",
    });

    // 超过1MiB的合法JSON：其压缩体远小于上限，不能先解压再依赖Zod剥弃Padding。
    const huge = Buffer.from(
      JSON.stringify({ Response: { ...license, Padding: "X".repeat(2 * 1024 * 1024) } }),
    );
    for (const [encoding, body] of [
      ["gzip", gzipSync(huge)],
      ["br", brotliCompressSync(huge)],
      ["identity", huge],
    ] as const) {
      if (encoding !== "identity") expect(body.length).toBeLessThan(1024 * 1024);
      reply = (response) => {
        response.setHeader("Content-Encoding", encoding);
        response.end(body);
      };
      expect(await driver.provider.recognizeBusinessLicense({ imageUrl })).toEqual({
        ok: false,
        reason: "unavailable",
        message: "证照识别服务暂不可用",
      });
    }
    const before = http.calls();
    for (const invalid of [
      "http://example.invalid/license.jpg",
      "https://u:p@example.invalid/license.jpg",
      `${imageUrl}#fragment`,
      "x".repeat(8193),
    ])
      expect(await driver.provider.recognizeBusinessLicense({ imageUrl: invalid })).toMatchObject({
        ok: false,
        reason: "rejected",
      });
    const abort = new AbortController();
    abort.abort();
    expect(
      await driver.provider.recognizeBusinessLicense({ imageUrl, signal: abort.signal }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    expect(
      await driver.provider.extractLicenseFields({ fileUrl: imageUrl, fieldNames: ["name"] }),
    ).toMatchObject({ ok: false, reason: "unsupported" });
    expect(http.calls()).toBe(before);
    const targetGuard = new OcrAgent();
    try {
      for (const options of [
        { host: "other.invalid" },
        { host: OCR_HOST, port: 8443 },
        { host: OCR_HOST, servername: "other.invalid" },
      ])
        expect(() => targetGuard.createConnection(options)).toThrow("证照识别请求目标不合法");
    } finally {
      targetGuard.destroy();
    }
  });

  it("真实底层六秒取消与正文中取消；关闭排空且隔离实例，显式配置/缺配工厂及生命周期保持", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let arrived = deferred<void>(),
      disconnected = deferred<void>();
    let partial = false;
    const http = await local((_input, response) => {
      const current = disconnected;
      response.once("close", () => current.resolve());
      if (partial) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.write('{"Response":');
      }
      arrived.resolve();
    });
    const first = http.driver();
    let settled = false;
    const timeout = first.provider.recognizeBusinessLicense({ imageUrl }).then((result) => {
      settled = true;
      return result;
    });
    await arrived.promise;
    await vi.advanceTimersByTimeAsync(5999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await timeout).toEqual({
      ok: false,
      reason: "unavailable",
      message: "证照识别调用超时",
    });
    await disconnected.promise;

    arrived = deferred<void>();
    disconnected = deferred<void>();
    partial = true;
    const abort = new AbortController();
    const bodyRead = first.provider.recognizeBusinessLicense({ imageUrl, signal: abort.signal });
    await arrived.promise;
    abort.abort();
    expect(await bodyRead).toMatchObject({ ok: false, reason: "unavailable" });
    await disconnected.promise;

    arrived = deferred<void>();
    disconnected = deferred<void>();
    partial = false;
    const inFlight = first.provider.recognizeBusinessLicense({ imageUrl });
    await arrived.promise;
    const close = first.close();
    expect(first.close()).toBe(close);
    expect(await inFlight).toMatchObject({ ok: false, reason: "unavailable" });
    await close;
    await disconnected.promise;
    const before = http.calls();
    expect(await first.provider.recognizeBusinessLicense({ imageUrl })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(http.calls()).toBe(before);

    arrived = deferred<void>();
    disconnected = deferred<void>();
    const second = http.driver(),
      secondAbort = new AbortController();
    let secondSettled = false;
    const independent = second.provider
      .recognizeBusinessLicense({ imageUrl, signal: secondAbort.signal })
      .then((result) => {
        secondSettled = true;
        return result;
      });
    await arrived.promise;
    await first.close();
    expect(secondSettled).toBe(false);
    secondAbort.abort();
    expect(await independent).toMatchObject({ ok: false, reason: "unavailable" });
    await disconnected.promise;

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const defaultProviders = createProviders({ appEnv: "test", logger });
    expect(defaultProviders.ocr).toMatchObject({ status: "unconfigured", configured: false });
    expect(await defaultProviders.ocr.recognizeBusinessLicense({ imageUrl })).toMatchObject({
      ok: false,
      reason: "unconfigured",
    });
    expect(() => createProviders({ appEnv: "test", logger, settings: { ocr: config } })).toThrow(
      ProviderConfigError,
    );
    expect(() =>
      createProviders({ appEnv: "test", logger, ocr: { registerClose: vi.fn() } }),
    ).toThrow(ProviderConfigError);
    const closers: (() => Promise<void>)[] = [];
    const configured = createProviders({
      appEnv: "test",
      logger,
      settings: { ocr: config },
      ocr: { createClient: http.createClient, registerClose: (close) => closers.push(close) },
    });
    expect(configured.ocr).toMatchObject({ status: "tencent", configured: true });
    expect(closers).toHaveLength(1);
    const closed = closers[0]!();
    expect(closers[0]!()).toBe(closed);
    await closed;
    expect(await configured.ocr.recognizeBusinessLicense({ imageUrl })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(http.calls()).toBe(before + 1);
    for (const method of [logger.info, logger.warn, logger.error])
      for (const marker of [imageUrl, config.secretId, config.secretKey])
        expect(JSON.stringify(method.mock.calls)).not.toContain(marker);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("银行回单官方SDK与保守解析", () => {
  it("BankSlipOCR固定首页协议；金额/时刻独立期望、未知键/冲突不猜、取消零附加IO", async () => {
    const result = {
      RequestId: "receipt-public",
      BankSlipInfos: [
        { Name: "付款账号", Value: "1234567890123456" },
        { Name: "交易金额", Value: "1,234.56" },
        { Name: "币种", Value: "人民币" },
        { Name: "日期", Value: "2026-10-16T12:34:56+08:00" },
        { Name: "未核户名", Value: "不能猜成付款户名" },
      ],
    };
    const http = await local(({ headers, body }, response) => {
      expect(headers["x-tc-action"]).toBe("BankSlipOCR");
      expect(headers["x-tc-version"]).toBe("2018-11-19");
      expect(headers.host).toBe(OCR_HOST);
      expect(headers.authorization).toMatch(/^TC3-HMAC-SHA256 /);
      expect(JSON.parse(body)).toEqual({ ImageUrl: imageUrl, IsPdf: true, PdfPageNumber: 1 });
      json(response, result);
    });
    const driver = http.driver();
    expect(http.calls()).toBe(0);
    expect(await driver.provider.recognizeBankReceipt({ fileUrl: imageUrl })).toMatchObject({
      ok: true,
      value: {
        payerName: null,
        payeeName: null,
        remark: null,
        payerAccount: "1234567890123456",
        amountFen: 123456,
        tradedAt: "2026-10-16T04:34:56.000Z",
        warnings: ["MISSING_PAYER_NAME", "MISSING_PAYEE_NAME", "MISSING_REMARK"],
      },
    });
    const variants = [
      [
        { Name: "交易金额", Value: "1.00" },
        { Name: "交易金额", Value: "2.00" },
        { Name: "币种", Value: "CNY" },
      ],
      [
        { Name: "交易金额", Value: "1.234" },
        { Name: "币种", Value: "CNY" },
      ],
      [
        { Name: "交易金额", Value: "123.00" },
        { Name: "币种", Value: "USD" },
      ],
      [{ Name: "交易金额", Value: "123.00" }],
    ];
    for (const fields of variants)
      expect(
        parseBankReceipt({
          RequestId: "public",
          BankSlipInfos: [result.BankSlipInfos[0], ...fields],
        })?.amountFen,
      ).toBeNull();
    for (const date of [
      "2026年10月16日",
      "2026年10月16日 12:34:56",
      "2026-02-30T12:00:00Z",
      "2026-10-16T24:00:00Z",
    ])
      expect(
        parseBankReceipt({
          RequestId: "public",
          BankSlipInfos: [result.BankSlipInfos[0], { Name: "日期", Value: date }],
        })?.tradedAt,
      ).toBeNull();
    expect(
      parseBankReceipt({
        RequestId: "public",
        BankSlipInfos: [{ Name: "金额别名", Value: "1.00" }],
      }),
    ).toBeUndefined();
    const controller = new AbortController();
    controller.abort();
    expect(
      await driver.provider.recognizeBankReceipt({ fileUrl: imageUrl, signal: controller.signal }),
    ).toMatchObject({ ok: false, reason: "rejected" });
    await driver.close();
    expect(await driver.provider.recognizeBankReceipt({ fileUrl: imageUrl })).toMatchObject({
      ok: false,
      reason: "unavailable",
    });
    expect(http.calls()).toBe(1);
  });
});
