// notify 的种子（W0-21）：订阅槽位、短信模板、通知场景。场景的键、受众、显示名取契约的 NOTIFY_SCENES，
// 注册表里每个键在库里必须有一行（13 分组 第 2.1 节）；通道绑定在 seed-data.ts。
// 没有才插：后台改过的开关与补发策略都留着。槽位与模板先于场景（场景有外键指向它们）。
import { NOTIFY_SCENES } from "@liyoxi/contract";
import type { NotifySceneDef } from "@liyoxi/contract";
import { Prisma } from "@liyoxi/db";

import { defineSeed, insertMissing } from "../kernel/index.js";

import { sceneBindingOf, SMS_TEMPLATE_SEEDS, WX_TEMPLATE_SLOT_SEEDS } from "./seed-data.js";

export const seed = defineSeed("notify", async (tx, { now }) => [
  await insertMissing({
    table: "wx_template_slot",
    rows: WX_TEMPLATE_SLOT_SEEDS,
    keyOf: (row) => row.slotKey,
    existingKeys: async () =>
      (await tx.wxTemplateSlot.findMany({ select: { slotKey: true } })).map((row) => row.slotKey),
    insert: (missing) =>
      tx.wxTemplateSlot.createMany({
        data: missing.map((row) => ({
          slotKey: row.slotKey,
          title: row.title,
          fields: [],
          status: "unconfigured",
          createdAt: now,
          updatedAt: now,
        })),
      }),
  }),
  await insertMissing({
    table: "sms_template",
    rows: SMS_TEMPLATE_SEEDS,
    keyOf: (row) => row.templateKey,
    existingKeys: async () =>
      (await tx.smsTemplate.findMany({ select: { templateKey: true } })).map(
        (row) => row.templateKey,
      ),
    insert: (missing) =>
      tx.smsTemplate.createMany({
        data: missing.map((row) => ({
          templateKey: row.templateKey,
          kind: row.kind,
          params: [],
          status: "unconfigured",
          createdAt: now,
          updatedAt: now,
        })),
      }),
  }),
  await insertMissing({
    table: "notify_scene",
    rows: NOTIFY_SCENES as readonly NotifySceneDef[],
    keyOf: (row) => row.key,
    existingKeys: async () =>
      (await tx.notifyScene.findMany({ select: { sceneKey: true } })).map((row) => row.sceneKey),
    insert: (missing) =>
      tx.notifyScene.createMany({
        data: missing.map((row) => {
          const binding = sceneBindingOf(row.key);
          return {
            sceneKey: row.key,
            audience: row.audience,
            ...(row.key === "s.wecom_invite" || row.key === "s.receipt_daily_digest"
              ? { extEnabled: false }
              : {}),
            name: row.name,
            wxTemplateSlotKey: binding.wxTemplateSlotKey,
            smsPolicy: binding.smsPolicy,
            smsTemplateKey: binding.smsTemplateKey,
            smsNodes:
              binding.smsNodes === null
                ? Prisma.DbNull
                : (binding.smsNodes as Prisma.InputJsonValue),
            sendWindow: binding.sendWindow,
            collapseWindowSec: binding.collapseWindowSec,
            createdAt: now,
            updatedAt: now,
          };
        }),
      }),
  }),
]);
