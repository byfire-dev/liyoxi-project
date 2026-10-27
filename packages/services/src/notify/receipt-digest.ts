import { DateSchema, IdSchema, InstantSchema } from "@liyoxi/contract";
import { calendarDate } from "@liyoxi/shared/time";
import { z } from "zod";
import { AppError, notifyReadOf, uuidv7 } from "../kernel/index.js";
import type { Assembly, Tx } from "../kernel/index.js";
import { addDelivery } from "./dispatch.js";

const SCENE = "s.receipt_daily_digest";
const Input = z.strictObject({
  reconDayId: IdSchema,
  bizDate: DateSchema,
  at: z.date(),
  items: z.array(
    z.strictObject({
      paymentTxnId: IdSchema,
      orderNo: z.string().min(1).max(64).nullable(),
      outTradeNo: z.string().min(1).max(64),
      amountFen: z.int().positive().max(2_147_483_647),
      confirmedAt: InstantSchema,
      confirmedBy: z
        .strictObject({ staffId: IdSchema, name: z.string().min(1).max(50) })
        .nullable(),
      bankSerialConflictOverride: z.boolean(),
    }),
  ),
});
type DigestInput = Omit<z.infer<typeof Input>, "items"> & {
  items: Readonly<z.infer<typeof Input>["items"]>;
};

/** billing提供可信成功bank事实与真实recon_day；本域只按当前在职超管同TX写站内。 */
export async function sendReceiptDailyDigest(
  tx: Tx,
  raw: DigestInput,
  assembly: Assembly,
): Promise<{ status: "sent" | "disabled" | "no_recipients"; recipients: number; created: number }> {
  const input = Input.parse(raw),
    { items, bizDate, at } = input;
  if (
    new Set(items.map((item) => item.paymentTxnId)).size !== items.length ||
    items.some(
      (item) =>
        calendarDate(new Date(item.confirmedAt)) !== bizDate || new Date(item.confirmedAt) > at,
    )
  )
    throw new TypeError("对公日摘要含重复、跨日或尚未发生的收款事实");
  const scene = await tx.notifyScene.findUnique({ where: { sceneKey: SCENE } });
  if (!scene || scene.audience !== "staff")
    throw new AppError("INTERNAL", { message: "对公确认日摘要场景尚未正确登记" });
  if (!scene.sceneEnabled) return { status: "disabled", recipients: 0, created: 0 };
  const recipients = [
    ...new Set(
      z.array(IdSchema).parse(
        await notifyReadOf(assembly).read<string[]>(tx, "activeStaffForNotify", {
          roleKey: "super_admin",
        }),
      ),
    ),
  ].sort();
  if (!recipients.length) return { status: "no_recipients", recipients: 0, created: 0 };
  const totalFen = items.reduce((total, item) => total + BigInt(item.amountFen), 0n).toString();
  const conflictCount = items.filter((item) => item.bankSerialConflictOverride).length;
  let created = 0;
  for (const staffId of recipients) {
    const notificationId = uuidv7();
    const inserted = await tx.notification.createMany({
      skipDuplicates: true,
      data: [
        {
          id: notificationId,
          notifySceneKey: SCENE,
          dedupeKey: `receipt.daily_digest:${bizDate}:${staffId}`,
          bizType: "recon_day",
          bizId: input.reconDayId,
          node: "N0",
          staffId,
          vars: { bizDate, totalFen, conflictCount, items },
          createdAt: at,
        },
      ],
    });
    if (!inserted.count) continue;
    await tx.staffMessage.create({
      data: {
        id: uuidv7(),
        notificationId,
        staffId,
        kind: "system",
        title: `${bizDate} 对公确认日摘要`,
        body: `已确认 ${items.length} 笔，合计 ${totalFen} 分；流水号冲突放行 ${conflictCount} 笔。按成功日期查看收款清单。`,
        // 既有交易口按channel_success_at取北京时间范围；页面消费由W4-18交付。
        link: {
          route: "finance.payments",
          params: { successFrom: bizDate, successTo: bizDate, channel: "bank_transfer" },
        },
        createdAt: at,
        updatedAt: at,
      },
    });
    await addDelivery(tx, { notificationId, channel: "inbox", now: at });
    created++;
  }
  return { status: "sent", recipients: recipients.length, created };
}
