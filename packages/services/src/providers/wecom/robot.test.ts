import { expect, it, vi } from "vitest";
import { createProviders, createWecomRobot } from "../index.js";
import { createFakeProviders, createRecordingLogger } from "../../testing/index.js";

it("真实机器人协议单次受理、明确拒绝/未知、UTF8上限、取消与独立能力状态", async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('{"errcode":0,"errmsg":"ok"}'));
  const closes: Array<() => Promise<void>> = [];
  const providers = createProviders({
    appEnv: "test",
    logger: createRecordingLogger(),
    settings: { wecomRobot: { key: "public_fake_robot" } },
    wecomRobot: { fetchImpl, registerClose: (close) => closes.push(close) },
  });
  expect(providers.wecom).toMatchObject({
    status: "unconfigured",
    configured: false,
    capabilities: { robot: true },
  });
  const input = { title: "狸有戏", content: "P1测试", mentionAll: true };
  expect(await providers.wecom.sendRobotMessage(input)).toMatchObject({ ok: true });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, request] = fetchImpl.mock.calls[0]!;
  expect(String(url)).toBe(
    "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=public_fake_robot",
  );
  expect(request).toMatchObject({ method: "POST", redirect: "error" });
  expect(JSON.parse(String(request?.body))).toEqual({
    msgtype: "text",
    text: { content: "狸有戏\nP1测试", mentioned_list: ["@all"] },
  });
  fetchImpl.mockResolvedValueOnce(new Response('{"errcode":45009,"errmsg":"private-response"}'));
  expect(await providers.wecom.sendRobotMessage(input)).toMatchObject({
    ok: false,
    notification: { acceptance: "not_accepted" },
  });
  fetchImpl.mockRejectedValueOnce(new Error("private-response"));
  const unknown = await providers.wecom.sendRobotMessage(input);
  expect(unknown).toMatchObject({ ok: false, notification: { acceptance: "unknown" } });
  expect(JSON.stringify(unknown)).not.toContain("private-response");
  fetchImpl.mockClear();
  expect(
    await providers.wecom.sendRobotMessage({ ...input, content: "狸".repeat(684) }),
  ).toMatchObject({ ok: false });
  expect(
    await providers.wecom.sendRobotMessage({ ...input, signal: AbortSignal.abort() }),
  ).toMatchObject({ ok: false, notification: { acceptance: "not_accepted" } });
  expect(fetchImpl).not.toHaveBeenCalled();
  await Promise.all(closes.map((close) => close()));
  const hang = vi.fn<typeof fetch>(
    (_url, request) =>
      new Promise((_, reject) =>
        request!.signal!.addEventListener("abort", () => reject(new Error("cancel")), {
          once: true,
        }),
      ),
  );
  const one = createWecomRobot({ key: "public_fake_robot" }, { fetchImpl: hang });
  const pending = one.sendRobotMessage(input);
  await one.close();
  expect(await pending).toMatchObject({ ok: false });
  expect(await one.sendRobotMessage(input)).toMatchObject({
    ok: false,
    notification: { acceptance: "not_accepted" },
  });
  const fake = createFakeProviders();
  fake.wecom.failNotificationNext("sendRobotMessage", {
    acceptance: "not_accepted",
    code: "provider_rejected",
  });
  expect(await fake.wecom.sendRobotMessage(input)).toMatchObject({
    ok: false,
    notification: { acceptance: "not_accepted" },
  });
  expect(fake.wecom.robotMessages).toHaveLength(0);
  const controller = new AbortController();
  fake.wecom.delayNext("sendRobotMessage", 60_000);
  const delayed = fake.wecom.sendRobotMessage({ ...input, signal: controller.signal });
  expect(fake.wecom.robotMessages).toHaveLength(1);
  controller.abort();
  expect(await delayed).toMatchObject({
    ok: false,
    notification: { acceptance: "unknown", code: "aborted" },
  });
  expect(fake.wecom.pendingCalls()).toBe(0);
  expect(fake.wecom.messages).toHaveLength(0);
});
