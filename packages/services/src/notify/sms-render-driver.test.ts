import { createServer } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { afterEach, expect, it } from "vitest";
import { createTencentSms } from "../providers/sms/tencent.js";
import type { SmsTemplateBinding } from "../providers/types.js";
import { SMS_TODO_ITEMS } from "../providers/types.js";
import type { NotifyFact } from "./context.js";
import { renderSms } from "./render.js";

const phone = "13800138000";
const fact: NotifyFact = {
  bizType: "delivery_ticket",
  bizId: "00000000-0000-4000-8000-000000000001",
  entityId: null,
  storeId: null,
  status: "delivered",
  version: 1,
  name: "虚构合法成片",
};
const template: SmsTemplateBinding = {
  templateKey: "generic_todo",
  kind: "notice",
  status: "active",
  providerTemplateId: "1234",
  signName: "测试平台",
  params: [{ name: "item", maxLen: 12 }],
};
let server: Server | undefined;
const sockets = new Set<Socket>();
afterEach(async () => {
  const closed = Promise.all(
    [...sockets].map((socket) => new Promise<void>((resolve) => socket.once("close", resolve))),
  );
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  await closed;
  server = undefined;
  expect(sockets.size).toBe(0);
});

it("实际成片场景经render与真实Tencent驱动只发送固定事项，显示名不成为报备变量", async () => {
  const bodies: unknown[] = [];
  server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        Response: {
          RequestId: "request-fictional",
          SendStatusSet: [
            { PhoneNumber: `+86${phone}`, Code: "Ok", SerialNo: "receipt-fictional" },
          ],
        },
      }),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("测试HTTP未就绪");
  const sms = createTencentSms({
    config: {
      secretId: "AKIDEXAMPLE",
      secretKey: "SECRETKEYEXAMPLE",
      sdkAppId: "1400006666",
      region: "ap-guangzhou",
    },
    getTemplate: async () => template,
    fetch: (url, init) => {
      expect(url).toBe("https://sms.tencentcloudapi.com/");
      return fetch(`http://127.0.0.1:${address.port}/`, init);
    },
  });
  // Test-first optional context: current JS ignores it and rejects the free display name.
  const params = renderSms("generic_todo", template.params, fact, "成片已交付", "m.delivered");
  expect(params).not.toBeNull();
  const result = await sms.sendSubscribeFallback({
    phone,
    templateKey: "generic_todo",
    params: params!,
  });
  expect(result).toMatchObject({ ok: true, providerMsgId: "receipt-fictional" });
  expect(bodies).toEqual([expect.objectContaining({ TemplateParamSet: ["成片交付"] })]);
  expect(
    renderSms("generic_todo", template.params, fact, "成片交付", "m.unknown_future"),
  ).toBeNull();
  expect(
    renderSms("generic_todo", [{ name: "item", maxLen: 3 }], fact, "成片交付", "m.delivered"),
  ).toBeNull();
  expect(bodies).toHaveLength(1);
});

it.each([
  ["m.pay_success", "付款成功"],
  ["m.order_submitted", "订购成功"],
  ["m.plan_pending", "方案确认"],
  ["m.delivered", "成片交付"],
  ["m.verify_result", "上线确认"],
  ["m.ticket_reply", "工单回复"],
  ["m.invoice_issued", "发票开具"],
  ["m.points_changed", "积分变动"],
  ["m.member_changed", "成员变动"],
  ["m.asset_feedback", "素材反馈"],
  ["m.refund_result", "退款结果"],
])("实际generic绑定%s仅输出固定事项%s", (sceneKey, item) => {
  expect(
    renderSms("generic_todo", template.params, fact, "不可当变量的自由名称", sceneKey),
  ).toEqual({ item });
  expect(SMS_TODO_ITEMS.some((allowed) => allowed === item)).toBe(true);
});
