import Taro from "@tarojs/taro";

export type Item = "V19" | "V8" | "V3" | "V7";
export type Attempt = {
  item: Item;
  scenario: string;
  sizeBytes: number;
  durationMs: number;
  result: "success" | "failure" | "cancelled" | "interrupted";
  errorCode: string;
  mode?: "temp" | "user_dir";
  runId?: string;
  completedParts?: number;
  totalParts?: number;
  sentParts?: number;
  retransmittedParts?: number;
  phase?: string;
  index?: number;
  attemptId?: string;
};
type Recorded = Attempt & { device: string; system: string; baseLibrary: string; network: string };
type Identity = { sessionToken: string; identityTag: string; accountId: string | null };
let identity: Identity | undefined;
let loginPending: Promise<Identity> | undefined;
let fake: boolean | undefined;
const pendingKey = "lyx_probe_attempts";
export const baseUrl = __PROBE_BASE_URL__.replace(/\/$/, "");
export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
export class ProbeError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

export function errorCode(error: unknown): string {
  if (error instanceof ProbeError) return error.code;
  const value = error as {
    errno?: unknown;
    errMsg?: unknown;
    message?: unknown;
    error?: unknown;
    err?: unknown;
  };
  if (typeof value?.errno === "number") return `WX_${value.errno}`;
  if (value?.error || value?.err) return errorCode(value.error || value.err);
  const message = String(value?.errMsg || value?.message || "").toLowerCase();
  if (message.includes("cancel")) return "CANCELLED";
  if (message.includes("timeout")) return "TIMEOUT";
  if (message.includes("auth") || message.includes("deny") || message.includes("permission"))
    return "PERMISSION_DENIED";
  if (message.includes("space") || message.includes("storage") || message.includes("quota"))
    return "STORAGE_LIMIT";
  if (message.includes("size") || message.includes("large")) return "FILE_SIZE_LIMIT";
  if (message.includes("abort")) return "INTERRUPTED";
  return "PLATFORM_ERROR";
}
async function request<T>(
  path: string,
  method: "GET" | "POST",
  data?: object,
  token?: string,
): Promise<T> {
  const response = await Taro.request<T & { error?: string }>({
    url: `${baseUrl}${path}`,
    method,
    data,
    timeout: 30000,
    header: {
      "content-type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (response.statusCode < 200 || response.statusCode >= 300) {
    if (response.statusCode === 401) identity = undefined;
    const code = response.data?.error;
    throw new ProbeError(
      typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
        ? code
        : `HTTP_${response.statusCode}`,
    );
  }
  return response.data;
}
export async function isFake() {
  if (fake === undefined)
    fake = (await request<{ mode: string }>("/api/probe/health", "GET")).mode === "fake";
  return fake;
}
export async function login(force = false): Promise<Identity> {
  if (force) identity = undefined;
  if (identity) return identity;
  if (loginPending) return loginPending;
  loginPending = (async () => {
    const code = (await isFake()) ? "fake-wechat-one" : (await Taro.login()).code;
    if (!code) throw new ProbeError("LOGIN_CODE_MISSING");
    identity = await request<Identity>("/api/probe/login", "POST", { code });
    return identity;
  })();
  try {
    return await loginPending;
  } finally {
    loginPending = undefined;
  }
}
export async function api<T>(path: string, method: "GET" | "POST" = "GET", data?: object) {
  const session = await login();
  return request<T>(`/api/probe${path}`, method, data, session.sessionToken);
}
export function pendingCount(): number {
  return (Taro.getStorageSync<Recorded[]>(pendingKey) || []).length;
}
let flushing = false;
export async function flushAttempts(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (true) {
      const pending = Taro.getStorageSync<Recorded[]>(pendingKey) || [];
      if (!pending.length) return;
      await api("/attempts", "POST", pending[0]);
      const current = Taro.getStorageSync<Recorded[]>(pendingKey) || [];
      Taro.setStorageSync(
        pendingKey,
        current.filter((entry) => entry.attemptId !== pending[0].attemptId),
      );
    }
  } finally {
    flushing = false;
  }
}
export async function report(attempt: Attempt) {
  const info = Taro.getSystemInfoSync();
  const network = await Taro.getNetworkType()
    .then((value) => value.networkType)
    .catch(() => "unknown");
  const record: Recorded = {
    ...attempt,
    durationMs: Math.min(86400000, Math.max(0, attempt.durationMs)),
    attemptId: attempt.attemptId || newId(),
    device: info.model,
    system: info.system,
    baseLibrary: info.SDKVersion || "unknown",
    network,
  };
  const pending = Taro.getStorageSync<Recorded[]>(pendingKey) || [];
  pending.push(record);
  Taro.setStorageSync(pendingKey, pending);
  await flushAttempts().catch(() => undefined);
}
export async function ensurePrivacy() {
  const privacy = await new Promise<Taro.getPrivacySetting.SuccessCallbackResult>(
    (resolve, reject) => Taro.getPrivacySetting({ success: resolve, fail: reject }),
  );
  if (privacy.needAuthorization)
    await new Promise<void>((resolve, reject) =>
      Taro.requirePrivacyAuthorize({ success: () => resolve(), fail: reject }),
    );
}
export async function observe(
  item: Item,
  scenario: string,
  work: () => Promise<void>,
  sizeBytes = 0,
) {
  const started = Date.now();
  try {
    await work();
    await report({
      item,
      scenario,
      sizeBytes,
      durationMs: Date.now() - started,
      result: "success",
      errorCode: "",
    });
  } catch (error) {
    const code = errorCode(error);
    await report({
      item,
      scenario,
      sizeBytes,
      durationMs: Date.now() - started,
      result: code === "CANCELLED" ? "cancelled" : "failure",
      errorCode: code,
    });
    throw error;
  }
}
