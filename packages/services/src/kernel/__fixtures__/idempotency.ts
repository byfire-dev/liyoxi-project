// 幂等用例的共用部分（W0-13）：只给本目录的测试用。
import type { PrismaClient } from "@liyoxi/db";

import { createActor } from "../actor.js";
import type { Actor } from "../actor.js";
import { createIdempotencyContext } from "../idempotency.js";
import type { IdempotencyContext, IdempotencyContextInput } from "../idempotency.js";
import { uuidv7 } from "../ids.js";

export const SCOPE = "m.order.create";
export const STORE_ID = uuidv7();

export const merchant = (): Actor =>
  createActor({ type: "merchant", id: uuidv7(), client: "weapp", role: "owner" });

/** 一次请求的幂等上下文：每次调用都新建（一个上下文只给一次 tx.run） */
export const requestOf = (
  actor: Actor,
  key: string,
  body: unknown = { qty: 1 },
  extra: Partial<IdempotencyContextInput> = {},
): IdempotencyContext =>
  createIdempotencyContext({
    mode: "required",
    scope: SCOPE,
    actor,
    key,
    request: { method: "POST", pathParams: {}, body, storeId: STORE_ID },
    ...extra,
  });

/** 幂等表的全部行，顺序固定：比“表内容相同”用 */
export const idemRows = (prisma: PrismaClient) =>
  prisma.idempotencyRecord.findMany({
    orderBy: [{ scope: "asc" }, { actorKey: "asc" }, { key: "asc" }],
  });

/**
 * 等到本库里有 n 个会话卡在锁上（pg_locks 里没拿到的锁）。每个测试文件一个库，所以看到的只会是本文件的连接。
 * 用它证明“后到者真的阻塞了”，不靠睡一会儿。
 */
export async function untilWaiting(prisma: PrismaClient, n = 1, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
      SELECT count(DISTINCT l.pid)::int AS waiting
      FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE NOT l.granted AND a.datname = current_database()`;
    if ((row?.waiting ?? 0) >= n) return;
    if (Date.now() > deadline)
      throw new Error(`等了 ${timeoutMs} 毫秒，没有看到 ${n} 个会话在等锁`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
