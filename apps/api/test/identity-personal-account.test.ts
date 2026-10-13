import {
  MeUserSchema,
  UserNoticeAckResultSchema,
  WechatIdentityListSchema,
  WechatIdentityRemoveResultSchema,
} from "@liyoxi/contract";
import { createIdentityContext, uuidv7 } from "@liyoxi/services";
import { createFactories, snapshotTables } from "@liyoxi/services/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { merchantServicesOf } from "../src/merchant/services.js";
import { useTestApi } from "../src/testing/index.js";
import type { TestApi } from "../src/testing/index.js";
import { presetLoginCodes, seedUserAgreements, signInAsMerchant } from "../src/testing/merchant.js";
import type { SignedInMerchant } from "../src/testing/merchant.js";

const handle = useTestApi();
const DAY = 86_400_000;
let api: TestApi;
let db: Awaited<ReturnType<typeof handle.db.prisma>>;
beforeAll(async () => {
  api = await handle.start();
  db = await handle.db.prisma();
  await seedUserAgreements(handle, api);
}, 180_000);
afterEach(() => {
  api.wechat.textVerdicts.length = 0;
  api.wechat.setTextCheckAvailable(true);
});

const identitiesPath = "/m/me/wechat-identities";
const noticePath = (id: string) => `/m/me/user-notices/${id}/acknowledge`;
const identityOf = (user: SignedInMerchant) =>
  db.wechatIdentity.findFirstOrThrow({
    where: { merchantUserId: user.merchantUserId, openid: user.openid },
  });
const noticeFor = (user: SignedInMerchant) =>
  db.merchantUserNotice.create({
    data: {
      id: uuidv7(),
      merchantUserId: user.merchantUserId,
      kind: "new_wechat_bound",
      occurredAt: api.clock.now(),
      createdAt: api.clock.now(),
      updatedAt: api.clock.now(),
    },
  });

function write(
  method: "PATCH" | "POST" | "DELETE",
  path: string,
  user?: SignedInMerchant,
  json?: unknown,
  key: string | null = uuidv7(),
) {
  return api.request(`/api/v1${path}`, {
    method,
    ...(json === undefined ? {} : { json }),
    headers: { ...user?.headers, ...(key === null ? {} : { "Idempotency-Key": key }) },
  });
}
async function dataOf<T>(response: Response, schema: { parse(input: unknown): T }): Promise<T> {
  expect(response.status, await response.clone().text()).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return schema.parse(((await response.json()) as { data: unknown }).data);
}
async function errorOf(response: Response, status: number, error: string) {
  expect(response.status, await response.clone().text()).toBe(status);
  const body = (await response.json()) as { error: string; details?: unknown };
  expect(body.error).toBe(error);
  return body;
}

