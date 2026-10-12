import { z } from "../../zod.js";

const count = z.int().min(0).max(2_147_483_647);
export const EntityCloseBodySchema = z
  .strictObject({
    reasonText: z
      .string()
      .trim()
      .refine((value) => {
        const length = Array.from(value).length;
        return length >= 10 && length <= 200;
      }, "原因须为10至200字"),
    confirm: z.strictObject({ activeStoreCount: count, activeMemberCount: count }),
  })
  .openapi("EntityCloseBody");
export type EntityCloseBody = z.infer<typeof EntityCloseBodySchema>;
