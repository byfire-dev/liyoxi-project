import { InstantSchema, openEnum, orNull } from "../../common/index.js";
import { z } from "../../zod.js";

export const NotifySettingListResultSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      slotKey: z.string(),
      title: z.string(),
      sceneNames: z.array(z.string()),
      tmplId: orNull(z.string()),
      state: openEnum(["on", "off", "rejected", "banned", "unavailable"]),
      estRemaining: z.int().nonnegative(),
      lastAcceptAt: orNull(InstantSchema),
    }),
  ),
  cooldownDays: z.int().min(7).max(30),
  maxPerAsk: z.int().min(1).max(5),
});
export type NotifySettingListResult = z.infer<typeof NotifySettingListResultSchema>;
