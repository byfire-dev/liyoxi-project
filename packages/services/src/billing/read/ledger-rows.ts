import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@liyoxi/db";
import {
  AdminLedgerRowSchema,
  MerchantLedgerRowSchema,
  parseLedgerTitleArgs,
  billingOrderContentSchema,
} from "@liyoxi/contract";
import type { AccountLedgerQuery, MerchantLedgerQuery } from "@liyoxi/contract";
import { calendarDate, startOfDay, addDays } from "@liyoxi/shared/time";
import { formatInteger, formatMoney } from "@liyoxi/shared/format/money";
import { AppError } from "../../kernel/index.js";
import type { Tx } from "../../kernel/index.js";

const rowSchema = z.object({
  id: z.uuid(),
  seq: z.string().regex(/^\d+$/),
  opKey: z.string(),
  opType: z.string(),
  occurredAt: z.string().transform((at) => new Date(at).toISOString()),
  bizDate: z.string(),
  lotKind: z.enum(["plan", "addon"]).nullable(),
  lotOrder: z.int(),
  deltaPoints: z.int(),
  qty: z.int().nonnegative(),
  category: AdminLedgerRowSchema.shape.category,
  tab: z.enum(["gain", "use", "expire", "all"]),
  titleCode: z.string().nullable(),
  titleArgs: z.unknown(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  storeId: z.string().nullable(),
  storeName: z.string().nullable(),
  spendableAfter: z.int(),
  heldAfter: z.int(),
  groupRef: z.string().nullable(),
  holdStatus: z.string().nullable(),
  itemCount: z.int().positive(),
});
type Row = z.infer<typeof rowSchema>;
const cursorSchema = z.strictObject({
  v: z.literal(1),
  hash: z.string(),
  at: z.iso.datetime(),
  seq: z.string().regex(/^\d{1,20}$/),
  lot: z.int().min(0).max(2),
});
const cursorError = () =>
  new AppError("VALIDATION_FAILED", {
    details: { fieldErrors: [{ path: "cursor", message: "游标无效或不属于当前筛选" }] },
  });

/** 在操作×类型分行/商家同次冻结合并之后分页；游标含类型位置，不能截掉同操作另一行。 */
export async function ledgerRows(
  tx: Tx,
  entityId: string,
  query: AccountLedgerQuery | MerchantLedgerQuery,
  at: Date,
  merchant: boolean,
) {
  const month =
    "month" in query ? (query.month ?? calendarDate(at).slice(0, 7)) : calendarDate(at).slice(0, 7);
  if (merchant && month > calendarDate(at).slice(0, 7)) throw new AppError("VALIDATION_FAILED");
  const storeId = "storeId" in query ? (query.storeId ?? null) : null,
    lot = "lotKind" in query ? (query.lotKind ?? null) : null,
    from = "occurredFrom" in query && query.occurredFrom ? startOfDay(query.occurredFrom) : null,
    until =
      "occurredTo" in query && query.occurredTo ? startOfDay(addDays(query.occurredTo, 1)) : null,
    hash = createHash("sha256")
      .update(
        JSON.stringify([
          entityId,
          merchant,
          merchant ? month : null,
          query.tab,
          storeId,
          lot,
          from,
          until,
        ]),
      )
      .digest("hex");
  let cursor: z.infer<typeof cursorSchema> | null = null;
  if (query.cursor) {
    try {
      cursor = cursorSchema.parse(
        JSON.parse(Buffer.from(query.cursor, "base64url").toString("utf8")),
      );
    } catch {
      throw cursorError();
    }
    if (cursor.hash !== hash) throw cursorError();
  }
  const result = await tx.$queryRaw<
    { rows: unknown; total: number; prevMonth: string | null; firstEntryAt: Date | null }[]
  >(Prisma.sql`
    WITH ops AS (
      SELECT o.*, h.group_ref, h.status AS hold_status, s.name AS store_name,
        CASE WHEN ${merchant} AND o.op_type='hold' AND o.request_id IS NOT NULL AND h.group_ref IS NOT NULL
          THEN jsonb_build_array(o.request_id,o.occurred_at,o.actor_type,o.actor_id,o.client,h.group_ref)::text
          ELSE o.id::text END AS group_key
      FROM ledger_operation o LEFT JOIN point_hold h ON h.id=o.point_hold_id
        LEFT JOIN store s ON s.id=o.store_id AND s.entity_id=o.entity_id
      WHERE o.entity_id=${entityId}::uuid
        AND (NOT ${merchant} OR to_char(o.biz_date,'YYYY-MM')=${month})
        AND (${storeId}::uuid IS NULL OR o.store_id=${storeId}::uuid)
        AND (${from}::timestamptz IS NULL OR o.occurred_at>=${from})
        AND (${until}::timestamptz IS NULL OR o.occurred_at<${until})
        AND o.op_type NOT IN ('fulfill','extend') AND (NOT ${merchant} OR o.op_type<>'capture')
    ), grouped AS (
      SELECT (array_agg(id ORDER BY seq))[1] AS id, min(seq) AS seq, array_agg(id) AS ids,
        sum(plan_delta_qty)::int AS plan_delta, sum(addon_delta_qty)::int AS addon_delta,
        count(*)::int AS item_count,
        (array_agg(hold_status ORDER BY CASE WHEN hold_status='held' THEN 0 WHEN hold_status<>'captured' THEN 1 ELSE 2 END, seq))[1] AS hold_status
      FROM ops GROUP BY group_key
    ), projected AS (
      SELECT o.*, g.seq AS group_seq, g.item_count, g.hold_status AS display_hold_status,
        split.lot_kind, split.lot_order, split.delta,
        CASE WHEN o.op_type='capture' THEN COALESCE((SELECT sum(e.qty)::int FROM point_ledger_entry e WHERE e.ledger_operation_id=ANY(g.ids) AND e.from_bucket='held' AND e.to_bucket='consumed'),0)
          ELSE abs(split.delta) END AS qty,
        CASE WHEN o.op_type IN ('addon_suspend','addon_resume','refund_suspend','refund_resume') THEN 'gate'
          WHEN o.op_type IN ('grant','unexpire') THEN 'grant' WHEN o.op_type='purchase' THEN 'purchase'
          WHEN o.op_type='hold' THEN 'hold' WHEN o.op_type='capture' THEN 'capture'
          WHEN o.op_type IN ('release','refund') THEN 'return' WHEN o.op_type IN ('expire','revoke') THEN 'expire' ELSE 'adjust' END AS category
      FROM grouped g JOIN ops o ON o.id=g.id
      CROSS JOIN LATERAL (VALUES ('plan'::text,0,g.plan_delta),('addon'::text,1,g.addon_delta),(NULL::text,2,0)) split(lot_kind,lot_order,delta)
      WHERE (split.lot_kind IS NOT NULL AND split.delta<>0 AND o.op_type NOT IN ('capture','addon_suspend','addon_resume','refund_suspend','refund_resume'))
        OR (split.lot_kind IS NULL AND o.op_type IN ('capture','addon_suspend','addon_resume','refund_suspend','refund_resume'))
    ), classified AS (
      SELECT p.*, CASE WHEN category='gate' THEN 'all' WHEN category='expire' THEN 'expire'
        WHEN category='capture' OR delta<0 THEN 'use' ELSE 'gain' END AS tab FROM projected p
    ), filtered AS (
      SELECT * FROM classified WHERE (${query.tab}='all' OR tab=${query.tab}) AND (${lot}::text IS NULL OR lot_kind=${lot})
    ), page AS (
      SELECT * FROM filtered WHERE ${cursor === null} OR occurred_at<${cursor ? new Date(cursor.at) : null}::timestamptz
        OR (occurred_at=${cursor ? new Date(cursor.at) : null}::timestamptz AND (group_seq<${cursor?.seq ?? null}::bigint
          OR (group_seq=${cursor?.seq ?? null}::bigint AND lot_order>${cursor?.lot ?? null}::int)))
      ORDER BY occurred_at DESC,group_seq DESC,lot_order ASC LIMIT ${query.limit + 1}
    )
    SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',id,'seq',group_seq::text,'opKey',op_key,'opType',op_type,'occurredAt',occurred_at,'bizDate',to_char(biz_date,'YYYY-MM-DD'),
      'lotKind',lot_kind,'lotOrder',lot_order,'deltaPoints',delta,'qty',qty,'category',category,'tab',tab,
      'titleCode',title_code,'titleArgs',title_args,'refType',ref_type,'refId',ref_id,'actorType',actor_type,'actorId',actor_id,
      'storeId',store_id,'storeName',store_name,'spendableAfter',spendable_after_qty,'heldAfter',held_after_qty,
      'groupRef',group_ref,'holdStatus',display_hold_status,'itemCount',item_count
    ) ORDER BY occurred_at DESC,group_seq DESC,lot_order ASC) FROM page),'[]'::jsonb) AS rows,
      (SELECT least(count(*),10000)::int FROM filtered) AS total,
      (SELECT max(to_char(biz_date,'YYYY-MM')) FROM ledger_operation WHERE entity_id=${entityId}::uuid
        AND op_type NOT IN ('fulfill','extend','capture') AND to_char(biz_date,'YYYY-MM')<${month}) AS "prevMonth",
      (SELECT min(occurred_at) FROM ledger_operation WHERE entity_id=${entityId}::uuid
        AND op_type NOT IN ('fulfill','extend','capture')) AS "firstEntryAt"
  `);
  const raw = result[0];
  if (!raw) throw new AppError("INTERNAL");
  const all = z.array(rowSchema).parse(raw.rows),
    hasMore = all.length > query.limit,
    rows = all.slice(0, query.limit);
  const rendered = await Promise.all(
    rows.map(async (row) => ({ row, ...(await renderLedgerTitle(tx, row)) })),
  );
  const last = rows.at(-1),
    nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ v: 1, hash, at: last.occurredAt, seq: last.seq, lot: last.lotOrder }),
          ).toString("base64url")
        : null;
  return {
    rows: rendered,
    nextCursor,
    hasMore,
    totalApprox: raw.total,
    month,
    prevMonth: raw.prevMonth,
    firstEntryAt: raw.firstEntryAt?.toISOString() ?? null,
  };
}

