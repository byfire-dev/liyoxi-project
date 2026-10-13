import { MeViewSchema, UserNoticeAckResultSchema } from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "@liyoxi/services";
import { beforeAll, describe, expect, it } from "vitest";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
let api: TestApi;
let db: Awaited<ReturnType<typeof handle.db.prisma>>;
beforeAll(async () => {
  api = await handle.start();
  db = await handle.db.prisma();
  await seedUserAgreements(handle, api);
}, 180_000);

describe(
  "identity.onWechatBound 登录→m.me.get→m.me.userNotice.acknowledge",
  { timeout: 120_000 },
  () => {
    it("真实新微信登录经正式注册处理器生成提示，GET脱敏且关闭后重投不重新展示", async () => {
      const who = await signInAsMerchant(api);
      await merchantServicesOf(api.runtime).tenant.createEntity(
        createIdentityContext({
          actor: { type: "merchant", id: who.merchantUserId, client: "weapp" },
        }),
      );
      const device = await signInAsMerchant(api, { phone: who.phone });
      expect(device.merchantUserId).toBe(who.merchantUserId);
      const source = await db.outboxEvent.findFirstOrThrow({
        where: { eventType: "merchant_user.wechat_bound", aggregateId: who.merchantUserId },
      });
      const subscriber = api.runtime.events.subscribers.get("identity.onWechatBound");
      if (!subscriber) throw new Error("运行时未装配正式身份订阅者");
      const message = {
        id: source.id,
        type: source.eventType,
        payload: source.payload as Record<string, unknown>,
      };
      api.clock.advance(3600000);
      await api.runtime.tx.run((tx) => subscriber.handle(tx, message));
      const me = await api.request("/api/v1/m/me", { headers: who.headers });
      expect(me.status, await me.clone().text()).toBe(200);
      expect(me.headers.get("Cache-Control")).toBe("no-store");
      const view = MeViewSchema.parse(((await me.json()) as { data: unknown }).data);
      expect(view.notices).toEqual([
        expect.objectContaining({
          userNoticeId: source.id,
          kind: "new_wechat_bound",
          occurredAt: source.occurredAt.toISOString(),
        }),
      ]);
      expect(JSON.stringify(view.notices)).not.toMatch(/openid|wechatIdentityId|phoneEnc|payload/);
      const ack = await api.request(`/api/v1/m/me/user-notices/${source.id}/acknowledge`, {
        method: "POST",
        headers: { ...who.headers, "Idempotency-Key": uuidv7() },
      });
      expect(ack.status, await ack.clone().text()).toBe(200);
      expect(ack.headers.get("Cache-Control")).toBe("no-store");
      const result = UserNoticeAckResultSchema.parse(
        ((await ack.json()) as { data: unknown }).data,
      );
      expect(result).toEqual({ userNoticeId: source.id, ackedAt: api.clock.now().toISOString() });
      api.clock.advance(1000);
      await api.runtime.tx.run((tx) => subscriber.handle(tx, message));
      const again = await api.request("/api/v1/m/me", { headers: device.headers });
      expect(again.status, await again.clone().text()).toBe(200);
      expect(MeViewSchema.parse(((await again.json()) as { data: unknown }).data).notices).toEqual(
        [],
      );
      expect(
        await db.merchantUserNotice.count({ where: { merchantUserId: who.merchantUserId } }),
      ).toBe(1);
      expect(
        await db.merchantUserNotice.findUniqueOrThrow({ where: { id: source.id } }),
      ).toMatchObject({ ackedAt: new Date(result.ackedAt) });
    });
  },
);
