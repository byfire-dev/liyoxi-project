import { AppError, lockRows, uuidv7 } from "../kernel/index.js";
import type { Tx } from "../kernel/index.js";
import { addDelivery } from "./dispatch.js";

/** a01 §3.24: only the staff inbox; no event or external provider. */
export async function sendStaffWecomInvite(
  tx: Tx,
  input: { staffId: string; invitationKey: string; now: Date },
): Promise<{ created: boolean }> {
  await lockRows(tx, "staff", [input.staffId], "share");
  const staff = await tx.staff.findUnique({
    where: { id: input.staffId },
    select: { status: true, wecomBindStatus: true },
  });
  if (!staff || staff.status !== "active" || staff.wecomBindStatus !== "invited")
    return { created: false };
  const cfg = await tx.notifyScene.findUnique({ where: { sceneKey: "s.wecom_invite" } });
  if (!cfg || cfg.audience !== "staff")
    throw new AppError("INTERNAL", { message: "企业微信邀请通知场景未播种" });
  if (!cfg.sceneEnabled) return { created: false };
  const notificationId = uuidv7();
  const inserted = await tx.notification.createMany({
    skipDuplicates: true,
    data: [
      {
        id: notificationId,
        notifySceneKey: "s.wecom_invite",
        dedupeKey: `s.wecom_invite:${input.invitationKey}:${input.staffId}`,
        node: "N0",
        bizType: "staff",
        bizId: input.staffId,
        staffId: input.staffId,
        vars: { staffId: input.staffId, purpose: "wecom_bind" },
        createdAt: input.now,
      },
    ],
  });
  if (!inserted.count) return { created: false };
  await tx.staffMessage.create({
    data: {
      id: uuidv7(),
      notificationId,
      staffId: input.staffId,
      kind: "system",
      title: "请绑定企业微信",
      body: "请在用户菜单的个人设置中绑定企业微信账号。若暂未提供设置页面，请联系超级管理员代为录入。",
      link: { route: "auth.bindWecom", params: {} },
      createdAt: input.now,
      updatedAt: input.now,
    },
  });
  await addDelivery(tx, { notificationId, channel: "inbox", now: input.now });
  return { created: true };
}