async function renderLedgerTitle(
  tx: Tx,
  r: Row,
): Promise<{ title: string; formula: string | null; remark: string | null; refNo: string | null }> {
  let title = "积分变动",
    formula: string | null = null,
    remark: string | null = null,
    refNo = r.groupRef;
  switch (r.titleCode) {
    case "grant_open":
    case "grant_term": {
      const a = parseLedgerTitleArgs(r.titleCode, r.titleArgs);
      title =
        r.titleCode === "grant_open" ? `开通${a.planName}，发放本期套餐积分` : "发放本期套餐积分";
      remark = `${a.planName} · ${a.termStartDate} 至 ${a.termEndDate}`;
      if ("billingOrderNo" in a) refNo = a.billingOrderNo;
      break;
    }
    case "grant_monthly": {
      const a = parseLedgerTitleArgs("grant_monthly", r.titleArgs);
      title = "发放本月套餐积分";
      remark = `${a.planName} · 第${a.monthNo + 1}个月`;
      break;
    }
    case "grant_upgrade": {
      const a = parseLedgerTitleArgs("grant_upgrade", r.titleArgs);
      refNo = a.billingOrderNo;
      const order = r.refId ? await tx.billingOrder.findUnique({ where: { id: r.refId } }) : null,
        content = order ? billingOrderContentSchema.parse(order.contentSnapshot) : null,
        revision =
          content?.kind === "upgrade"
            ? await tx.planRevision.findUnique({
                where: { id: content.toPlanRevisionId },
                include: { plan: true },
              })
            : null;
      title = `升级${revision?.plan.name ?? "套餐"}，补发套餐积分`;
      const first =
        content?.kind === "upgrade" && Number(r.opKey.split(":").at(-1)) === content.monthIndex;
      formula = first
        ? `(${a.toMonthlyPoints} − ${a.fromMonthlyPoints}) × ${a.remainingDays} ÷ ${a.baseDays}`
        : `${a.toMonthlyPoints} − ${a.fromMonthlyPoints}（完整月）`;
      break;
    }
    case "topup": {
      const a = parseLedgerTitleArgs("topup", r.titleArgs);
      title = "加购积分";
      refNo = a.billingOrderNo;
      remark = `${a.channel === "wechat_jsapi" ? "微信支付" : "对公转账"} ${formatMoney(a.payFen)}`;
      break;
    }
    case "order_hold": {
      const a = parseLedgerTitleArgs("order_hold", r.titleArgs);
      title = `订购${a.dramaTitles.map((t) => `《${t}》`).join("、")}`;
      formula = `逐部取整：(${a.pricePoints.map(formatInteger).join("＋")}) × ${a.discountBp}/10000 × (1＋${a.surchargeBp}/10000)`;
      break;
    }
    case "ad_hold":
    case "ad_revision_charge": {
      const a = parseLedgerTitleArgs(r.titleCode, r.titleArgs);
      title = r.titleCode === "ad_hold" ? "广告制作" : "广告超次修改";
      refNo = a.adNo;
      formula = `${a.unitPoints} × ${a.discountBp}/10000`;
      break;
    }
    case "capture": {
      const a = parseLedgerTitleArgs("capture", r.titleArgs);
      title = "开始制作，积分已扣减";
      refNo = a.refNo;
      break;
    }
    case "release": {
      const a = parseLedgerTitleArgs("release", r.titleArgs);
      title = "取消订购，积分退回";
      refNo = a.refNo;
      break;
    }
    case "refund": {
      const a = parseLedgerTitleArgs("refund", r.titleArgs);
      title = a.reasonClass === "platform" ? "平台原因退回" : "取消订购，退回积分";
      refNo = a.refNo;
      if (a.isConversion && r.lotKind === "addon") remark = "转为加购积分";
      break;
    }
    case "term_expire":
      title = "上期套餐积分到期清零";
      break;
    case "unexpire": {
      const a = parseLedgerTitleArgs("unexpire", r.titleArgs);
      title = "有效期延长，恢复已清零积分";
      remark = `补偿延长${a.days}天`;
      break;
    }
    case "adjust": {
      const a = parseLedgerTitleArgs("adjust", r.titleArgs);
      const labels = {
        compensation: "制作问题补偿",
        platform_refund: "平台原因退回",
        correction: "纠正错误记录",
        campaign: "运营活动赠送",
        other: "其他",
      };
      title = `积分调整：${labels[a.reasonCode]}`;
      remark = a.note ?? null;
      break;
    }
    case "addon_suspend":
      title = "套餐过期，加购积分停用";
      break;
    case "addon_resume":
      title = "有效期恢复，加购积分恢复使用";
      break;
    case "refund_suspend":
      title = "套餐退款处理中，积分暂停使用";
      break;
    case "refund_resume":
      title = "退款结束，积分恢复使用";
      break;
    case "revoke":
      title = "套餐退款，积分作废";
      break;
    case "fix":
      title = "积分修正";
      break;
  }
  return { title, formula, remark, refNo };
}

