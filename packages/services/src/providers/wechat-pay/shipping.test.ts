import { expect, it } from "vitest";
import { createWechatDriver } from "../wechat/driver.js";
import type { WechatShippingInput } from "../types.js";

const input: WechatShippingInput = {
  transactionId: "4200000000000001",
  payerOpenid: "public-fake-openid",
  itemDescription: "狸有戏套餐服务",
  uploadedAt: new Date("2026-01-05T04:00:00.000Z"),
};
function setup(respond: (path: string, init?: RequestInit) => Promise<Response>) {
  const paths: string[] = [];
  const driver = createWechatDriver(
    { appid: "wx0000000000000000", secret: "public-fake-secret", releaseChannel: "trial" },
    {
      now: () => new Date("2026-01-05T04:00:00.000Z"),
      cache: { get: async () => null, put: async () => {}, deleteIfValue: async () => {} },
      fetchImpl: async (target, init) => {
        const url = new URL(target instanceof Request ? target.url : String(target));
        expect(url.origin).toBe("https://api.weixin.qq.com");
        paths.push(url.pathname);
        if (url.pathname === "/cgi-bin/stable_token")
          return Response.json({ access_token: "public-token", expires_in: 7200 });
        expect(url.searchParams.get("access_token")).toBe("public-token");
        expect(new Headers(init?.headers).has("Authorization")).toBe(false);
        return respond(url.pathname, init);
      },
    },
  );
  return { ...driver, paths };
}
const order = (shipping: unknown = null) => ({
  errcode: 0,
  order: {
    transaction_id: input.transactionId,
    merchant_trade_no: "TFK202601050001",
    merchant_id: "1900000109",
    openid: input.payerOpenid,
    paid_amount: 1,
    order_state: shipping === null ? 1 : 2,
    ...(shipping === null ? {} : { shipping }),
  },
});

it("官方小程序发货/查单走共享access_token，固定虚拟统一发货与有限事实投影", async () => {
  let shipped = false;
  const h = setup(async (path, init) => {
    expect(init?.method).toBe("POST");
    if (path === "/wxa/sec/order/upload_shipping_info") {
      expect(JSON.parse(String(init?.body))).toEqual({
        order_key: { order_number_type: 2, transaction_id: input.transactionId },
        logistics_type: 3,
        delivery_mode: 1,
        shipping_list: [{ item_desc: input.itemDescription }],
        upload_time: input.uploadedAt.toISOString(),
        payer: { openid: input.payerOpenid },
      });
      shipped = true;
      return Response.json({ errcode: 0, errmsg: "ok" });
    }
    expect(path).toBe("/wxa/sec/order/get_order");
    expect(JSON.parse(String(init?.body))).toEqual({ transaction_id: input.transactionId });
    return Response.json(
      order(
        shipped
          ? {
              logistics_type: 3,
              delivery_mode: 1,
              finish_shipping: true,
              shipping_list: [{ goods_desc: input.itemDescription, upload_time: 1767585600 }],
            }
          : null,
      ),
    );
  });
  try {
    expect(
      await h.provider.queryShippingInfo!({ transactionId: input.transactionId }),
    ).toMatchObject({ ok: true, value: { state: 1, shipping: null } });
    expect(await h.provider.uploadShippingInfo!(input)).toEqual({ ok: true, value: undefined });
    expect(await h.provider.queryShippingInfo!({ transactionId: input.transactionId })).toEqual({
      ok: true,
      value: {
        transactionId: input.transactionId,
        outTradeNo: "TFK202601050001",
        mchid: "1900000109",
        payerOpenid: input.payerOpenid,
        amountFen: 1,
        state: 2,
        shipping: {
          logisticsType: 3,
          deliveryMode: 1,
          finished: true,
          items: [{ description: input.itemDescription, uploadedAtSec: 1767585600 }],
        },
      },
    });
    expect(h.paths).toEqual([
      "/cgi-bin/stable_token",
      "/wxa/sec/order/get_order",
      "/wxa/sec/order/upload_shipping_info",
      "/wxa/sec/order/get_order",
    ]);
  } finally {
    await h.close();
  }
});

it("发货断连是受理未知，完整平台拒绝才未受理；不在Provider内部重送", async () => {
  for (const explicit of [false, true]) {
    const h = setup(async () => {
      if (!explicit) throw new Error("公开测试断连");
      return Response.json({ errcode: 10060031, errmsg: "public-marker-not-for-output" });
    });
    try {
      const result = await h.provider.uploadShippingInfo!(input);
      expect(result).toMatchObject({
        ok: false,
        acceptance: explicit ? "not_accepted" : "unknown",
      });
      expect(h.paths.filter((path) => path.endsWith("upload_shipping_info"))).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("public-marker-not-for-output");
      expect(JSON.stringify(result)).not.toContain(input.payerOpenid);
    } finally {
      await h.close();
    }
  }
});

it("不完整查单事实拒收；非法上传和调用前取消零HTTP", async () => {
  const h = setup(async () =>
    Response.json({ errcode: 0, order: { transaction_id: input.transactionId } }),
  );
  try {
    expect(
      await h.provider.queryShippingInfo!({ transactionId: input.transactionId }),
    ).toMatchObject({ ok: false, reason: "unavailable" });
    const before = h.paths.length;
    const abort = new AbortController();
    abort.abort();
    for (const patch of [
      { uploadedAt: new Date(Number.NaN) },
      { itemDescription: "字".repeat(121) },
      { signal: abort.signal },
    ])
      expect(await h.provider.uploadShippingInfo!({ ...input, ...patch })).toMatchObject({
        ok: false,
        acceptance: "not_accepted",
      });
    expect(h.paths).toHaveLength(before);
  } finally {
    await h.close();
  }
});
