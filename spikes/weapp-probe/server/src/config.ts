import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const secretKeys = [
  "WECHAT_APP_ID",
  "WECHAT_APP_SECRET",
  "COS_SECRET_ID",
  "COS_SECRET_KEY",
  "COS_BUCKET",
  "COS_REGION",
  "COS_TEST_PREFIX",
] as const;
export type Secrets = Record<(typeof secretKeys)[number], string>;
export type Config = {
  mode: "fake" | "real";
  port: number;
  portalOrigin: string;
  secrets?: Secrets;
};
export class ConfigError extends Error {
  constructor(keys: readonly string[]) {
    super(keys.join(","));
  }
}
// The only credential-file entry point. Never log paths, file content or parser errors.
export function loadConfig(
  env: NodeJS.ProcessEnv,
  io = { read: (p: string) => readFileSync(p, "utf8"), mode: (p: string) => statSync(p).mode },
  projectRoot = path.resolve(import.meta.dirname, "../../../.."),
): Config {
  const mode = env.PROBE_MODE ?? "real";
  if (mode !== "fake" && mode !== "real") throw new ConfigError(["PROBE_MODE"]);
  const port = Number(env.PROBE_PORT ?? 4310);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ConfigError(["PROBE_PORT"]);
  const portalOrigin = env.PROBE_PORTAL_ORIGIN ?? "https://portal.example.invalid";
  try {
    if (new URL(portalOrigin).origin !== portalOrigin || !portalOrigin.startsWith("https://"))
      throw 0;
  } catch {
    throw new ConfigError(["PROBE_PORTAL_ORIGIN"]);
  }
  if (mode === "fake") return { mode, port, portalOrigin }; // no fs call, even with *_FILE set
  const read = (file: string, key: string) => {
    try {
      const resolved = path.resolve(file);
      if (
        !path.isAbsolute(file) ||
        resolved === projectRoot ||
        resolved.startsWith(`${projectRoot}/`) ||
        (io.mode(resolved) & 0o077) !== 0
      )
        throw 0;
      return io.read(resolved).trim();
    } catch {
      throw new ConfigError([key]);
    }
  };
  const values: Partial<Secrets> = {};
  if (secretKeys.some((key) => env[`${key}_FILE`])) {
    for (const key of secretKeys)
      if (env[`${key}_FILE`]) values[key] = read(env[`${key}_FILE`]!, `${key}_FILE`);
  } else {
    const content = read(
      env.PROBE_SECRETS_FILE ?? path.join(homedir(), ".lyx/x01-probe.env"),
      "PROBE_SECRETS_FILE",
    );
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const match = /^([A-Z_]+)=(.*)$/.exec(line);
      if (!match || !secretKeys.includes(match[1] as (typeof secretKeys)[number]))
        throw new ConfigError(["PROBE_SECRETS_FILE"]);
      const value = match[2]!.trim();
      values[match[1] as keyof Secrets] = value.replace(/^(['"])(.*)\1$/, "$2");
    }
  }
  const missing = secretKeys.filter(
    (key) => !values[key] || /^(?:<.*>|REPLACE_ME|placeholder)$/.test(values[key]!),
  );
  if (missing.length) throw new ConfigError(missing);
  const secrets = values as Secrets;
  const invalid: string[] = [];
  if (!/^wx[a-zA-Z0-9]{16}$/.test(secrets.WECHAT_APP_ID)) invalid.push("WECHAT_APP_ID");
  if (!/^[a-z0-9-]+-\d+$/.test(secrets.COS_BUCKET)) invalid.push("COS_BUCKET");
  if (!/^[a-z]+-[a-z]+(?:-\d+)?$/.test(secrets.COS_REGION)) invalid.push("COS_REGION");
  if (!/^x01\/[a-zA-Z0-9_-]+\/$/.test(secrets.COS_TEST_PREFIX)) invalid.push("COS_TEST_PREFIX");
  if (invalid.length) throw new ConfigError(invalid);
  return { mode, port, portalOrigin, secrets };
}