export async function adminLedgerPage(
  tx: Tx,
  entityId: string,
  query: AccountLedgerQuery,
  at: Date,
) {
  const page = await ledgerRows(tx, entityId, query, at, false);
  const items = await Promise.all(
    page.rows.map(async ({ row: r, title, formula, refNo }) => {
      const name =
        r.actorType === "staff" && r.actorId
          ? (await tx.staff.findUnique({ where: { id: r.actorId }, select: { name: true } }))?.name
          : r.actorType === "merchant" && r.actorId
            ? (
                await tx.merchantUser.findUnique({
                  where: { id: r.actorId },
                  select: { displayName: true },
                })
              )?.displayName
            : null;
      return AdminLedgerRowSchema.parse({
        rowKey: `${r.id}:${r.lotKind ?? "single"}`,
        ledgerOperationId: r.id,
        opType: r.opType,
        category: r.category,
        lotKind: r.lotKind,
        deltaPoints: r.deltaPoints,
        qty: r.qty,
        occurredAt: r.occurredAt,
        bizDate: r.bizDate,
        title,
        formula,
        refNo,
        store: r.storeId ? { storeId: r.storeId, name: r.storeName ?? "" } : null,
        spendableAfterPoints: r.spendableAfter,
        heldAfterPoints: r.heldAfter,
        actor: { type: r.actorType, name: name ?? (r.actorType === "system" ? "系统" : "商家") },
      });
    }),
  );
  return {
    items,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    totalApprox: page.totalApprox,
  };
}
export async function merchantLedgerPage(
  tx: Tx,
  entityId: string,
  query: MerchantLedgerQuery,
  at: Date,
) {
  const page = await ledgerRows(tx, entityId, query, at, true);
  return {
    items: page.rows.map(({ row: r, title, formula, remark, refNo }) =>
      MerchantLedgerRowSchema.parse({
        rowKey: `${r.id}:${r.lotKind ?? "single"}`,
        category: r.tab === "all" ? "other" : r.tab,
        opType: r.opType,
        lotKind: r.lotKind,
        deltaPoints: r.deltaPoints,
        occurredAt: r.occurredAt,
        bizDate: r.bizDate,
        title,
        remark,
        formula,
        storeName: r.storeName,
        refNo,
        itemCount: r.itemCount,
        holdStatus: r.holdStatus,
      }),
    ),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    month: page.month,
    prevMonth: page.prevMonth,
    firstEntryAt: page.firstEntryAt,
  };
}
