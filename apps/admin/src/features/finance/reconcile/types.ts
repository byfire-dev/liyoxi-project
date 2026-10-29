import type {
  PaymentExceptionDetailSchema,
  PaymentExceptionResolveBody,
  PaymentExceptionRowSchema,
  ReconDayRow,
} from "@liyoxi/contract";
export type ExceptionRow = ReturnType<typeof PaymentExceptionRowSchema.parse>;
export type ExceptionDetail = ReturnType<typeof PaymentExceptionDetailSchema.parse>;
export type Resolution = PaymentExceptionResolveBody["resolution"];
export type ReconCommand = "create" | "rerun" | "resolve";
export type RerunTarget = ReconDayRow & { reconciliationId: string };
