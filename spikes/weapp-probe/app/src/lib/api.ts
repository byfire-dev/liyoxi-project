import Taro from "@tarojs/taro";

export type ProbeMode = "fake" | "real";
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
type Recorded = Attempt & {
  probeMode: ProbeMode | "unknown";
  serviceUrl: string;
  device: string;
  system: string;
  baseLibrary: string;
  network: string;
};
type Identity = { sessionToken: string; identityTag: string; accountId: string | null };
let identity: Identity | undefined;
let loginPending: Promise<Identity> | undefined;
let probeMode: ProbeMode | undefined;
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
export async function getProbeMode(refresh = false): Promise<ProbeMode> {
  if (refresh || probeMode === undefined) {
    const value = (await request<{ mode: unknown }>("/api/probe/health", "GET")).mode;
    if (value !== "fake" && value !== "real") throw new ProbeError("PROBE_MODE_INVALID");
    if (probeMode !== value) identity = undefined;
    probeMode = value;
  }
  return probeMode;
}
export async function isFake(refresh = false) {
  return (await getProbeMode(refresh)) === "fake";
}
const quarantineKey = "lyx_probe_quarantined";
export function quarantine(source: string, value: unknown) {
  const entries = Taro.getStorageSync<unknown[]>(quarantineKey) || [];
  Taro.setStorageSync(quarantineKey, [...entries, { source, value }]);
}
export function quarantinedCount(): number {
  return (Taro.getStorageSync<unknown[]>(quarantineKey) || []).length;
}
export async function login(force = false): Promise<Identity> {
  if (force) {
    identity = undefined;
    await getProbeMode(true);
  }
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
      if (!pendingCount()) return;
      const currentMode = await getProbeMode(true);
      const pending = Taro.getStorageSync<Recorded[]>(pendingKey) || [];
      const compatible = pending.filter(
        (entry) => entry.probeMode === currentMode && entry.serviceUrl === baseUrl,
      );
      const incompatible = pending.filter(
        (entry) => entry.probeMode !== currentMode || entry.serviceUrl !== baseUrl,
      );
      incompatible.forEach((entry) => quarantine("attempt", entry));
      Taro.setStorageSync(pendingKey, compatible);
      const entry = compatible[0];
      if (!entry) return;
      const { serviceUrl: _serviceUrl, ...payload } = entry;
      await api("/attempts", "POST", payload);
      const current = Taro.getStorageSync<Recorded[]>(pendingKey) || [];
      Taro.setStorageSync(
        pendingKey,
        current.filter((value) => value.attemptId !== entry.attemptId),
      );
    }
  } finally {
    flushing = false;
  }
}
export async function report(
  attempt: Attempt,
  originMode: ProbeMode | "unknown" = probeMode ?? "unknown",
) {
  const info = Taro.getSystemInfoSync();
  const network = await Taro.getNetworkType()
    .then((value) => value.networkType)
    .catch(() => "unknown");
  const record: Recorded = {
    ...attempt,
    probeMode: originMode,
    serviceUrl: baseUrl,
    durationMs: Math.min(86400000, Math.max(0, attempt.durationMs)),
    attemptId: attempt.attemptId || newId(),
    device: info.model,
    system: info.system,
    baseLibrary: info.SDKVersion || "unknown",
    network,
  };
  if (originMode === "unknown") {
    quarantine("attempt", record);
    return;
  }
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
  const originMode = await getProbeMode(true).catch(() => "unknown" as const);
  try {
    await work();
    await report(
      {
        item,
        scenario,
        sizeBytes,
        durationMs: Date.now() - started,
        result: "success",
        errorCode: "",
      },
      originMode,
    );
  } catch (error) {
    const code = errorCode(error);
    await report(
      {
        item,
        scenario,
        sizeBytes,
        durationMs: Date.now() - started,
        result: code === "CANCELLED" ? "cancelled" : "failure",
        errorCode: code,
      },
      originMode,
    );
    throw error;
  }
}
