import { Prisma } from "@liyoxi/db";
import {
  IdSchema,
  MESSAGE_TABS,
  MessageBatchReadBodySchema,
  MessageItemSchema,
  MessageListQuerySchema,
  MessageReadParamsSchema,
  MessageSummarySchema,
} from "@liyoxi/contract";
import type {
  MessageBatchReadBody,
  MessageItem,
  MessageListQuery,
  MessageSummary,
  MessageTab,
} from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { paramsAt } from "../config/index.js";
import { AppError } from "../kernel/index.js";
import type { Tx, TxRunOptions } from "../kernel/index.js";
import { availableStores, messageScope, visibleMessages } from "./messages.scope.js";
import type { MessageActor, MessageScope } from "./messages.scope.js";
import { createNotifySettings } from "./settings.js";
import type { NotifyMessagesDeps, NotifySettingActor } from "./settings.js";
export type { NotifyMessagesDeps } from "./settings.js";
export interface NotifyMessages {
  list(
    actor: MessageActor,
    query: MessageListQuery,
  ): Promise<{ items: MessageItem[]; nextCursor: string | null; hasMore: boolean }>;
  summary(actor: MessageActor): Promise<MessageSummary>;
  read(
    actor: MessageActor,
    messageId: string,
    options?: Pick<TxRunOptions, "idem">,
  ): Promise<{ messageId: string; readAt: string }>;
  batchRead(
    actor: MessageActor,
    body: MessageBatchReadBody,
    options?: Pick<TxRunOptions, "idem">,
  ): Promise<{ markedCount: number; summary: MessageSummary }>;
  settings(actor: NotifySettingActor): ReturnType<ReturnType<typeof createNotifySettings>>;
}

const tabWhere = (tab: MessageTab): Prisma.Sql =>
  tab === "all" ? Prisma.sql`TRUE` : Prisma.sql`m.category = ${tab}`;

function cursorId(cursor: string | undefined): string | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length > 128 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const raw: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("v" in raw) ||
      raw.v !== 1 ||
      !("id" in raw) ||
      typeof raw.id !== "string" ||
      !IdSchema.safeParse(raw.id).success ||
      Object.keys(raw).length !== 2
    )
      throw new Error();
    return raw.id;
  } catch {
    throw new AppError("VALIDATION_FAILED");
  }
}
const encodeCursor = (id: string): string =>
  Buffer.from(JSON.stringify({ v: 1, id })).toString("base64url");

async function scopeAt(tx: Tx, actor: MessageActor, now: Date): Promise<MessageScope> {
  const values = await paramsAt(tx, ["inbox.scope"], now);
  return messageScope(tx, actor, values["inbox.scope"] === "all_stores");
}

async function summaryAt(tx: Tx, scope: MessageScope): Promise<MessageSummary> {
  const groups = await tx.$queryRaw<{ category: string; count: number }[]>(Prisma.sql`
    SELECT m.category, count(*)::int AS count FROM merchant_message m
    WHERE ${visibleMessages(scope)} AND m.read_at IS NULL GROUP BY m.category`);
  const total = groups.reduce((count, row) => count + row.count, 0);
  let byStore: MessageSummary["byStore"] = [];
  if (scope.entityId !== null) {
    // 店员只列此刻可进的门店；账号与主体级消息在每家门店的计数中各算一次。
    const rows = await tx.$queryRaw<{ storeId: string; unreadCount: number }[]>(Prisma.sql`
      SELECT st.id::text AS "storeId", (
        SELECT count(*)::int FROM merchant_message m
        WHERE m.read_at IS NULL AND m.merchant_user_id = ${scope.merchantUserId}::uuid
          AND EXISTS (SELECT 1 FROM merchant_user mu WHERE mu.id = m.merchant_user_id AND mu.status = 'active')
          AND (m.entity_id IS NULL OR m.entity_id = ${scope.entityId}::uuid)
          AND (m.store_id IS NULL OR (m.store_id IN (${availableStores(scope.merchantUserId, scope.entityId)})
            AND (${scope.allStores} OR m.store_id = st.id)))
          AND (NOT m.is_owner_only OR EXISTS (SELECT 1 FROM entity_member owner JOIN entity e ON e.id = owner.entity_id
            WHERE owner.entity_id = m.entity_id AND owner.merchant_user_id = ${scope.merchantUserId}::uuid
              AND owner.status = 'active' AND owner.role = 'owner' AND e.lifecycle = 'active'))
      ) AS "unreadCount" FROM store st WHERE st.id IN (${availableStores(scope.merchantUserId, scope.entityId)})
        AND EXISTS (SELECT 1 FROM merchant_user mu WHERE mu.id = ${scope.merchantUserId}::uuid AND mu.status = 'active')
        AND EXISTS (SELECT 1 FROM store current_store WHERE current_store.id = ${scope.storeId}::uuid
          AND current_store.id IN (${availableStores(scope.merchantUserId, scope.entityId)}))
      ORDER BY st.id`);
    byStore = rows;
  }
  return MessageSummarySchema.parse({
    total,
    byTab: MESSAGE_TABS.map((tab) => ({
      tab,
      unreadCount: tab === "all" ? total : (groups.find((row) => row.category === tab)?.count ?? 0),
    })),
    byStore,
  });
}

