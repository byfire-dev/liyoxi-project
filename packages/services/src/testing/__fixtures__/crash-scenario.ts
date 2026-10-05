import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@liyoxi/db";

import { crashPoint } from "../fault/crash.js";

// 进程中断工具自测用的场景（fault.test.ts 经 runUntilCrash 在子进程里跑它）。
// 连接串由父进程经 payload 传进来：子进程拿不到父进程里的对象。

export interface CrashScenarioPayload {
  databaseUrl: string;
}

/** 开事务写一行 → 断点 written（还没提交）→ 提交 → 断点 committed */
export default async function writeThenCommit(payload: CrashScenarioPayload): Promise<void> {
  const prisma = createPrismaClient({ connectionString: payload.databaseUrl, max: 1 });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.authEvent.create({
        data: { id: randomUUID(), createdAt: new Date(), space: "staff", event: "logout" },
      });
      await crashPoint("written");
    });
    await crashPoint("committed");
  } finally {
    await prisma.$disconnect();
  }
}

/** 抛错的场景：子进程应当以退出码 1 结束 */
export async function failing(): Promise<void> {
  await crashPoint("before-throw");
  throw new Error("场景自己出错了");
}

/** 永远不结束、也到不了指定断点的场景：父进程应当超时后杀掉它 */
export async function hanging(): Promise<void> {
  await crashPoint("started");
  await new Promise<never>(() => {
    setInterval(() => {}, 60_000);
  });
}