describe("m.me.update", { timeout: 120_000 }, () => {
  it("无门店头修改本人称呼，trim 后真实检测，同键重放并拒绝换体复用", async () => {
    const user = await signInAsMerchant(api);
    const key = uuidv7();
    const input = { displayName: "  本人新称呼  " };
    const checks = api.wechat.callsOf("checkText").length;
    const first = await dataOf(await write("PATCH", "/m/me", user, input, key), MeUserSchema);
    expect(first).toMatchObject({ merchantUserId: user.merchantUserId, displayName: "本人新称呼" });
    expect(api.wechat.callsOf("checkText").slice(checks)).toMatchObject([
      { input: { openid: user.openid, scene: "profile", content: "本人新称呼" } },
    ]);
    const beforeReplay = await db.merchantUser.findUniqueOrThrow({
      where: { id: user.merchantUserId },
    });
    api.clock.advance(1_000);
    const again = await write("PATCH", "/m/me", user, input, key);
    expect(await dataOf(again, MeUserSchema)).toEqual(first);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await db.merchantUser.findUniqueOrThrow({ where: { id: user.merchantUserId } })).toEqual(
      beforeReplay,
    );
    await errorOf(
      await write("PATCH", "/m/me", user, { displayName: "不同称呼" }, key),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(
      await db.merchantUser.findUniqueOrThrow({ where: { id: user.merchantUserId } }),
    ).toMatchObject({ displayName: "本人新称呼" });
  });

  it("拒绝匿名、缺键、空白、超长、内容命中及检测不可用，均不修改称呼", async () => {
    const user = await signInAsMerchant(api);
    const before = await db.merchantUser.findUniqueOrThrow({ where: { id: user.merchantUserId } });
    await errorOf(
      await write("PATCH", "/m/me", undefined, { displayName: "新称呼" }),
      401,
      "AUTH_REQUIRED",
    );
    await errorOf(
      await write("PATCH", "/m/me", user, { displayName: "新称呼" }, null),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    for (const displayName of ["  ", "称".repeat(21)])
      await errorOf(await write("PATCH", "/m/me", user, { displayName }), 400, "VALIDATION_FAILED");
    const checks = api.wechat.callsOf("checkText").length;
    api.wechat.textVerdicts.push("block");
    const blocked = await errorOf(
      await write("PATCH", "/m/me", user, { displayName: "待检测称呼" }),
      400,
      "CONTENT_REJECTED",
    );
    expect(blocked.details).toEqual({ fields: ["displayName"] });
    api.wechat.setTextCheckAvailable(false);
    const unavailable = await write("PATCH", "/m/me", user, { displayName: "服务未恢复" });
    await errorOf(unavailable, 503, "PROVIDER_UNAVAILABLE");
    expect(unavailable.headers.get("Retry-After")).toBe("1");
    expect(api.wechat.callsOf("checkText")).toHaveLength(checks + 2);
    expect(await db.merchantUser.findUniqueOrThrow({ where: { id: user.merchantUserId } })).toEqual(
      before,
    );
  });
});

describe("m.me.userNotice.acknowledge", { timeout: 120_000 }, () => {
  it("关闭本人提示；同键与另键重复关闭均保留首次时间，me 不再显示", async () => {
    const user = await signInAsMerchant(api);
    const notice = await noticeFor(user);
    const key = uuidv7();
    const first = await dataOf(
      await write("POST", noticePath(notice.id), user, undefined, key),
      UserNoticeAckResultSchema,
    );
    expect(first).toEqual({ userNoticeId: notice.id, ackedAt: api.clock.now().toISOString() });
    api.clock.advance(1_000);
    const again = await write("POST", noticePath(notice.id), user, undefined, key);
    expect(await dataOf(again, UserNoticeAckResultSchema)).toEqual(first);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(
      await dataOf(await write("POST", noticePath(notice.id), user), UserNoticeAckResultSchema),
    ).toEqual(first);
    expect(
      await db.merchantUserNotice.findUniqueOrThrow({ where: { id: notice.id } }),
    ).toMatchObject({ ackedAt: new Date(first.ackedAt) });
    const me = await api.request("/api/v1/m/me", { headers: user.headers });
    expect(me.status).toBe(200);
    expect((await me.json()) as { data: unknown }).toMatchObject({ data: { notices: [] } });
  });

  it("他人及不存在的提示均404，匿名及缺键拒绝且保留原提示", async () => {
    const user = await signInAsMerchant(api);
    const stranger = await signInAsMerchant(api);
    const notice = await noticeFor(stranger);
    for (const id of [notice.id, uuidv7()])
      await errorOf(await write("POST", noticePath(id), user), 404, "NOT_FOUND");
    await errorOf(await write("POST", noticePath(notice.id)), 401, "AUTH_REQUIRED");
    await errorOf(
      await write("POST", noticePath(notice.id), user, undefined, null),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    expect(await db.merchantUserNotice.findUniqueOrThrow({ where: { id: notice.id } })).toEqual(
      notice,
    );
  });
});

describe("m.me.wechatIdentity.list", { timeout: 120_000 }, () => {
  it("当前身份即使最旧也在首页；稳定分页只含本人且不泄露openid/unionid，GET不写库", async () => {
    const user = await signInAsMerchant(api);
    const second = await signInAsMerchant(api, { phone: user.phone });
    const third = await signInAsMerchant(api, { phone: user.phone });
    const stranger = await signInAsMerchant(api);
    const current = await identityOf(user);
    const other = await identityOf(second);
    const newest = await identityOf(third);
    const foreign = await identityOf(stranger);
    await db.userSession.updateMany({
      where: { wechatIdentityId: current.id },
      data: { deviceInfo: "本人设备" },
    });
    await db.wechatIdentity.update({
      where: { id: other.id },
      data: { lastLoginAt: new Date(api.clock.now().getTime() + 1_000) },
    });
    await db.wechatIdentity.update({
      where: { id: newest.id },
      data: { lastLoginAt: new Date(api.clock.now().getTime() + 2_000) },
    });
    const tables = [
      "merchant_user",
      "wechat_identity",
      "user_session",
      "merchant_user_notice",
      "audit_log",
      "auth_event",
    ];
    const before = await snapshotTables(db, tables);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 3; page += 1) {
      const response = await api.request(
        `/api/v1${identitiesPath}?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { headers: user.headers },
      );
      const raw = await response.clone().text();
      expect(raw).not.toMatch(/openid|unionid/);
      expect(raw).not.toContain(foreign.id);
      const data = await dataOf(response, WechatIdentityListSchema);
      expect(data.items).toHaveLength(1);
      if (page === 0)
        expect(data.items[0]).toMatchObject({
          wechatIdentityId: current.id,
          isCurrent: true,
          deviceSummary: "本人设备",
          actions: ["delete"],
        });
      else expect(data.items[0]).toMatchObject({ isCurrent: false, actions: [] });
      seen.push(data.items[0]!.wechatIdentityId);
      expect(data.hasMore).toBe(page < 2);
      cursor = data.nextCursor;
      expect(cursor === null).toBe(page === 2);
    }
    expect(seen).toEqual([current.id, newest.id, other.id]);
    expect(await snapshotTables(db, tables)).toEqual(before);
  });

  it("拒绝匿名、越界limit及空cursor", async () => {
    const user = await signInAsMerchant(api);
    await errorOf(await api.request(`/api/v1${identitiesPath}`), 401, "AUTH_REQUIRED");
    for (const query of ["limit=0", "limit=51", "limit=1.5", "cursor="])
      await errorOf(
        await api.request(`/api/v1${identitiesPath}?${query}`, { headers: user.headers }),
        400,
        "VALIDATION_FAILED",
      );
  });
});

describe("m.me.wechatIdentity.delete", { timeout: 120_000 }, () => {
  it("当前绑定满7天移除其他身份，吊销其全部会话；原键返回成功结果而不是404", async () => {
    const user = await signInAsMerchant(api);
    const target = await signInAsMerchant(api, { phone: user.phone });
    const targetAgain = await signInAsMerchant(api, { phone: user.phone, openid: target.openid });
    const current = await identityOf(user);
    const other = await identityOf(target);
    await db.wechatIdentity.update({
      where: { id: current.id },
      data: { createdAt: new Date(api.clock.now().getTime() - 7 * DAY) },
    });
    const key = uuidv7();
    const path = `${identitiesPath}/${other.id}`;
    const first = await dataOf(
      await write("DELETE", path, user, undefined, key),
      WechatIdentityRemoveResultSchema,
    );
    expect(first).toEqual({
      wechatIdentityId: other.id,
      revokedSessionCount: 2,
      isCurrentSessionRevoked: false,
    });
    const again = await write("DELETE", path, user, undefined, key);
    expect(await dataOf(again, WechatIdentityRemoveResultSchema)).toEqual(first);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await db.wechatIdentity.findUnique({ where: { id: other.id } })).toBeNull();
    const sessions = await db.userSession.findMany({
      where: { merchantUserId: user.merchantUserId, revokeReason: "identity_removed" },
    });
    expect(sessions).toHaveLength(2);
    expect(sessions.every((row) => row.wechatIdentityId === null && row.revokedAt !== null)).toBe(
      true,
    );
    for (const signedIn of [target, targetAgain])
      await errorOf(
        await api.request("/api/v1/m/me", { headers: signedIn.headers }),
        401,
        "SESSION_INVALID",
      );
    expect((await api.request("/api/v1/m/me", { headers: user.headers })).status).toBe(200);
    const silent = await api.request("/api/v1/m/sessions", {
      method: "POST",
      json: { loginCode: presetLoginCodes(api, target).loginCode },
    });
    expect(silent.status).toBe(200);
    expect(await silent.json()).toMatchObject({ data: { needPhone: true } });
  });

  it("新绑定不能移除其他身份，foreign/missing均404，缺键与匿名拒绝", async () => {
    const user = await signInAsMerchant(api);
    const target = await signInAsMerchant(api, { phone: user.phone });
    const stranger = await signInAsMerchant(api);
    const current = await identityOf(user);
    const other = await identityOf(target);
    const foreign = await identityOf(stranger);
    const result = await errorOf(
      await write("DELETE", `${identitiesPath}/${other.id}`, user),
      403,
      "IDENTITY_TOO_NEW",
    );
    expect(result.details).toEqual({
      removableAt: new Date(current.createdAt.getTime() + 7 * DAY).toISOString(),
    });
    for (const id of [foreign.id, uuidv7()])
      await errorOf(await write("DELETE", `${identitiesPath}/${id}`, user), 404, "NOT_FOUND");
    await errorOf(
      await write("DELETE", `${identitiesPath}/${other.id}`, user, undefined, null),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    await errorOf(await write("DELETE", `${identitiesPath}/${other.id}`), 401, "AUTH_REQUIRED");
    expect(await db.wechatIdentity.findUnique({ where: { id: other.id } })).toEqual(other);
    expect((await api.request("/api/v1/m/me", { headers: target.headers })).status).toBe(200);
  });

  it("新绑定当前身份和最后一个身份均可移除；同键重放在鉴权层返回401", async () => {
    for (const withOther of [true, false]) {
      const user = await signInAsMerchant(api);
      if (withOther) await signInAsMerchant(api, { phone: user.phone });
      const current = await identityOf(user);
      const key = uuidv7();
      const path = `${identitiesPath}/${current.id}`;
      expect(
        await dataOf(
          await write("DELETE", path, user, undefined, key),
          WechatIdentityRemoveResultSchema,
        ),
      ).toEqual({
        wechatIdentityId: current.id,
        revokedSessionCount: 1,
        isCurrentSessionRevoked: true,
      });
      await errorOf(await write("DELETE", path, user, undefined, key), 401, "SESSION_INVALID");
      expect(
        await db.wechatIdentity.count({ where: { merchantUserId: user.merchantUserId } }),
      ).toBe(withOther ? 1 : 0);
      expect(
        await db.merchantUser.findUniqueOrThrow({ where: { id: user.merchantUserId } }),
      ).toMatchObject({ status: "active" });
    }
  });
});

describe(
  "m.me.update / m.me.userNotice.acknowledge / m.me.wechatIdentity.list / m.me.wechatIdentity.delete clerk",
  { timeout: 120_000 },
  () => {
    it("店员四接口无需门店头且只处理本人，不能关闭或移除老板记录", async () => {
      const owner = await signInAsMerchant(api);
      const created = await merchantServicesOf(api.runtime).tenant.createEntity(
        createIdentityContext({
          actor: { type: "merchant", id: owner.merchantUserId, client: "weapp" },
        }),
      );
      const clerk = await signInAsMerchant(api);
      const make = createFactories({ db, clock: api.clock });
      const member = await make.entityMember({
        entityId: created.entityId,
        merchantUserId: clerk.merchantUserId,
      });
      await make.storeMember({
        entityMemberId: member.id,
        storeId: created.storeId,
        addedByMemberId: created.memberId,
      });
      const ownerBefore = await db.merchantUser.findUniqueOrThrow({
        where: { id: owner.merchantUserId },
      });
      expect(
        await dataOf(
          await write("PATCH", "/m/me", clerk, { displayName: "店员本人" }),
          MeUserSchema,
        ),
      ).toMatchObject({ merchantUserId: clerk.merchantUserId, displayName: "店员本人" });
      expect(
        await db.merchantUser.findUniqueOrThrow({ where: { id: owner.merchantUserId } }),
      ).toEqual(ownerBefore);
      const ownNotice = await noticeFor(clerk);
      const foreignNotice = await noticeFor(owner);
      expect(
        await dataOf(
          await write("POST", noticePath(ownNotice.id), clerk),
          UserNoticeAckResultSchema,
        ),
      ).toMatchObject({ userNoticeId: ownNotice.id });
      await errorOf(await write("POST", noticePath(foreignNotice.id), clerk), 404, "NOT_FOUND");
      const current = await identityOf(clerk);
      const foreign = await identityOf(owner);
      const list = await dataOf(
        await api.request(`/api/v1${identitiesPath}`, { headers: clerk.headers }),
        WechatIdentityListSchema,
      );
      expect(list.items.map((item) => item.wechatIdentityId)).toEqual([current.id]);
      await errorOf(
        await write("DELETE", `${identitiesPath}/${foreign.id}`, clerk),
        404,
        "NOT_FOUND",
      );
      expect(
        await dataOf(
          await write("DELETE", `${identitiesPath}/${current.id}`, clerk),
          WechatIdentityRemoveResultSchema,
        ),
      ).toMatchObject({ wechatIdentityId: current.id, isCurrentSessionRevoked: true });
      expect((await api.request("/api/v1/m/me", { headers: owner.headers })).status).toBe(200);
    });
  },
);
