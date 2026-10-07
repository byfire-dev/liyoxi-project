// 仅本包测试的已验签协议/最小载荷替身；不注册生产hook。
import type { PrismaClient } from "@liyoxi/db";
import type { createWebhooks } from "../../index.js";
import type { VerifiedWebhook, WebhookProvider, WebhookSource } from "../../index.js";
import type { Tx } from "../../../kernel/index.js";
export const write = (tx: Tx, prefix: string) =>
  tx.bizSequence.upsert({
    where: { prefix_bizDate: { prefix, bizDate: new Date("2026-01-05") } },
    create: { prefix, bizDate: new Date("2026-01-05"), nextVal: 1 },
    update: { nextVal: { increment: 1 } },
  });
export const count = async (prisma: PrismaClient, prefix: string) =>
  (await prisma.bizSequence.findFirst({ where: { prefix } }))?.nextVal ?? 0;
export const source = (prefix: string, overrides: Partial<WebhookSource> = {}): WebhookSource => ({
  provider: "wecom",
  mode: "inbox",
  verify: async (input) => ({
    kind: "event",
    event: JSON.parse(Buffer.from(input.rawBody).toString()) as VerifiedWebhook,
  }),
  payload: (event) => ({ value: event.data }),
  restore: async (row) => row.payload?.["value"] ?? null,
  handle: async (tx) => {
    await write(tx, prefix);
    return "processed";
  },
  reply: (ok, error) => ({
    kind: "reply",
    status: ok ? 200 : 500,
    body: ok ? "success" : `failure:${error}`,
  }),
  ...overrides,
});
export const prepare = async (
  hooks: ReturnType<typeof createWebhooks>,
  eventId: string,
  provider: WebhookProvider = "wecom",
  extras: Partial<VerifiedWebhook> = {},
) => {
  const receipt = await hooks.prepare(provider, {
    method: "POST",
    operationId: "lyxtest.webhook",
    headers: {},
    rawBody: Buffer.from(
      JSON.stringify({ eventId, eventType: "fixture.received", data: "known", ...extras }),
    ),
  });
  if (receipt.kind !== "ready") throw new Error(`fixture 未通过: ${receipt.body}`);
  return receipt;
};
