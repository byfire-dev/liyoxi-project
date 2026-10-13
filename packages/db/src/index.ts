// @liyoxi/db 的入口：Prisma 客户端与它的唯一构造入口（W0-05）。
// 客户端是生成物，不入库：先跑 pnpm db:generate，生成到本包的 dist/generated/（见 README.md）。
// 应用层不直接引本包；只在进程装配时由 services 的 kernel 引工厂（CLAUDE.md 第 6 节规则 5）。
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { PrismaClient } from "../dist/generated/client.js";

export * from "../dist/generated/client.js";

/**
 * 一个连接池的参数（D7 第 8.3 节“应用侧的数据库会话设置与连接池”）。
 * 取值由装配方（W0-22 的 api、W0-23 的 worker）按那张表传入，本包不读环境变量，也不写默认值。
 */
export interface CreatePrismaClientOptions {
  /** 连接串。隔离单位是库：不带 ?schema=，不设 search_path */
  connectionString: string;
  /** 连接数上限 */
  max: number;
  /** 三个会话超时，单位毫秒；不给即沿用服务器的设置（D7 表里写“—”的格子） */
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionSessionTimeoutMs?: number;
}

/** Prisma 客户端的唯一构造入口：一个连接池一个实例。会话超时随每条新连接的启动参数下发 */
export function createPrismaClient(options: CreatePrismaClientOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    max: options.max,
    statement_timeout: options.statementTimeoutMs,
    lock_timeout: options.lockTimeoutMs,
    idle_in_transaction_session_timeout: options.idleInTransactionSessionTimeoutMs,
  });
  return new PrismaClient({ adapter });
}

/** 专用物理会话的窄原语：不提供query/client，也不借用任何业务池。 */
export interface SessionMutexConnection {
  readonly lost: AbortSignal;
  tryLock(key: bigint): Promise<boolean>;
  isHeld(): Promise<boolean>;
  close(): Promise<void>;
}
export type SessionMutexConnectionFactory = (
  signal: AbortSignal,
) => Promise<SessionMutexConnection>;
export function createSessionMutexConnectionFactory(options: {
  connectionString: string;
  applicationName?: string;
  connectTimeoutMs?: number;
  queryTimeoutMs?: number;
}): SessionMutexConnectionFactory {
  return async (signal) => {
    signal.throwIfAborted();
    const client = new pg.Client({
      connectionString: options.connectionString,
      application_name: options.applicationName ?? "lyx_session_mutex",
      connectionTimeoutMillis: options.connectTimeoutMs ?? 3000,
      query_timeout: options.queryTimeoutMs ?? 2000,
      statement_timeout: options.queryTimeoutMs ?? 2000,
      keepAlive: true,
    });
    const lost = new AbortController();
    let closing: Promise<void> | undefined, key: bigint | undefined;
    const fail = (error: unknown) => lost.abort(error);
    client.on("error", fail);
    client.on("end", () => {
      if (!closing) fail(new Error("互斥专用连接已断开"));
    });
    const abort = () => {
      void client.end().catch(fail);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      await client.connect();
      signal.throwIfAborted();
    } catch (error) {
      signal.removeEventListener("abort", abort);
      await client.end().catch(() => undefined);
      throw error;
    }
    return {
      lost: lost.signal,
      async tryLock(value) {
        signal.throwIfAborted();
        lost.signal.throwIfAborted();
        if (key !== undefined) throw new TypeError("专用互斥连接只能持一把锁");
        const result = await client.query<{ held: boolean }>(
          "SELECT pg_try_advisory_lock($1::bigint) AS held",
          [value.toString()],
        );
        if (result.rows[0]?.held !== true) return false;
        key = value;
        return true;
      },
      async isHeld() {
        signal.throwIfAborted();
        lost.signal.throwIfAborted();
        if (key === undefined || closing) return false;
        const unsigned = BigInt.asUintN(64, key);
        const result = await client.query<{ held: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
           AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock'
           AND classid=$1::oid AND objid=$2::oid AND objsubid=1) AS held`,
          [(unsigned >> 32n).toString(), (unsigned & 0xffffffffn).toString()],
        );
        return result.rows[0]?.held === true;
      },
      close() {
        return (closing ??= (async () => {
          signal.removeEventListener("abort", abort);
          try {
            if (key !== undefined && !lost.signal.aborted && !signal.aborted)
              await client.query("SELECT pg_advisory_unlock($1::bigint)", [key.toString()]);
          } finally {
            key = undefined;
            await client.end();
          }
        })());
      },
    };
  };
}
