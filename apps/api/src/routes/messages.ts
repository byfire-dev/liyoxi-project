import {
  MessageBatchReadResultSchema,
  MessageListResultSchema,
  MessageReadResultSchema,
  MessageSummarySchema,
  mMessageBatchRead,
  mMessageList,
  mMessageRead,
  mMessageSummary,
} from "@liyoxi/contract";
import { ok } from "../http/errors.js";
import { idemOf } from "../http/idempotency.js";
import { merchantSessionOf } from "../http/merchant-auth.js";
import { defineHandler } from "../routing/define.js";

// 字面段先于参数段；门店请求头交服务检查为 403，不让 header schema 提前改成 400。
export const messageHandlers = [
  defineHandler(mMessageList, async (c) => {
    const actor = {
      merchantUserId: merchantSessionOf(c).merchantUserId,
      storeId: c.req.header("X-Store-Id") ?? null,
    };
    const result = await c.var.runtime.notifyMessages.list(actor, c.req.valid("query"));
    c.header("Cache-Control", "no-store");
    return ok(c, MessageListResultSchema.parse(result));
  }),
  defineHandler(mMessageSummary, async (c) => {
    const actor = {
      merchantUserId: merchantSessionOf(c).merchantUserId,
      storeId: c.req.header("X-Store-Id") ?? null,
    };
    const result = await c.var.runtime.notifyMessages.summary(actor);
    c.header("Cache-Control", "no-store");
    return ok(c, MessageSummarySchema.parse(result));
  }),
  defineHandler(mMessageBatchRead, async (c) => {
    const actor = {
      merchantUserId: merchantSessionOf(c).merchantUserId,
      storeId: c.req.header("X-Store-Id") ?? null,
    };
    const result = await c.var.runtime.notifyMessages.batchRead(actor, c.req.valid("json"), {
      idem: idemOf(c),
    });
    c.header("Cache-Control", "no-store");
    return ok(c, MessageBatchReadResultSchema.parse(result));
  }),
  defineHandler(mMessageRead, async (c) => {
    const actor = {
      merchantUserId: merchantSessionOf(c).merchantUserId,
      storeId: c.req.header("X-Store-Id") ?? null,
    };
    const result = await c.var.runtime.notifyMessages.read(actor, c.req.valid("param").messageId, {
      idem: idemOf(c),
    });
    c.header("Cache-Control", "no-store");
    return ok(c, MessageReadResultSchema.parse(result));
  }),
];
