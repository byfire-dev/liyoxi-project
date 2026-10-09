import { createPrismaClient } from "@liyoxi/db";
import type { PrismaClient } from "@liyoxi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTxRunner, detach } from "../kernel/index.js";
import type { TxRunner } from "../kernel/index.js";
import { createFakeProviders, useTestDatabase } from "../testing/index.js";

const db = useTestDatabase("services");
let prisma: PrismaClient;
let tx: TxRunner;
beforeAll(async () => {
  prisma = createPrismaClient({ connectionString: await db.url(), max: 2 });
  tx = createTxRunner({ prisma, appEnv: "test" });
});
afterAll(async () => {
  await prisma?.$disconnect();
});

type Fakes = ReturnType<typeof createFakeProviders>;
const senders: Array<{ name: string; send(fakes: Fakes, signal: AbortSignal): Promise<unknown> }> =
  [
    {
      name: "wechat.sendSubscribeMessage",
      send: (f, signal) =>
        f.wechat.sendSubscribeMessage({
          openid: "fake-openid",
          templateId: "fake-template",
          data: {},
          signal,
        }),
    },
    {
      name: "sms.sendActivationCode",
      send: (f, signal) =>
        f.sms.sendActivationCode({ phone: "13800138000", code: "TEST1234", signal }),
    },
    {
      name: "sms.sendSubscribeFallback",
      send: (f, signal) =>
        f.sms.sendSubscribeFallback({
          phone: "13800138000",
          templateKey: "generic_todo",
          params: {},
          signal,
        }),
    },
    {
      name: "sms.sendOncallAlert",
      send: (f, signal) =>
        f.sms.sendOncallAlert({
          phones: ["13800138000"],
          title: "假告警",
          content: "假摘要",
          signal,
        }),
    },
    {
      name: "wecom.sendAppMessage",
      send: (f, signal) =>
        f.wecom.sendAppMessage({
          toUser: "fake-user",
          title: "假待办",
          description: "假摘要",
          signal,
        }),
    },
    {
      name: "mail.send",
      send: (f, signal) =>
        f.mail.send({ to: "fake@example.invalid", subject: "假主题", text: "假正文", signal }),
    },
  ];
const calls = (f: Fakes) =>
  f.sms.calls.length + f.wechat.calls.length + f.wecom.calls.length + f.mail.calls.length;

describe("六个通知方法：真实TX与祖先TX guard先于预取消", () => {
  it.each(senders)("$name", async ({ send }) => {
    const fakes = createFakeProviders();
    const controller = new AbortController();
    controller.abort(new Error("不应回显的取消原因"));
    await tx.run(async (handle) => {
      expect(await handle.$queryRaw<Array<{ one: number }>>`SELECT 1::integer AS one`).toEqual([
        { one: 1 },
      ]);
      await expect(send(fakes, controller.signal)).rejects.toMatchObject({
        kind: "external_call_in_transaction",
      });
      await detach(async () => {
        await expect(send(fakes, controller.signal)).rejects.toMatchObject({
          kind: "external_call_in_transaction",
        });
        await detach(async () => {
          await expect(send(fakes, controller.signal)).rejects.toMatchObject({
            kind: "external_call_in_transaction",
          });
        });
      });
      expect(calls(fakes)).toBe(0);
    });
    await expect(send(fakes, controller.signal)).resolves.toMatchObject({
      notification: { acceptance: "not_accepted", code: "aborted" },
    });
    expect(calls(fakes)).toBe(1);
    expect(
      fakes.sms.sent.length +
        fakes.wechat.subscribeMessages.length +
        fakes.wecom.messages.length +
        fakes.mail.outbox.length,
    ).toBe(0);
  });

  it("保留prod报告后继续政策；预取消不跳过实际guard报告", async () => {
    const reported: unknown[] = [];
    const prodTx = createTxRunner({
      prisma,
      appEnv: "prod",
      report: (v) => {
        reported.push(v);
      },
    });
    const fakes = createFakeProviders();
    const controller = new AbortController();
    controller.abort();
    await prodTx.run(async () => {
      await expect(senders[0]!.send(fakes, controller.signal)).resolves.toMatchObject({
        notification: { acceptance: "not_accepted" },
      });
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ kind: "external_call_in_transaction" });
    expect(fakes.wechat.subscribeMessages).toHaveLength(0);
  });
});
