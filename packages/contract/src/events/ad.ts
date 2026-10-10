// x01 §3.5；实际退回口径见 d3-flow:376 与 a05 §3.15。
import { IdSchema } from "../common/index.js";
import { z } from "../zod.js";

export const adCancelledPayload = z.strictObject({
  v: z.literal(1),
  adId: IdSchema,
  cancelRequestId: IdSchema,
  /** 本次账本实际回到原批次与转为加购之和。业务行仍分别保存三个实际数量。 */
  returnedPoints: z.int().nonnegative(),
  forfeitedPoints: z.int().nonnegative(),
  fromState: z.enum(["pending_assign", "producing", "revising", "pending_confirm", "returned"]),
  toState: z.literal("cancelled"),
  transition: z.literal("ad.cancel"),
});

export const payloads = { "ad.cancelled": adCancelledPayload } as const;
