// @liyoxi/db 的入口：Prisma 客户端与它的唯一构造入口（W0-05）。
// 客户端是生成物，不入库：先跑 pnpm db:generate，生成到本包的 dist/generated/（见 README.md）。
// 应用层不直接引本包；只在进程装配时由 services 的 kernel 引工厂（CLAUDE.md 第 6 节规则 5）。
import { PrismaPg } from "@prisma/adapter-pg";

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
