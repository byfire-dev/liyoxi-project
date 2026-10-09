import { expect, it } from "vitest";
import { IdSchema } from "../../common/index.js";
import { BannerPageJumpSchema } from "../m04-mall-order/banner.schemas.js";
import {
  MESSAGE_TABS,
  MessageBatchReadBodySchema,
  MessageDeepLinkSchema,
  MessageSummarySchema,
} from "./messages.schemas.js";

const id = IdSchema.parse("01900000-0000-7000-8000-000000000001");
it("17正式路由严格成对参数，拒绝rawURL/额外token/任意路由，保留Banner原结构", () => {
  const sample = { route: "order.detail", params: { orderId: id, storeId: id } };
  expect(MessageDeepLinkSchema.parse(sample)).toEqual(BannerPageJumpSchema.parse(sample));
  for (const route of ["payment.result", "payment.detail"]) {
    expect(MessageDeepLinkSchema.parse({ route, params: { paymentOrderId: id } })).toEqual({
      route,
      params: { paymentOrderId: id },
    });
    expect(MessageDeepLinkSchema.safeParse({ route, params: { billingOrderId: id } }).success).toBe(
      false,
    );
  }
  for (const route of ["points.ledger", "messages.list"])
    expect(MessageDeepLinkSchema.parse({ route, params: {} })).toEqual({ route, params: {} });
  for (const value of [
    { route: "https://example.invalid", params: {} },
    { route: "messages.list", params: { token: "fictional" } },
    { route: "order.detail", params: { orderId: id } },
    { route: "invoice.detail", params: {} },
  ])
    expect(MessageDeepLinkSchema.safeParse(value).success).toBe(false);
});
it("summary严格8tab次序，system分类不形成tab；batch默认all且拒绝未知/多余参数", () => {
  const result = {
    total: 0,
    byTab: MESSAGE_TABS.map((tab) => ({ tab, unreadCount: 0 })),
    byStore: [],
  };
  expect(MessageSummarySchema.parse(result)).toEqual(result);
  expect(MessageSummarySchema.safeParse({ ...result, byTab: result.byTab.slice(1) }).success).toBe(
    false,
  );
  expect(
    MessageSummarySchema.safeParse({ ...result, byTab: [...result.byTab].reverse() }).success,
  ).toBe(false);
  expect(MessageBatchReadBodySchema.parse({ upToMessageId: id })).toEqual({
    upToMessageId: id,
    tab: "all",
  });
  expect(MessageBatchReadBodySchema.safeParse({ upToMessageId: id, tab: "system" }).success).toBe(
    false,
  );
  expect(MessageBatchReadBodySchema.safeParse({ upToMessageId: id, entityId: id }).success).toBe(
    false,
  );
});
