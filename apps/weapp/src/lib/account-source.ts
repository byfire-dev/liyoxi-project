import type { Attribution } from "./account-api";
import type { KeyValueStorage } from "./platform";
import { StorageKey } from "./storage";

/** 首触保存整份来源，连无渠道的首次进入也占位，后来的邀请不能覆盖它。 */
export function rememberFirstTouch(
  storage: KeyValueStorage,
  options?: { scene?: number; query?: Record<string, unknown> },
): Attribution {
  const prior = storage.get<Attribution>(StorageKey.attribution);
  if (prior !== null && typeof prior === "object") return prior;
  const code = (value: unknown) =>
    typeof value === "string" && value.length > 0 && value.length <= 32 ? value : undefined;
  const channelCode = code(options?.query?.channelCode);
  const inviteCode = code(options?.query?.inviteCode);
  const value: Attribution = {
    ...(channelCode ? { channelCode } : {}),
    ...(inviteCode ? { inviteCode } : {}),
    ...(Number.isInteger(options?.scene) ? { scene: options!.scene } : {}),
  };
  storage.set(StorageKey.attribution, value);
  return value;
}

/** 每次获取一次性登录码；平台失败不生成本机凭证，也不复用上一次的码。 */
export async function accountLoginCode(login: () => Promise<string>): Promise<string> {
  try {
    const code = await login();
    if (typeof code === "string" && code.trim() && code.length <= 128) return code;
  } catch {
    // 不向页面暴露平台原始错误或临时凭证。
  }
  throw new Error("无法获取登录凭证，请重新点击登录");
}
