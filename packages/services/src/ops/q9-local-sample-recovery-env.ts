import { isAbsolute, normalize } from "node:path";
import { AppError, loadEnv } from "../kernel/index.js";
import type { Env, EnvSource } from "../kernel/index.js";

const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
const refuse = (): never => {
  throw new AppError("VALIDATION_FAILED");
};

/** This command only reaches the existing public local-development instances. */
export function q9LocalSampleRecoveryEnv(source: EnvSource): Env {
  if (source.APP_ENV !== "local") return refuse();
  const url = (key: string, protocol: string, port: string, pathname: string) => {
    const raw = source[key] ?? "";
    // URL normalizes empty userinfo away; reject its raw spelling before normalization too.
    if (key !== "DATABASE_URL" && raw.includes("@")) return refuse();
    let value: URL;
    try {
      value = new URL(raw);
    } catch {
      return refuse();
    }
    if (
      !loopback.has(value.hostname) ||
      value.protocol !== protocol ||
      value.port !== port ||
      value.pathname !== pathname ||
      value.search ||
      value.hash
    )
      return refuse();
    return value;
  };
  const database = url("DATABASE_URL", "postgresql:", "5442", "/liyoxi");
  if (database.username !== "liyoxi" || database.password !== "lyx-local-dev") return refuse();
  const redis = url("REDIS_URL", "redis:", "6389", "/0");
  const minio = url("MINIO_ENDPOINT", "http:", "9100", "/");
  const publicMinio = url("MINIO_PUBLIC_ENDPOINT", "http:", "9100", "/");
  if ([redis, minio, publicMinio].some((entry) => entry.username || entry.password))
    return refuse();
  const workDir = source.LYX_Q9_MEDIA_WORK_DIR;
  const socketPath = source.LYX_Q9_MEDIA_SOCKET;
  if (
    !workDir ||
    !socketPath ||
    ![workDir, socketPath].every(
      (entry) => isAbsolute(entry) && normalize(entry) === entry && !entry.includes("\0"),
    ) ||
    workDir === "/" ||
    socketPath === "/"
  )
    return refuse();
  // Never pass inherited *_FILE, cloud credentials or login configuration to loadEnv.
  const env = loadEnv({
    APP_ENV: "local",
    LOG_LEVEL: "fatal",
    DATABASE_URL: database.href,
    REDIS_URL: redis.href,
    MINIO_ENDPOINT: minio.origin,
    MINIO_PUBLIC_ENDPOINT: publicMinio.origin,
  });
  return {
    ...env,
    MEDIA_PRODUCTION: { mode: "local_sample_watermark", workDir, socketPath },
  };
}
