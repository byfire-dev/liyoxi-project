import { rowKey } from "../flow/index.js";
import type { MachineBinding } from "../flow/index.js";
import type { Ad } from "@liyoxi/db";
import type { Tx, IdentityContext } from "../kernel/index.js";
import { AppError, lockRows } from "../kernel/index.js";
import { paramsAt } from "../config/index.js";
import { workHoursAt } from "../sla/index.js";
import { timerKey } from "../timers/index.js";
import type { AdActor, AdWriteDeps } from "./context.js";

const passes = new WeakSet<object>();
function checked() {
  const pass = Object.freeze({});
  passes.add(pass);
  return pass;
}
const rows = [
  ["09:801", "ad.submit"],
  ["09:802", "ad.assign"],
  ["09:803", "ad.return"],
  ["09:804", "ad.resubmit"],
  ["09:805", "ad.push_version"],
  ["09:806", "ad.confirm"],
  ["09:807", "ad.request_revision"],
] as const;
export const adLifecycleBinding: MachineBinding = {
  companions: [
    "editor_id",
    "captured_at",
    "returned_from",
    "returned_at",
    "return_reason",
    "resubmit_count",
    "first_due_at",
    "due_at",
    "sla_snapshot",
    "revision_count",
    "confirmed_version_no",
    "confirmed_at",
  ],
  guards: Object.fromEntries(
    rows.map(([ref, event]) => [
      rowKey(ref, event),
      async (_tx, facts) =>
        typeof facts.args === "object" && facts.args !== null && passes.has(facts.args),
    ]),
  ),
};
export function owner(actor: AdActor) {
  if (actor.ctx.actor.type !== "merchant" || actor.membership.role !== "owner")
    throw new AppError("ROLE_FORBIDDEN");
  if (actor.membership.storeMode === "archived") throw new AppError("STORE_ARCHIVED");
}
export async function member(tx: Tx, actor: AdActor, lock = false) {
  owner(actor);
  if (lock) await lockRows(tx, "entity_member", [actor.membership.memberId]);
  const m = await tx.entityMember.findFirst({
    where: {
      id: actor.membership.memberId,
      entityId: actor.membership.entityId,
      merchantUserId: actor.ctx.actor.id!,
      status: "active",
      role: "owner",
    },
  });
  if (!m) throw new AppError("NOT_A_MEMBER");
  const store = await tx.store.findFirst({
    where: { id: actor.membership.storeId, entityId: actor.membership.entityId },
  });
  if (!store) throw new AppError("NOT_FOUND");
  if (store.lifecycle !== "active") throw new AppError("STORE_ARCHIVED");
  const entity = await tx.entity.findUnique({
    where: { id: actor.membership.entityId },
    select: { lifecycle: true },
  });
  if (!entity || entity.lifecycle !== "active") throw new AppError("STORE_ARCHIVED");
  return m;
}
export async function merchantAd(tx: Tx, actor: AdActor, id: string) {
  owner(actor);
  const ad = await tx.ad.findFirst({
    where: { id, entityId: actor.membership.entityId, storeId: actor.membership.storeId },
  });
  if (!ad) throw new AppError("NOT_FOUND");
  return ad;
}
export function noCancel(ad: Ad) {
  if (ad.openCancelRequestId) throw new AppError("AD_CANCEL_IN_PROGRESS");
}
export async function adDue(
  tx: Tx,
  deps: AdWriteDeps,
  kind: "first_version" | "revision",
  from: Date,
) {
  const key = kind === "first_version" ? "sla.ad.first_version" : "sla.ad.revision",
    policy = (await paramsAt(tx, [key], from))[key];
  return deps.sla.dueAt(tx, {
    policy: `ad.${kind}`,
    amount: policy.amount,
    unit: policy.unit,
    from,
    workHours: await workHoursAt(tx, from),
  });
}
export async function armAdDue(
  tx: Tx,
  deps: AdWriteDeps,
  ad: Pick<Ad, "id" | "entityId" | "storeId">,
  purpose: "first" | "rev",
  round: number,
  due: Awaited<ReturnType<typeof adDue>>,
) {
  await deps.timers.arm(tx, {
    kind: "sla.breach",
    subject: { type: "ad", id: ad.id },
    key: timerKey("sla.breach", { type: "ad", id: ad.id }, `${purpose}:${round}`),
    fireAt: due.dueAt,
    entityId: ad.entityId,
    storeId: ad.storeId,
    payload: { ...due.snapshot },
  });
}
/** Actual audit requires three segments; the merchant timeline projects these rows back to the frozen ad.* names. */
export async function moveAd(
  tx: Tx,
  deps: Pick<AdWriteDeps, "flow">,
  ctx: IdentityContext,
  ad: Pick<Ad, "id" | "entityId" | "storeId">,
  event: (typeof rows)[number][1],
  ref: (typeof rows)[number][0],
  set: Record<string, unknown>,
  emission: { type: string; payload: Record<string, unknown> },
  meta: { versionNo?: number; revisionNo?: number; reasonText?: string } = {},
  to?: string,
  created = false,
) {
  const { reasonText, ...publicMeta } = meta;
  return deps.flow.transition(tx, ctx, {
    machine: "ad",
    stateField: "status",
    id: ad.id,
    event,
    ref,
    to,
    created,
    entityId: ad.entityId,
    storeId: ad.storeId,
    args: checked(),
    set,
    payload: publicMeta,
    audit: {
      stream: ctx.actor.type === "staff" ? "ops" : "activity",
      category: "delivery",
      action: `ad.status.${event.slice(3)}` as `ad.status.${string}`,
      summary: {
        "ad.submit": "提交广告制作需求",
        "ad.assign": "指派广告剪辑师",
        "ad.return": "退回补充广告素材",
        "ad.resubmit": "重新提交广告素材",
        "ad.push_version": "推送广告版本",
        "ad.confirm": "确认广告版本",
        "ad.request_revision": "提出广告修改意见",
      }[event],
      target: { type: "ad", id: ad.id },
      entityId: ad.entityId,
      storeId: ad.storeId,
      meta: publicMeta,
      ...(reasonText ? { reason: { code: "other", text: reasonText } } : {}),
    },
    emit: emission,
  });
}
