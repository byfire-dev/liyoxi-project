import { beforeAll, expect, it } from "vitest";
import { createConfig } from "../config/index.js";
import { uuidv7 } from "../kernel/index.js";
import { assembleForTest, useSeededDatabase } from "../testing/index.js";
import { buildHarness } from "./__fixtures__/harness.js";
import type { Harness } from "./__fixtures__/harness.js";
import { bootstrap } from "./bootstrap.js";

const db = useSeededDatabase("services");
let h: Harness;
beforeAll(async () => {
  h = await buildHarness(await db.prisma());
}, 120_000);

it("引导真实读取与通知设置共用参数，未来修订到点切换；匿名不产生个人写入", async () => {
  const staff = await h.make.staff();
  const now = h.clock.now();
  const config = () => createConfig({ db: h.prisma, clock: h.clock, redis: null });
  const query = async (value: ReturnType<typeof config>) =>
    bootstrap(
      { ...h, config: value, assembly: assembleForTest({ entry: "api" }) },
      {
        merchantUserId: null,
        storeId: null,
        platform: "android",
        clientVersion: "1.0.0",
        envVersion: "develop",
      },
    );
  const defaults = await query(config());
  expect(defaults).toMatchObject({ subscribeCooldownDays: 7, subscribeMaxPerAsk: 3 });
  expect(defaults.degraded).not.toContain("flags");
  const later = new Date(now.getTime() + 1_000);
  for (const [key, value] of [
    ["notify.wx.ask_cooldown_days", 14],
    ["notify.wx.max_per_ask", 5],
  ] as const) {
    await h.prisma.paramValue.create({
      data: {
        id: uuidv7(),
        key,
        value,
        effectiveAt: later,
        createdByStaffId: staff.id,
        createdAt: now,
      },
    });
  }
  const liveConfig = config();
  expect(await query(liveConfig)).toMatchObject({
    subscribeCooldownDays: 7,
    subscribeMaxPerAsk: 3,
  });
  const before = await Promise.all([
    h.prisma.paramValue.count(),
    h.prisma.merchantUser.count(),
    h.prisma.userSession.count(),
    h.prisma.wxSubscribeQuota.count(),
  ]);
  h.clock.advance(1_000);
  const changed = await query(liveConfig);
  expect(changed).toMatchObject({ subscribeCooldownDays: 14, subscribeMaxPerAsk: 5 });
  expect(changed.degraded).not.toContain("flags");
  expect(
    await Promise.all([
      h.prisma.paramValue.count(),
      h.prisma.merchantUser.count(),
      h.prisma.userSession.count(),
      h.prisma.wxSubscribeQuota.count(),
    ]),
  ).toEqual(before);
});
