import { expect, it, vi } from "vitest";
import { createPublishIntent } from "./publish-write";
import { PublishFailure } from "./publish-api";
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
it("同步双击只写一次，关闭后迟到结果不提交给新目标", async () => {
  const intent = createPublishIntent(() => "same"),
    pending = deferred<number>();
  const send = vi.fn(() => pending.promise),
    read = vi.fn(async () => 2);
  const first = intent.run({ id: "old" }, send, read);
  expect(await intent.run({ id: "old" }, send, read)).toBeNull();
  intent.close();
  intent.activate();
  pending.resolve(1);
  expect(await first).toBeNull();
  expect(read).not.toHaveBeenCalled();
  expect(
    await intent.run(
      { id: "new" },
      async () => 3,
      async (_signal, value) => value,
    ),
  ).toEqual({ value: 3 });
  expect(send).toHaveBeenCalledTimes(1);
});
it("未知写结果保原key和原输入；已接受写的读回失败只重试GET", async () => {
  let key = 0;
  const intent = createPublishIntent(() => `key-${++key}`);
  const send = vi
    .fn<(_key: string, signal: AbortSignal) => Promise<number>>()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValue(7);
  const read = vi
    .fn<(_signal: AbortSignal, value: number) => Promise<number>>()
    .mockRejectedValueOnce(new Error("GET failed"))
    .mockImplementation(async (_signal, value) => value);
  await expect(intent.run({ body: 1 }, send, read)).rejects.toThrow("network");
  await expect(intent.run({ body: 2 }, send, read)).rejects.toThrow("原操作");
  await expect(intent.run({ body: 1 }, send, read)).rejects.toThrow("GET failed");
  expect(intent.phase).toBe("accepted");
  expect(await intent.run({ body: 1 }, send, read)).toEqual({ value: 7 });
  expect(send.mock.calls.map(([value]) => value)).toEqual(["key-1", "key-1"]);
  expect(read).toHaveBeenCalledTimes(2);
  await intent.run({ body: 1 }, send, read);
  expect(send.mock.calls.at(-1)?.[0]).toBe("key-2");
});
it("409冻结意图，显式刷新重确认后才可换key", async () => {
  let key = 0;
  const intent = createPublishIntent(() => `key-${++key}`);
  const send = vi
    .fn()
    .mockRejectedValueOnce(new PublishFailure("changed", "VERSION_CONFLICT", 409))
    .mockResolvedValue({});
  await expect(intent.run({ version: 1 }, send, async () => 1)).rejects.toThrow("changed");
  await expect(intent.run({ version: 1 }, send, async () => 1)).rejects.toThrow("重新确认");
  intent.reset();
  expect(await intent.run({ version: 2 }, send, async () => 2)).toEqual({ value: 2 });
  expect(send.mock.calls.map(([value]) => value)).toEqual(["key-1", "key-2"]);
});
