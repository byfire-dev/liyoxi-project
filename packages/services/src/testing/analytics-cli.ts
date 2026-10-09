import type { PrismaClient } from "@liyoxi/db";
import { uuidv7 } from "../kernel/index.js";
import { createClock } from "./clock.js";
import { createFactories } from "./data/index.js";

/** 应用CLI测试只调真实服务/读结果；领域样例仍在既有testing层。 */
export function createAnalyticsCliSupport(prisma: PrismaClient) {
  const clock = createClock(new Date());
  const now = new Date(clock.now().getTime() + 8 * 3_600_000);
  now.setUTCDate(1);
  now.setUTCMonth(now.getUTCMonth() - 2);
  const month = now.toISOString().slice(0, 7);
  return {
    month,
    make: createFactories({ db: prisma, clock }),
    async event() {
      const id = uuidv7();
      await prisma.$executeRawUnsafe(
        `INSERT INTO public.analytics_event
        (occurred_at,id,event_id,name,source,actor_type,received_at,props)
        VALUES ($1::timestamptz,$2::uuid,$3,'cli_fixture','direct','system',$1::timestamptz,'{"fictional":true}'::jsonb)`,
        `${month}-02T00:00:00.123456Z`,
        id,
        `fictional-${id}`,
      );
      return id;
    },
    async exactRow(id: string) {
      return prisma.$queryRawUnsafe<Array<{ body: string }>>(
        "SELECT row_to_json(e)::text AS body FROM public.analytics_event e WHERE id=$1::uuid",
        id,
      );
    },
    async inDefault(id: string) {
      return prisma.$queryRawUnsafe<Array<{ id: string }>>(
        "SELECT id::text FROM public.analytics_event WHERE tableoid='public.analytics_event_default'::regclass AND id=$1::uuid",
        id,
      );
    },
  };
}
