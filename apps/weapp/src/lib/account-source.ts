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

/** M1 本机替身，真实登录码取得不到时才使用；不保存手机号。 */
export async function accountLoginCode(
  storage: KeyValueStorage,
  login: () => Promise<string>,
  uuid: () => string,
): Promise<string> {
  try {
    const code = await login();
    if (code) return code;
  } catch {
    /* M1 替身形态的默认兜底 */
  }
  const saved = storage.get<string>(StorageKey.localLoginCode);
  if (typeof saved === "string" && saved.length > 0) return saved;
  const code = `local-${uuid()}`;
  storage.set(StorageKey.localLoginCode, code);
  return code;
}
