import { adminClientErrorCreate } from "@liyoxi/contract";
import { AppError } from "@liyoxi/services";
import { defineHandler } from "../../routing/define.js";
export const adminClientErrorHandlers = [
  defineHandler(adminClientErrorCreate, async (c) => {
    if (
      c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/x-sentry-envelope"
    )
      throw new AppError("VALIDATION_FAILED");
    c.var.runtime.clientErrors.accept(new Uint8Array(await c.req.arrayBuffer()));
    return c.json({ code: 0 as const, message: "ok" as const, data: null }, 202);
  }),
];
