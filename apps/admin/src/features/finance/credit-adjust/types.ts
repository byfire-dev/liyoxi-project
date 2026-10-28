import type {
  PointAdjustmentRequestDetailSchema,
  TermExtensionRequestDetailSchema,
  z,
} from "@liyoxi/contract";

export type AdjustmentCase =
  | { kind: "points_adjust"; row: z.infer<typeof PointAdjustmentRequestDetailSchema> }
  | { kind: "subscription_extend"; row: z.infer<typeof TermExtensionRequestDetailSchema> };
export type AdjustmentKind = AdjustmentCase["kind"];
export type Decision = "approve" | "reject" | "withdraw";