interface MessageRow {
  messageId: string;
  category: string;
  title: string;
  body: string;
  ctaText: string | null;
  link: unknown;
  storeId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export function createNotifyMessages(deps: NotifyMessagesDeps): NotifyMessages {
  const { tx, clock } = deps;
  const settings = createNotifySettings(deps);
  return {
    settings,
    async list(actor, raw) {
      const query = MessageListQuerySchema.parse(raw);
      const before = cursorId(query.cursor);
      return tx.run(async (db) => {
        const scope = await scopeAt(db, actor, clock.now());
        const rows = await db.$queryRaw<MessageRow[]>(Prisma.sql`
          SELECT m.id::text AS "messageId", m.category, m.title, m.body, m.cta_text AS "ctaText",
            m.link, m.store_id::text AS "storeId", m.read_at AS "readAt", m.created_at AS "createdAt"
          FROM merchant_message m WHERE ${visibleMessages(scope)} AND ${tabWhere(query.tab)}
            AND (${before}::uuid IS NULL OR m.id < ${before}::uuid)
          ORDER BY m.id DESC LIMIT ${query.limit + 1}`);
        const hasMore = rows.length > query.limit;
        const items = rows.slice(0, query.limit).map((row) =>
          MessageItemSchema.parse({
            ...row,
            isRead: row.readAt !== null,
            readAt: row.readAt?.toISOString() ?? null,
            createdAt: row.createdAt.toISOString(),
            createdDate: calendarDate(row.createdAt),
          }),
        );
        return {
          items,
          hasMore,
          nextCursor: hasMore ? encodeCursor(items.at(-1)!.messageId) : null,
        };
      });
    },
    async summary(actor) {
      return tx.run(async (db) => summaryAt(db, await scopeAt(db, actor, clock.now())));
    },
    async read(actor, rawId, options) {
      const { messageId } = MessageReadParamsSchema.parse({ messageId: rawId });
      return tx.run(async (db) => {
        const now = clock.now();
        const scope = await scopeAt(db, actor, now);
        const updated = await db.$queryRaw<{ readAt: Date }[]>(Prisma.sql`
          UPDATE merchant_message m SET read_at = ${now}, updated_at = ${now}
          WHERE m.id = ${messageId}::uuid AND m.read_at IS NULL AND ${visibleMessages(scope)}
          RETURNING m.read_at AS "readAt"`);
        const row =
          updated[0] ??
          (
            await db.$queryRaw<{ readAt: Date | null }[]>(Prisma.sql`
          SELECT m.read_at AS "readAt" FROM merchant_message m
          WHERE m.id = ${messageId}::uuid AND ${visibleMessages(scope)}`)
          )[0];
        if (!row?.readAt) throw new AppError("NOT_FOUND");
        return { messageId, readAt: row.readAt.toISOString() };
      }, options);
    },
    async batchRead(actor, raw, options) {
      const body = MessageBatchReadBodySchema.parse(raw);
      return tx.run(async (db) => {
        const now = clock.now();
        const scope = await scopeAt(db, actor, now);
        const markedCount = await db.$executeRaw(Prisma.sql`
          UPDATE merchant_message m SET read_at = ${now}, updated_at = ${now}
          WHERE ${visibleMessages(scope)} AND m.read_at IS NULL AND m.id <= ${body.upToMessageId}::uuid
            AND ${tabWhere(body.tab)}`);
        return { markedCount, summary: await summaryAt(db, scope) };
      }, options);
    },
  };
}
