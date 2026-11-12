import { describe, expect, it, vi } from "vitest";
import { createProbe } from "../src/app.ts";
import { createFakeProvider, createRealProvider, uploadPolicy } from "../src/provider.ts";
import { loadConfig, secretKeys, type Secrets } from "../src/config.ts";
import { Redactor, type Attempt, type RecordRow } from "../src/records.ts";
import { summarize } from "../src/report.ts";

const fakeConfig = {
  mode: "fake" as const,
  port: 4310,
  portalOrigin: "https://portal.example.invalid",
};
const secrets: Secrets = {
  WECHAT_APP_ID: "wx0000000000000000",
  WECHAT_APP_SECRET: "test-app-secret",
  COS_SECRET_ID: "test-secret-id",
  COS_SECRET_KEY: "test-secret-key",
  COS_BUCKET: "test-bucket-123456",
  COS_REGION: "ap-guangzhou",
  COS_TEST_PREFIX: "x01/test/",
};
const attempt: Attempt = {
  probeMode: "fake",
  item: "V19",
  scenario: "quick",
  device: "test-device",
  system: "test-os",
  baseLibrary: "2.32.3",
  network: "wifi",
  sizeBytes: 0,
  durationMs: 100,
  result: "success",
  errorCode: "",
};
type TestResponse = {
  sessionToken: string;
  error: string;
  accountId: string;
  phoneMasked: string;
  status: string;
  expiresAt: string;
  size: number;
  timeoutMs: number;
  qrDataUrl: string;
  qrUrl: string;
  shortCode: string;
  ticketId: string;
  pairDigits: string;
  pollSecret: string;
  candidates: string[];
  fileId: string;
  key: string;
  Key: string;
  ExpiredTime: number;
  StartTime: number;
  verified: boolean;
};
function setup() {
  const provider = createFakeProvider();
  const rows: Attempt[] = [];
  let clock = 1_800_000_000_000;
  const app = createProbe(
    fakeConfig,
    provider,
    (row) => rows.push(row),
    new Redactor(),
    () => clock,
  );
  const call = async (
    method: string,
    route: string,
    body?: unknown,
    token?: string,
    headers: Record<string, string> = {},
  ) => {
    const response = await app.request(`/api/probe${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: (await response.json()) as TestResponse };
  };
  const login = async (code = "one") =>
    (await call("POST", "/login", { code })).data.sessionToken as string;
  return {
    app,
    call,
    login,
    provider,
    rows,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
describe("four fake endpoint groups", () => {
  it("login and phone link a second WeChat to the same account only via realtime", async () => {
    const s = setup();
    const first = await s.login();
    const second = await s.login("two");
    const one = await s.call("POST", "/phone", { code: "phone", kind: "quick" }, first);
    expect(one.data.phoneMasked).toBe("138****1111");
    expect(
      (await s.call("POST", "/phone", { code: "phone", kind: "quick" }, second)).data.error,
    ).toBe("REALTIME_REQUIRED");
    const two = await s.call("POST", "/phone", { code: "phone", kind: "realtime" }, second);
    expect(two.data).toMatchObject({ accountId: one.data.accountId, linkedWechatCount: 2 });
    expect(
      (await s.call("POST", "/phone", { code: "second-phone", kind: "quick" }, first)).data.error,
    ).toBe("REALTIME_REQUIRED");
  });
  it("renders desktop QR, keeps poll secret private, supports scan/short code and expires", async () => {
    const s = setup();
    const token = await s.login();
    await s.call("POST", "/phone", { code: "phone", kind: "quick" }, token);
    expect((await s.app.request("/desktop")).status).toBe(200);
    const created = await s.call("POST", "/scan/tickets", undefined, undefined, {
      "X-Probe-Desktop": "1",
    });
    const t = created.data;
    expect(t.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(t.qrUrl).toMatch(/\/a\?t=[\w-]{22}$/);
    expect(t.shortCode).toHaveLength(8);
    expect((await s.call("GET", `/scan/tickets/${t.ticketId}`)).status).toBe(404);
    const lookup = (
      await s.call(
        "GET",
        `/scan/lookup?token=${new URL(t.qrUrl).searchParams.get("t")}`,
        undefined,
        token,
      )
    ).data;
    expect(lookup.candidates).toContain(t.pairDigits);
    expect(lookup).not.toHaveProperty("pairDigits");
    expect(lookup).not.toHaveProperty("pollSecret");
    expect(
      (await s.call("GET", `/scan/lookup?shortCode=${t.shortCode}`, undefined, token)).data
        .ticketId,
    ).toBe(t.ticketId);
    expect(
      (await s.call("POST", "/scan/confirm", { ticketId: t.ticketId, digit: t.pairDigits }, token))
        .data.status,
    ).toBe("confirmed");
    expect(
      (
        await s.call("GET", `/scan/tickets/${t.ticketId}`, undefined, undefined, {
          "X-Poll-Secret": t.pollSecret,
        })
      ).data.status,
    ).toBe("confirmed");
    s.advance(120_000);
    expect(
      (
        await s.call("GET", `/scan/tickets/${t.ticketId}`, undefined, undefined, {
          "X-Poll-Secret": t.pollSecret,
        })
      ).data.status,
    ).toBe("expired");
  });
  it("rejects wrong pairing after three guesses", async () => {
    const s = setup();
    const token = await s.login();
    await s.call("POST", "/phone", { code: "phone", kind: "quick" }, token);
    const t = (
      await s.call("POST", "/scan/tickets", undefined, undefined, { "X-Probe-Desktop": "1" })
    ).data;
    const wrong = t.pairDigits === "00" ? "01" : "00";
    for (let n = 0; n < 3; n++)
      expect(
        (await s.call("POST", "/scan/confirm", { ticketId: t.ticketId, digit: wrong }, token)).data
          .error,
      ).toBe("PAIR_MISMATCH");
    expect(
      (await s.call("POST", "/scan/confirm", { ticketId: t.ticketId, digit: t.pairDigits }, token))
        .data.error,
    ).toBe("TICKET_CLOSED");
  });
  it("resumes identical client token, scopes credentials and checks actual remote size", async () => {
    const s = setup();
    const token = await s.login();
    const other = await s.login("other");
    const body = { clientToken: "a".repeat(32), size: 150_000_000 };
    const one = (await s.call("POST", "/uploads", body, token)).data;
    expect((await s.call("POST", "/uploads", body, token)).data).toEqual(one);
    expect((await s.call("POST", "/uploads", { ...body, size: 300_000_000 }, token)).status).toBe(
      409,
    );
    expect((await s.call("POST", `/uploads/${one.fileId}/credentials`, {}, other)).status).toBe(
      404,
    );
    const credential = (await s.call("POST", `/uploads/${one.fileId}/credentials`, {}, token)).data;
    expect(credential.Key).toBe(one.key);
    expect(credential.ExpiredTime - credential.StartTime).toBe(1800);
    expect(
      (await s.call("POST", `/uploads/${one.fileId}/confirm`, { size: body.size }, token)).data
        .verified,
    ).toBe(true);
    s.provider.objects.set(one.key, 1);
    expect(
      (await s.call("POST", `/uploads/${one.fileId}/confirm`, { size: body.size }, token)).data
        .error,
    ).toBe("SIZE_MISMATCH");
    const policy = uploadPolicy(secrets, one.key);
    const serialized = JSON.stringify(policy);
    expect(serialized).toContain(`incoming/${one.fileId}/*`);
    expect(serialized).toContain("ListParts");
    expect(serialized).toContain("ListMultipartUploads");
    expect(serialized).not.toContain("GetObject");
    expect(policy.statement[1]).toMatchObject({
      action: ["name/cos:ListMultipartUploads"],
      condition: { string_equal: { "cos:prefix": [one.key] } },
    });
    expect(() => uploadPolicy(secrets, "../elsewhere")).toThrow("OBJECT_SCOPE");
  });
  it("signs supported download sizes/modes for 15 minutes, records attempts once", async () => {
    const s = setup();
    const token = await s.login();
    for (const mode of ["temp", "user_dir"])
      for (const mb of [30, 50, 60, 100, 150, 200]) {
        const r = await s.call("GET", `/downloads/${mb}?mode=${mode}`, undefined, token);
        expect(r.data.size).toBe(mb * 1_000_000);
        expect(r.data.timeoutMs).toBe(Math.min(900_000, Math.max(120_000, mb * 10_000)));
        expect(new Date(r.data.expiresAt).getTime()).toBe(1_800_000_900_000);
      }
    expect((await s.call("GET", "/downloads/300", undefined, token)).status).toBe(400);
    for (const item of ["V19", "V8", "V3", "V7"])
      await s.call("POST", "/attempts", { ...attempt, item, attemptId: item }, token);
    await s.call("POST", "/attempts", { ...attempt, attemptId: "V19" }, token);
    expect(s.rows).toHaveLength(4);
  });
});
describe("secrets guards", () => {
  it("fake never reads any credential file; missing real file prints only its key", () => {
    const read = vi.fn(() => {
      throw new Error("/private/path secret-value");
    });
    const mode = vi.fn(() => 0o600);
    expect(
      loadConfig({ PROBE_MODE: "fake", PROBE_SECRETS_FILE: "/private/path" }, { read, mode }).mode,
    ).toBe("fake");
    expect(read).not.toHaveBeenCalled();
    expect(mode).not.toHaveBeenCalled();
    expect(() =>
      loadConfig({ PROBE_MODE: "real", PROBE_SECRETS_FILE: "/private/path" }, { read, mode }),
    ).toThrow(/^PROBE_SECRETS_FILE$/);
    expect(() =>
      loadConfig(
        { PROBE_MODE: "real", WECHAT_APP_ID_FILE: "/private/key" },
        { read: () => secrets.WECHAT_APP_ID, mode },
      ),
    ).toThrow(secretKeys.slice(1).join(","));
    expect(() =>
      loadConfig(
        { PROBE_MODE: "real", PROBE_SECRETS_FILE: "/private/path" },
        { read: () => "", mode: () => 0o644 },
      ),
    ).toThrow(/^PROBE_SECRETS_FILE$/);
  });
  it("responses and records exclude app secret, permanent key, session key, raw openid and full phone", async () => {
    const rows: Attempt[] = [];
    const redactor = new Redactor();
    const provider = createFakeProvider();
    const app = createProbe(
      { ...fakeConfig, secrets },
      provider,
      (row) => rows.push(row),
      redactor,
    );
    const login = await app.request("/api/probe/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "sentinel" }),
    });
    const loginData = (await login.json()) as { sessionToken: string };
    const headers = {
      Authorization: `Bearer ${loginData.sessionToken}`,
      "Content-Type": "application/json",
    };
    const phone = await app.request("/api/probe/phone", {
      method: "POST",
      headers,
      body: JSON.stringify({ code: "phone", kind: "quick" }),
    });
    const phoneText = await phone.text();
    const sensitive = [
      secrets.WECHAT_APP_SECRET,
      secrets.COS_SECRET_KEY,
      "fake-session-key-sentinel",
      "fake-openid-sentinel",
      "13800001111",
    ];
    for (const value of sensitive)
      await app.request("/api/probe/attempts", {
        method: "POST",
        headers,
        body: JSON.stringify({ ...attempt, device: value }),
      });
    for (const value of sensitive) {
      expect(JSON.stringify(loginData) + phoneText + JSON.stringify(rows)).not.toContain(value);
    }
    const invalid = await app.request("/api/probe/attempts", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...attempt, secret: secrets.COS_SECRET_KEY }),
    });
    expect(await invalid.text()).not.toContain(secrets.COS_SECRET_KEY);
    expect(invalid.status).toBe(400);
  });
  it("real protocol uses stable token without forced refresh, validates phone watermark and limits STS policy", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const result = String(url).includes("jscode2session")
        ? { openid: "private-openid", session_key: "private-session" }
        : String(url).includes("stable_token")
          ? { access_token: "private-access", expires_in: 7200 }
          : String(url).includes("getuserphonenumber")
            ? {
                phone_info: {
                  purePhoneNumber: "13800001111",
                  watermark: { appid: secrets.WECHAT_APP_ID },
                },
              }
            : {
                Response: {
                  Credentials: {
                    TmpSecretId: "temporary-id",
                    TmpSecretKey: "temporary-key",
                    Token: "temporary-token",
                  },
                  ExpiredTime: Math.floor(Date.now() / 1000) + 1800,
                },
              };
      return new Response(JSON.stringify(result), { status: 200 });
    });
    const provider = createRealProvider(secrets, fetcher as typeof fetch);
    await provider.login("login-code");
    await provider.phone("phone-code");
    await provider.phone("phone-code-2");
    expect(calls.filter((call) => call.url.includes("stable_token"))).toHaveLength(1);
    expect(JSON.parse(String(calls[1]!.init!.body))).toMatchObject({
      force_refresh: false,
      grant_type: "client_credential",
    });
    const credentials = await provider.credentials(`incoming/${"a".repeat(32)}/source.mp4`);
    expect(credentials.TmpSecretKey).toBe("temporary-key");
    const sts = calls.at(-1)!;
    const payload = JSON.parse(String(sts.init?.body));
    expect(payload.DurationSeconds).toBe(1800);
    expect(JSON.parse(decodeURIComponent(payload.Policy)).statement[0].resource[0]).toContain(
      `incoming/${"a".repeat(32)}/*`,
    );
    expect(sts.init?.headers).toMatchObject({
      "X-TC-Version": "2018-08-13",
      "X-TC-Region": "ap-guangzhou",
    });
    const failing = createRealProvider(
      secrets,
      vi.fn(async () => {
        throw new Error(secrets.WECHAT_APP_SECRET);
      }) as typeof fetch,
    );
    await expect(failing.login("x")).rejects.toThrow(/^PROVIDER_UNAVAILABLE$/);
  });
});
it("report separates fake/real, counts failures, computes median/max, and does not infer conclusions", () => {
  const rows: RecordRow[] = [100, 200, 300, 400].map((durationMs, i) => ({
    ...attempt,
    durationMs,
    result: i === 3 ? "failure" : "success",
    recordedAt: "2026-11-03T00:00:00Z",
    probeMode: "real",
  }));
  rows.push({ ...rows[0]!, probeMode: "fake" });
  const report = summarize(rows, "real");
  expect(report).toContain("| 4 | 3 | 75.0% | 250 | 400 |");
  expect(report).toContain("V7 | 未实测");
  expect(report).toContain("不自动宣告通过");
});

it("rejects fake or missing source mode at a real server before recording", async () => {
  const rows: Attempt[] = [];
  const app = createProbe({ ...fakeConfig, mode: "real" }, createFakeProvider(), (row) =>
    rows.push(row),
  );
  const session = await app.request("/api/probe/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "fake-test-only" }),
  });
  const { sessionToken } = (await session.json()) as { sessionToken: string };
  const send = (body: object) =>
    app.request("/api/probe/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify(body),
    });
  const mismatched = await send(attempt);
  expect(mismatched.status).toBe(409);
  expect(await mismatched.json()).toEqual({ error: "PROBE_MODE_MISMATCH" });
  const { probeMode: _mode, ...legacy } = attempt;
  expect((await send(legacy)).status).toBe(400);
  expect(rows).toHaveLength(0);
  expect((await send({ ...attempt, probeMode: "real" })).status).toBe(200);
  expect(rows).toEqual([expect.objectContaining({ probeMode: "real" })]);
});
