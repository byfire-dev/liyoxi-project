import { z } from "zod";
import { IdSchema } from "@liyoxi/contract";
import { AppError, notifyReadOf, uuidv7 } from "../kernel/index.js";
import type { AlertSeverity, Assembly, Tx } from "../kernel/index.js";

export const SYSTEM_ALERT_SCENE = "s.system_alert";
export interface SystemAlertInput {
  readonly alertId: string;
  readonly fingerprint: string;
  readonly severity: AlertSeverity;
  readonly recovered: boolean;
  /** 相同发送意图始终复用代次，恢复与告警有各自的去重空间。 */
  readonly noticeNo: number;
  readonly at: Date;
}
export interface SystemAlertResult {
  readonly status: "sent" | "disabled" | "no_recipients";
  readonly recipients: number;
  readonly created: number;
}
const Input = z.strictObject({
  alertId: IdSchema,
  fingerprint: z
    .string()
    .min(1)
    .max(320)
    .regex(/^[a-zA-Z0-9_.:/-]+$/u),
  severity: z.enum(["P1", "P2", "P3"]),
  recovered: z.boolean(),
  noticeNo: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  at: z.date(),
});

/** caller同事务写铃铛；接收人由staff已登记的只读公口确定，不造会话或外呼。 */
export async function sendSystemAlert(
  tx: Tx,
  raw: SystemAlertInput,
  assembly: Assembly,
): Promise<SystemAlertResult> {
  const input = Input.parse(raw);
  const scene = await tx.notifyScene.findUnique({ where: { sceneKey: SYSTEM_ALERT_SCENE } });
  if (!scene || scene.audience !== "staff")
    throw new AppError("INTERNAL", { message: "系统告警场景尚未正确登记" });
  if (!scene.sceneEnabled) return { status: "disabled", recipients: 0, created: 0 };
  // 仅付款差异专用规则增加财务；研发/运维仍走既有P1机器人与oncall通道，其他系统告警受众不变。
  const paymentException = /^billing\.payment_exception:(open|critical|overdue)$/.test(
    input.fingerprint,
  );
  const roles = paymentException ? ["super_admin", "finance"] : ["super_admin"];
  const found = (
    await Promise.all(
      roles.map((roleKey) =>
        notifyReadOf(assembly).read<string[]>(tx, "activeStaffForNotify", { roleKey }),
      ),
    )
  ).flat();
  const recipients = [...new Set(z.array(IdSchema).parse(found))].sort();
  if (!recipients.length) return { status: "no_recipients", recipients: 0, created: 0 };
  let created = 0;
  for (const staffId of recipients) {
    const notificationId = uuidv7();
    const inserted = await tx.notification.createMany({
      skipDuplicates: true,
      data: [
        {
          id: notificationId,
          notifySceneKey: SYSTEM_ALERT_SCENE,
          dedupeKey: `alert:${input.alertId}:${input.recovered ? "recovered" : "open"}:${input.noticeNo}:N0:${staffId}`,
          bizType: "alert_event",
          bizId: input.alertId,
          node: "N0",
          staffId,
          vars: {
            alertId: input.alertId,
            fingerprint: input.fingerprint,
            severity: input.severity,
            recovered: input.recovered,
          },
          createdAt: input.at,
        },
      ],
    });
    if (!inserted.count) continue;
    await tx.staffMessage.create({
      data: {
        id: uuidv7(),
        notificationId,
        staffId,
        kind: "alert",
        title: input.recovered ? "系统告警已恢复" : `系统告警 ${input.severity}`,
        body: `${input.recovered ? "已恢复" : "待处理"}：${input.fingerprint}`.slice(0, 200),
        link: {
          route: paymentException ? "/finance/reconcile" : "/sys/health",
          params: { alertId: input.alertId },
        },
        createdAt: input.at,
        updatedAt: input.at,
      },
    });
    await tx.notificationDelivery.create({
      data: {
        id: uuidv7(),
        notificationId,
        channel: "inbox",
        origin: "primary",
        status: "sent",
        dueAt: input.at,
        sentAt: input.at,
        finishedAt: input.at,
        createdAt: input.at,
        updatedAt: input.at,
      },
    });
    created++;
  }
  // 相同代次已存在即已接受，0新增不是通道失败。
  return { status: "sent", recipients: recipients.length, created };
}
