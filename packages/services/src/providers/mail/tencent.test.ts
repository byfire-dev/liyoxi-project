import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { EnvError, loadEnv } from "../../kernel/env.js";
import { createProviders, ProviderConfigError } from "../index.js";
import { MAIL_HOST, signMail } from "./sign.js";
import { createTencentMail } from "./tencent.js";

const config = {
  secretId: "AKIDEXAMPLE",
  secretKey: "SECRETKEYEXAMPLE",
  region: "ap-guangzhou" as const,
  fromAddress: "noreply@example.invalid",
  templateId: 7,
};
const now = () => new Date(1551111465000);
const input = { to: "to@example.invalid", subject: "invoice", text: "Invoice ready" };
const logger = { info() {}, warn() {}, error() {} };

it("SES公开签名向量、真实本地HTTP协议、FILE/工厂未配、拒绝脱敏与取消关闭", async () => {
  const payload =
    '{"FromEmailAddress":"noreply@example.invalid","Destination":["to@example.invalid"],"Subject":"invoice","Template":{"TemplateID":7,"TemplateData":"{\\"text\\":\\"Invoice ready\\"}"}}';
  // 独立Python hashlib/hmac按官方TC3规则算出；不是调用被测signMail生成期望。
  expect(signMail({ ...config, timestamp: 1551111465, payload })).toBe(
    "TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2019-02-25/ses/tc3_request, SignedHeaders=content-type;host, Signature=46d4a17a0a9bdb5a343effb00aa436171d4fd15cc0f755f55c5612c88350d7b4",
  );
  const home = mkdtempSync(join(tmpdir(), "lyx-mail-public-"));
  const closers: Array<() => Promise<void>> = [];
  const captured: { headers: IncomingHttpHeaders; body: string }[] = [];
  const handlerErrors: unknown[] = [];
  let mode: "ok" | "reject" | "invalid" | "timeout" = "ok";
  let onReceipt: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      captured.push({ headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
      onReceipt?.();
      if (mode === "timeout") return;
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          Response:
            mode === "ok"
              ? { MessageId: "ses-public-1" }
              : mode === "reject"
                ? {
                    Error: {
                      Code: "FailedOperation.InvalidTemplateID",
                      Message: "PRIVATE_BODY recipient@example.invalid SECRETKEYEXAMPLE",
                    },
                  }
                : { MessageId: "recipient@example.invalid", Secret: "PRIVATE_BODY" },
        }),
      );
    } catch (error) {
      handlerErrors.push(error);
      response.destroy();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试收件端口缺失");
  // 显式私有运输边界：断言生产固定目标后，用原生fetch发送实际HTTP字节到本轮loopback。
  const transport: typeof fetch = async (url, init) => {
    expect(String(url)).toBe(`https://${MAIL_HOST}/`);
    expect(init?.redirect).toBe("error");
    expect(new Headers(init?.headers).get("host")).toBe(MAIL_HOST);
    return fetch(`http://127.0.0.1:${address.port}/`, init);
  };
  try {
    const source = {
      APP_ENV: "test",
      DATABASE_URL: "postgresql://liyoxi:lyx-local-dev@localhost:5442/lyx_test_services_mail_1",
      REDIS_URL: "redis://localhost:6389/0",
    };
    expect(loadEnv(source).MAIL_TENCENT).toBeUndefined();
    const file = join(home, "mail.json");
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    const env = loadEnv({ ...source, MAIL_TENCENT_FILE: file });
    expect(env.MAIL_TENCENT).toEqual(config);
    expect(() => loadEnv({ ...source, MAIL_TENCENT: "PRIVATE_BODY" })).toThrow();
    writeFileSync(
      file,
      JSON.stringify({ ...config, region: "ap-shanghai", secretKey: "PRIVATE_BODY" }),
    );
    let invalidConfig: unknown;
    try {
      loadEnv({ ...source, MAIL_TENCENT_FILE: file });
    } catch (error) {
      invalidConfig = error;
    }
    expect(invalidConfig).toBeInstanceOf(EnvError);
    expect(String(invalidConfig)).not.toContain("PRIVATE_BODY");
    expect(String(invalidConfig)).not.toContain(file);
    const off = createProviders({ appEnv: "test", logger });
    expect(await off.mail.send(input)).toMatchObject({
      ok: false,
      reason: "unconfigured",
      notification: { acceptance: "not_accepted", code: "unconfigured" },
    });
    expect(captured).toHaveLength(0);
    expect(() => createProviders({ appEnv: "test", logger, settings: { mail: config } })).toThrow(
      ProviderConfigError,
    );
    const providers = createProviders({
      appEnv: "test",
      logger,
      settings: { mail: config },
      mail: { now, fetch: transport, registerClose: (close) => closers.push(close) },
    });
    expect(providers.mail.configured).toBe(true);
    const pdf = new Uint8Array([37, 80, 68, 70]);
    expect(
      await providers.mail.send({
        ...input,
        attachments: [{ filename: "invoice.pdf", contentType: "application/pdf", content: pdf }],
      }),
    ).toEqual({ ok: true, value: { messageId: "ses-public-1" }, providerMsgId: "ses-public-1" });
    const sent = captured[0]!;
    expect(sent.headers.host).toBe(`127.0.0.1:${address.port}`);
    expect(sent.headers["x-tc-action"]).toBe("SendEmail");
    expect(sent.headers["x-tc-version"]).toBe("2020-10-02");
    expect(sent.headers["x-tc-region"]).toBe("ap-guangzhou");
    expect(JSON.parse(sent.body)).toEqual({
      FromEmailAddress: config.fromAddress,
      Destination: [input.to],
      Subject: input.subject,
      Template: { TemplateID: 7, TemplateData: JSON.stringify({ text: input.text }) },
      Attachments: [{ FileName: "invoice.pdf", Content: Buffer.from(pdf).toString("base64") }],
    });
    const calls = captured.length;
    expect(
      await providers.mail.send({
        ...input,
        attachments: [{ filename: "bad name.pdf", contentType: "application/pdf", content: pdf }],
      }),
    ).toMatchObject({
      ok: false,
      notification: { acceptance: "not_accepted", code: "field_mismatch" },
    });
    expect(
      await providers.mail.send({
        ...input,
        attachments: [
          {
            filename: "invoice.pdf",
            contentType: "application/pdf",
            content: new Uint8Array(4 * 1024 * 1024 + 1),
          },
        ],
      }),
    ).toMatchObject({ ok: false, notification: { acceptance: "not_accepted" } });
    expect(
      await providers.mail.send({ ...input, text: "\\".repeat(4 * 1024 * 1024) }),
    ).toMatchObject({ ok: false, notification: { acceptance: "not_accepted" } });
    expect(captured).toHaveLength(calls);
    mode = "reject";
    const rejected = await providers.mail.send(input);
    expect(rejected).toMatchObject({
      ok: false,
      reason: "rejected",
      notification: { acceptance: "not_accepted", code: "provider_rejected" },
    });
    expect(JSON.stringify(rejected)).not.toMatch(/PRIVATE_BODY|recipient@|SECRETKEYEXAMPLE/);
    mode = "invalid";
    expect(await providers.mail.send(input)).toMatchObject({
      ok: false,
      notification: { acceptance: "unknown", code: "unknown_outcome" },
    });
    mode = "timeout";
    const bounded = createTencentMail(config, { now, fetch: transport, timeoutMs: 100 });
    closers.push(bounded.close);
    expect(await bounded.provider.send(input)).toMatchObject({
      ok: false,
      notification: { acceptance: "unknown", code: "unknown_outcome" },
    });
    const controller = new AbortController();
    controller.abort();
    const beforeAbort = captured.length;
    expect(await bounded.provider.send({ ...input, signal: controller.signal })).toMatchObject({
      ok: false,
      notification: { acceptance: "not_accepted", code: "aborted" },
    });
    expect(captured).toHaveLength(beforeAbort);
    await bounded.close();
    expect(await bounded.provider.send(input)).toMatchObject({
      ok: false,
      notification: { acceptance: "not_accepted" },
    });
    const received = new Promise<void>((resolve) => {
      onReceipt = resolve;
    });
    const inflight = providers.mail.send(input);
    await received;
    await closers[0]!();
    expect(await inflight).toMatchObject({ ok: false, notification: { acceptance: "unknown" } });
    expect(await providers.mail.send(input)).toMatchObject({
      ok: false,
      notification: { acceptance: "not_accepted" },
    });
    expect(captured).toHaveLength(calls + 4); // 成功、拒绝、坏响应、超时、在途close各一次；无自动重试。
    expect(handlerErrors).toEqual([]);
  } finally {
    await Promise.allSettled(closers.map((close) => close()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(home, { recursive: true, force: true });
  }
}, 10_000);
